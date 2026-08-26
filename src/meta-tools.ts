import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  ActivityCallSource,
  ActivityRequestContext,
} from "./activity.js";
import {
  boundedDiscoveryText,
  CatalogService,
  DEFAULT_SEARCH_LIMIT,
  DiscoveryPolicyError,
  groupedSearchResult,
  MAX_DESCRIBE_ADDRESSES,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_SEARCH_LIMIT,
} from "./catalog-service.js";
import type { DeferredWork } from "./connector-scope.js";
import { resolveDiscoveryConcurrency } from "./concurrency.js";
import { msg, type CallErrorDetails } from "./errors.js";
import { serializeResultText } from "./executor-result.js";
import {
  InvocationService,
  MAX_RETRY_BACKOFF_MS,
  retryBackoffMs,
  type InvocationTiming,
} from "./invocation.js";
import {
  isValidMaxResultBytes,
  MIN_MAX_RESULT_BYTES,
  resolveMaxResultBytes,
  type RegistryView,
} from "./registry.js";
import {
  hasConnectorGuides,
  listSkills,
  resolveSkill,
} from "./skills.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeTimeoutMs,
} from "./timeout.js";
import type { KVStorage } from "./types.js";

export {
  MAX_DESCRIBE_ADDRESSES,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_RETRY_BACKOFF_MS,
  MAX_SEARCH_LIMIT,
  retryBackoffMs,
};

interface TextContent {
  type: "text";
  text: string;
}
export interface ToolResult {
  // See documentation/meta-tools.md#result-representation for why both forms
  // travel together and when text may differ from structuredContent.
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [x: string]: unknown;
}

const RESULT_TTL_SECONDS = 900;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function jsonResult(obj: unknown, text = JSON.stringify(obj)): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? { structuredContent: obj as Record<string, unknown> }
      : {}),
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function discoveryErrorResult(error: DiscoveryPolicyError): ToolResult {
  const result = jsonResult({
    error: {
      code: error.code,
      message: error.message,
      retryable: false,
    },
  });
  result.isError = true;
  return result;
}

async function discoveryResult(
  operation: () => unknown | Promise<unknown>,
  hint: string,
): Promise<ToolResult> {
  try {
    const value = await operation();
    const text = boundedDiscoveryText(value, hint);
    return jsonResult(value, text);
  } catch (err) {
    if (err instanceof DiscoveryPolicyError) {
      return discoveryErrorResult(err);
    }
    throw err;
  }
}

/** True if `b` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuationByte(b: number | undefined): boolean {
  return b !== undefined && (b & 0xc0) === 0x80;
}

/** Smallest accepted `get_result` byte offset. */
const MIN_RESULT_OFFSET = 0;

/** Whole-byte offset accepted by the result representation documented in
 * documentation/meta-tools.md#result-representation. */
function isValidResultOffset(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_RESULT_OFFSET;
}

/**
 * Move a byte `offset` back to the nearest UTF-8 codepoint boundary in
 * `[0, offset]`, so decoding from it never starts mid-character (which emits
 * U+FFFD for the severed tail).
 *
 * Backwards, never forwards: re-serving a few bytes the caller already has is
 * recoverable, silently skipping the rest of a character is not. Offsets the
 * server itself produced (`nextOffset`) are already boundaries and come back
 * unchanged, so this only moves an offset a client computed on its own
 * (issue #38). An offset at or past `bytes.length` is left alone — there is no
 * character there to split.
 */
export function alignStartToCharBoundary(
  bytes: Uint8Array,
  offset: number,
): number {
  let o = offset;
  while (o > 0 && isContinuationByte(bytes[o])) o--;
  return o;
}

/** End boundary for UTF-8-safe, forward-progressing result pages. See
 * documentation/meta-tools.md#result-representation. */
export function alignEndToCharBoundary(
  bytes: Uint8Array,
  offset: number,
  end: number,
  total: number,
): number {
  if (end >= total) return total;
  // A window that reaches no further than `offset` yields no bytes and no
  // progress; widen it to one byte and let the codepoint walk below finish it.
  const wanted = Math.max(end, offset + 1);
  let e = wanted;
  while (e > offset && isContinuationByte(bytes[e])) e--;
  if (e === offset) {
    // Window is narrower than the codepoint at `offset`; take the whole thing.
    e = wanted;
    while (e < total && isContinuationByte(bytes[e])) e++;
  }
  return e;
}

// --- result-size guard + get_result (feature 1) ---------------------------

/**
 * The one serialization every result guard measures, stashes, and pages: JSON
 * text for whatever JSON can represent, and `String(value)` for the returns
 * JSON renders as `undefined` — a handler that returns nothing, a function, or
 * a Symbol. `JSON.stringify` is *typed* as returning `string` while actually
 * returning `undefined` for those, which is how a handler returning `undefined`
 * reached clients as a `{"type":"text"}` block carrying no `text` at all: the
 * size guard measured `enc.encode(undefined)` — the empty string, per the
 * WebIDL default — and emitted the non-string unchanged (issue #42). `null`
 * needs no special case; JSON renders it as `"null"`.
 *
 * Shared by `guardText`, `guardValue`, and execute_code's `guardResultValue` so
 * the three give one answer to the same question. A value JSON cannot serialize
 * at all (a BigInt) still throws, as before, and is reported as a failure.
 */
/**
 * Stash `text` under `result:<uuid>` (ttl 900s) and describe it as the
 * truncation notice every over-cap path hands back.
 */
async function stashResult(
  text: string,
  results: KVStorage,
  totalBytes: number,
): Promise<{
  truncated: true;
  resultId: string;
  totalBytes: number;
  hint: string;
  nextAction: {
    tool: "get_result";
    arguments: { id: string; offset: 0 };
  };
}> {
  const id = crypto.randomUUID();
  await results.set(`result:${id}`, text, { ttlSeconds: RESULT_TTL_SECONDS });
  return {
    truncated: true,
    resultId: id,
    totalBytes,
    hint: "use get_result {id, offset} to page the complete direct-call result",
    nextAction: {
      tool: "get_result",
      arguments: { id, offset: 0 },
    },
  };
}

interface GuardedResult<T> {
  result: T;
  truncated: boolean;
}

/**
 * Return `text` as a single content block; if it exceeds `cap` bytes, stash the
 * full text and return the first `cap` bytes followed by a JSON truncation
 * notice pointing at get_result. `bytes` is `text` already encoded, so a caller
 * that had to measure it to make this decision doesn't encode it twice.
 */
async function guardEncoded(
  text: string,
  bytes: Uint8Array,
  results: KVStorage,
  cap: number,
): Promise<GuardedResult<ToolResult>> {
  if (bytes.length <= cap) {
    return {
      result: { content: [{ type: "text", text }] },
      truncated: false,
    };
  }
  const notice = await stashResult(text, results, bytes.length);
  const head = dec.decode(
    bytes.slice(0, alignEndToCharBoundary(bytes, 0, cap, bytes.length)),
  );
  return {
    result: {
      content: [{ type: "text", text: `${head}\n${JSON.stringify(notice)}` }],
    },
    truncated: true,
  };
}

/** {@link guardEncoded} over a string that has not been measured yet. */
async function guardText(
  text: string,
  results: KVStorage,
  cap: number,
): Promise<GuardedResult<ToolResult>> {
  // `JSON.stringify`'s type says `string` where its behavior says `string |
  // undefined`, so TypeScript alone does not keep a non-string out of here.
  // Normalizing at the door means the size check below always measures exactly
  // the text that is emitted, and no future caller can launder a non-string
  // through it the way issue #42 describes.
  const body: string =
    typeof text === "string" ? text : serializeResultText(text);
  return guardEncoded(body, enc.encode(body), results, cap);
}

/** Store an oversized JSON value and replace it with a page handle. */
async function guardValue(
  value: unknown,
  results: KVStorage,
  cap: number,
): Promise<GuardedResult<unknown>> {
  const text = serializeResultText(value);
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return { result: value, truncated: false };
  return {
    result: await stashResult(text, results, bytes.length),
    truncated: true,
  };
}

/**
 * Bound a downstream MCP `content` array by `cap`, measuring the serialized
 * envelope — the same string that gets stashed and paged, and the one that
 * counts every block rather than only the text ones.
 *
 * Both halves matter (issue #43). Measuring only text blocks meant an oversized
 * all-image result scored zero bytes and was returned inline unbounded, with no
 * `resultId` to page from; and measuring one string while truncating another
 * left `totalBytes` and the served head describing something the cap was never
 * compared against.
 *
 * Over the cap, what a client gets depends on whether a prefix is usable. An
 * all-text envelope keeps the historical head + notice — a JSON prefix is still
 * readable. An envelope carrying non-text blocks is replaced by the notice
 * alone: the head of a half-written base64 image is of no use to anyone, and
 * cutting one leaves unparseable block structure behind. Either way the full
 * envelope is stashed and pages through `get_result`.
 */
async function guardContent(
  content: TextContent[],
  results: KVStorage,
  cap: number,
): Promise<GuardedResult<ToolResult>> {
  let text: string;
  try {
    text = JSON.stringify(content);
  } catch {
    // A block carrying a BigInt or a cycle cannot be serialized, so it cannot
    // be measured, stashed, or paged either — there is nothing this guard could
    // do with it. Pass it through as the old text-only measure did, rather than
    // turning a call that used to succeed into result_processing_failed.
    return { result: { content }, truncated: false };
  }
  const bytes = enc.encode(text);
  // Under the cap the downstream blocks pass through untouched, non-text ones
  // included, in their original order.
  if (bytes.length <= cap) {
    return { result: { content }, truncated: false };
  }
  if (content.every((b) => b.type === "text")) {
    return guardEncoded(text, bytes, results, cap);
  }
  const notice = await stashResult(text, results, bytes.length);
  return {
    result: { content: [{ type: "text", text: JSON.stringify(notice) }] },
    truncated: true,
  };
}

// --- compact schema rendering (feature 3a) --------------------------------

// --- argument shapes -------------------------------------------------------

export interface SearchArgs {
  query?: string;
  connector?: string;
  safety?: "readOnly" | "approvalRequired" | "all";
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: "compact" | "json";
}
type ResultMode = "mcp" | "value";
export interface CallArgs {
  address: string;
  args?: Record<string, unknown>;
  resultMode?: ResultMode;
  timeoutMs?: number;
  /** Retries after the first attempt; honored only for safely annotated tools. */
  maxRetries?: number;
  /** Include connector/catalog/result-processing timing segments. */
  diagnostics?: boolean;
}
export interface DestructiveCallArgs extends CallArgs {
  /** Short model-authored context for the host's approval UI; never downstream input. */
  reason?: string;
}
export interface GetResultArgs {
  id: string;
  /**
   * Byte offset to page from; a whole number >= 0, aligned back to the nearest
   * character boundary and reported as the response's `offset`. Defaults to 0.
   */
  offset?: number;
  /** Page size in bytes; a whole number >= 1. Defaults to the deployment cap. */
  maxBytes?: number;
}
export interface AuthorizeArgs {
  connector: string;
  force?: boolean;
}
export interface SkillArgs {
  name?: string;
}

/**
 * The sentence that closes the OAuth handoff, telling the operator's agent how
 * to confirm the flow landed through the one surface it can call.
 */
function oauthFollowUp(connectorId: string): string {
  return `Then retry the original call; connecta.search({ connector: ${JSON.stringify(connectorId)} }) inside execute_code confirms the catalog now loads.`;
}

/**
 * Every meta-tool handler over a registry, one per registered tool. Exported for
 * direct testing; registerMetaTools() wires the six explicit tools onto an
 * McpServer. `opts.defaultToolTimeoutMs` supplies a deadline for calls that
 * don't carry one. (execute_code is registered separately by
 * registerExecuteTool, and builds its own services over the same registry.)
 *
 * What execute_code shares with these handlers is the services layer beneath
 * them — `CatalogService` and `InvocationService` — not the handlers, which no
 * in-program path calls.
 *
 * Deployment-wide result-size caps are read off the registry view rather than
 * passed in: `ConnectaConfig.calls.maxResultBytes` and its per-connector
 * override each have one runtime source of truth.
 */
export function createMetaTools(
  registry: RegistryView,
  baseUrl: string,
  opts: {
    /** Deadline applied when a call passes no `timeoutMs`. Off when unset. */
    defaultToolTimeoutMs?: number | undefined;
    /** Per-connector deadline for the search/describe probe fan-out. Default 30_000. */
    probeTimeoutMs?: number | undefined;
    /** Maximum simultaneous connector discovery operations. Default 4. */
    discoveryConcurrency?: number | undefined;
    activity?: ActivityRequestContext | undefined;
    /** Inbound request cancellation shared by every call this request makes. */
    requestSignal?: AbortSignal | undefined;
    /** Runtime-owned tail for stale catalog refreshes. */
    defer?: DeferredWork | undefined;
  } = {},
) {
  // Already normalized and warned about at registry construction.
  const globalCap = registry.maxResultBytes;
  const defaultToolTimeoutMs = normalizeTimeoutMs(opts.defaultToolTimeoutMs);
  const probeTimeoutMs =
    normalizeTimeoutMs(opts.probeTimeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
  const discoveryConcurrency = resolveDiscoveryConcurrency(
    opts.discoveryConcurrency,
  );
  // createMetaTools() is called once per inbound MCP request. Sharing this
  // identity lets remote connectors reuse one downstream client inside that
  // request without leaking request-bound I/O into the next one.
  const requestScope = {};
  const catalog = new CatalogService(registry, baseUrl, {
    requestScope,
    probeTimeoutMs,
    concurrency: discoveryConcurrency,
    defer: opts.defer,
    // searchRoute keeps its top-level default. In-program callers use a
    // separate CatalogService configured for connecta.search.
  });
  const invocation = new InvocationService(registry, catalog, opts.activity);

  interface RunCallOutcome {
    toolResult: ToolResult;
    durationMs: number;
    attempts: number;
    timing: InvocationTiming;
    value?: unknown;
    error?: CallErrorDetails;
  }

  interface ProcessedCallResult {
    toolResult: ToolResult;
    value?: unknown;
    /**
     * Friction on a call that *succeeded*. It travels as a friction class, not
     * as an `errorCode`, so persistence keyed on "this row has an error code"
     * keeps counting failures rather than truncations.
     */
    friction?: "result_too_large";
  }

  /** MCP adapter: shared invocation semantics plus MCP-only result shaping. */
  async function runCall(
    call: CallArgs,
    source: ActivityCallSource,
    options: { allowDestructive?: boolean } = {},
  ): Promise<RunCallOutcome> {
    const results = registry.resultsStorage();
    const timeoutMs = normalizeTimeoutMs(call.timeoutMs) ?? defaultToolTimeoutMs;
    const outcome = await invocation.invoke<ProcessedCallResult>(
      call.address,
      call.args ?? {},
      {
        source,
        ...(options.allowDestructive !== undefined
          ? { allowDestructive: options.allowDestructive }
          : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(call.maxRetries !== undefined
          ? { maxRetries: call.maxRetries }
          : {}),
        ...(opts.requestSignal !== undefined
          ? { requestSignal: opts.requestSignal }
          : {}),
        unwrapResult: call.resultMode === "value",
        processResult: async (result, resolved) => {
          // Result-size cap for THIS call: the connector's own override wins,
          // then the deployment-wide value, then the built-in default (already
          // folded into `globalCap`). Resolved per call so one request can
          // mix a tight-capped connector with siblings on the global cap. An
          // override the registry already warned about at startup is dropped
          // here, so the connector simply inherits `globalCap`.
          const cap = resolveMaxResultBytes(
            resolved.connector.maxResultBytes,
            globalCap,
          );
          const processed = (
            toolResult: ToolResult,
            truncated: boolean,
            value?: { value: unknown },
          ): ProcessedCallResult => ({
            toolResult,
            ...value,
            ...(truncated ? { friction: "result_too_large" } : {}),
          });
          if (call.resultMode === "value") {
            let value = result;
            const guarded = await guardValue(value, results, cap);
            value = guarded.result;
            return processed(
              jsonResult({ ok: true, data: value }),
              guarded.truncated,
              { value },
            );
          }
          if (resolved.connector.kind === "mcp") {
            const mcpResult = result as { content?: TextContent[] };
            const content = mcpResult?.content ?? [];
            const guarded = await guardContent(content, results, cap);
            return processed(guarded.result, guarded.truncated);
          }
          const value = result;
          const guarded = await guardText(
            serializeResultText(value),
            results,
            cap,
          );
          return processed(guarded.result, guarded.truncated, { value });
        },
        activityFriction: (processed) => processed.friction,
      },
    );
    if (!outcome.ok) {
      const structuredRecovery = outcome.error.nextAction !== undefined;
      const recoveryRequired =
        structuredRecovery ||
        [
          "auth_required",
          "invalid_args",
          "input_required_unsupported",
        ].includes(outcome.error.code);
      const failedResult =
        recoveryRequired ||
        call.resultMode === "value"
          ? jsonResult({
              ok: false,
              error: outcome.error,
              durationMs: outcome.durationMs,
              attempts: outcome.attempts,
              ...(call.diagnostics ? { timing: outcome.timing } : {}),
            })
          : errorResult(outcome.error.message);
      if (recoveryRequired) {
        failedResult.isError = true;
      }
      return {
        toolResult: failedResult,
        durationMs: outcome.durationMs,
        attempts: outcome.attempts,
        timing: outcome.timing,
        error: outcome.error,
      };
    }
    const valueModeResult =
      call.resultMode === "value"
        ? jsonResult({
            ok: true,
            data: outcome.value.value,
            durationMs: outcome.durationMs,
            attempts: outcome.attempts,
            ...(call.diagnostics ? { timing: outcome.timing } : {}),
          })
        : outcome.value.toolResult;
    return {
      toolResult: valueModeResult,
      durationMs: outcome.durationMs,
      attempts: outcome.attempts,
      timing: outcome.timing,
      ...(Object.prototype.hasOwnProperty.call(outcome.value, "value")
        ? { value: outcome.value.value }
        : {}),
    };
  }

  return {
    async skills(args: SkillArgs = {}): Promise<ToolResult> {
      const connectors = registry.listConnectors();
      if (!args.name) {
        return {
          content: [
            {
              type: "text",
              text:
                'Available skills. Fetch one with skills({ name: "<name>" }).\n\n' +
                listSkills(connectors)
                  .map((skill) => `- \`${skill.name}\` — ${skill.description}`)
                  .join("\n"),
            },
          ],
        };
      }
      const skill = resolveSkill(args.name, connectors);
      if (!skill.found) return errorResult(skill.message);
      return { content: [{ type: "text", text: skill.content }] };
    },

    async searchTools(args: SearchArgs): Promise<ToolResult> {
      return discoveryResult(
        async () =>
          groupedSearchResult(
            await catalog.search({
              ...args,
              includeSchemaKeys: args.includeSchemas !== undefined,
            }),
          ),
        "Request a smaller limit, omit fullDescriptions, or use compact schemas.",
      );
    },

    async callTool(args: CallArgs): Promise<ToolResult> {
      return (await runCall(args, "call_tool")).toolResult;
    },

    async callDestructiveTool(args: DestructiveCallArgs): Promise<ToolResult> {
      // `reason` is read by the host's approval view and stops there — runCall
      // forwards only the call arguments, so it never reaches the connector.
      return (
        await runCall(args, "call_destructive_tool", { allowDestructive: true })
      ).toolResult;
    },

    async getResult(args: GetResultArgs): Promise<ToolResult> {
      // Client-supplied page size and offset: normal input-validation errors,
      // not clamps. Callers arriving over MCP are rejected earlier by the
      // registered zod schema and never reach these branches, so they exist for
      // in-process callers of createMetaTools — which have no schema in front
      // of them — and to keep the rules true of the handler on its own terms.
      if (
        args.maxBytes !== undefined &&
        !isValidMaxResultBytes(args.maxBytes)
      ) {
        return errorResult(
          `Invalid maxBytes ${args.maxBytes}: must be a whole number of bytes ` +
            `>= ${MIN_MAX_RESULT_BYTES}. Omit it to use the deployment default.`,
        );
      }
      if (args.offset !== undefined && !isValidResultOffset(args.offset)) {
        return errorResult(
          `Invalid offset ${args.offset}: must be a whole number of bytes ` +
            `>= ${MIN_RESULT_OFFSET}. Omit it to start at the beginning.`,
        );
      }
      const results = registry.resultsStorage();
      const stored = await results.get(`result:${args.id}`);
      if (stored === null || stored === undefined) {
        return errorResult(`Unknown or expired result id "${args.id}"`);
      }
      const bytes = enc.encode(stored);
      const total = bytes.length;
      // Validated above, so no coercion is needed here — only alignment. A
      // client that computes its own offsets can land inside a multi-byte
      // character, which would decode as U+FFFD; the offset actually served is
      // the boundary at or before it, and it is what the response reports back
      // as `offset` (issue #38).
      const offset = alignStartToCharBoundary(bytes, args.offset ?? 0);
      // Page size only: a stashed result carries no connector identity, so
      // get_result keeps the deployment-wide default when none is requested.
      // Both sides are validated by now — the argument above, `globalCap` at
      // intake — so `offset + maxBytes` always reaches past `offset`.
      const maxBytes = args.maxBytes ?? globalCap;
      // Align the slice end to a codepoint boundary so a multi-byte char is
      // never split across pages (which would emit U+FFFD on both sides).
      // `nextOffset` is this aligned end, so it is a valid boundary for the
      // next call and paging reassembles the original byte-for-byte.
      const end = alignEndToCharBoundary(
        bytes,
        offset,
        offset + maxBytes,
        total,
      );
      const slice = dec.decode(bytes.slice(offset, end));
      const nextOffset = end < total ? end : undefined;
      return jsonResult({
        offset,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
        totalBytes: total,
        text: slice,
      });
    },

    async authorizeConnector(args: AuthorizeArgs): Promise<ToolResult> {
      const connector = registry.getConnector(args.connector);
      if (!connector) {
        return errorResult(`Unknown connector "${args.connector}"`);
      }
      if (!connector.startAuth) {
        if (!connector.credential) {
          return jsonResult({
            connector: connector.id,
            recovery: "unavailable",
            message:
              `Connector "${connector.id}" declares neither downstream OAuth ` +
              "nor an operator-managed credential slot. Update the connector " +
              "or deployment configuration before retrying.",
          });
        }
        const ctx = registry.contextFor(
          connector.id,
          baseUrl,
          requestScope,
        );
        if (!ctx.credential) {
          return jsonResult({
            connector: connector.id,
            recovery: "unavailable",
            message:
              "Credential storage is not configured. Configure " +
              "credentials.encryptionKey, redeploy, then call " +
              "authorize_connector again.",
          });
        }
        const fields = connector.credential.fields?.map((field) => ({
          name: field.name,
          guidance: field.description ?? field.label,
        })) ?? [
          {
            name: "value",
            guidance:
              connector.credential.description ??
              connector.credential.label,
          },
        ];
        return jsonResult({
          connector: connector.id,
          recovery: "operator_config",
          credential: {
            label: connector.credential.label,
            fields,
          },
          operatorUrl: new URL("/credentials", baseUrl).toString(),
          instructions:
            "Have the operator open operatorUrl, set and test the credential, " +
            "then retry the original call. No redeploy is needed. Credential " +
            "mutation requires a Clerk-authenticated operator.",
        });
      }
      const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
      try {
        const status = await connector.startAuth(
          ctx,
          args.force !== undefined ? { force: args.force } : {},
        );
        if (status.state === "auth_required" && !status.authorizationUrl) {
          // auth_required with nothing to open is a dead end for the operator.
          return errorResult(
            `Connector "${connector.id}": authorization required but no URL is available — retry authorize_connector.`,
          );
        }
        return jsonResult({
          connector: connector.id,
          recovery: "oauth",
          status: status.state,
          ...(status.authorizationUrl
            ? {
                authorizationUrl: status.authorizationUrl,
                instructions:
                  "Have the operator open authorizationUrl in a browser and complete the consent flow. The provider then redirects back to this server's /oauth/callback/<connector> route, which finishes the flow automatically. " +
                  oauthFollowUp(connector.id),
              }
            : {}),
          ...(status.message ? { message: status.message } : {}),
        });
      } catch (err) {
        return errorResult(msg(err));
      } finally {
        // Auth state may have changed — even on a throw or a half-wiped force —
        // so don't serve a stale tool list.
        await registry.invalidateStored(connector.id);
      }
    },
  };
}

const SEARCH_DESC = `Use top-level search for one unknown-address read before call_tool, or for approval-required work before call_destructive_tool. Use 2–4 action/object terms and includeSchemas="compact"; the default limit is ${DEFAULT_SEARCH_LIMIT}. Set connector when known. safety="readOnly" finds direct or program calls; "approvalRequired" finds the fail-closed complement. These filters grant no authority. For multiple, dependent, or reduced read-only calls, use one execute_code program instead. Empty query browses.`;
const CALL_DESC =
  'Call one tool explicitly annotated readOnlyHint: true. Use execute_code for multiple, dependent, or reduced read-only calls. Unannotated or write-capable tools fail closed to call_destructive_tool. A truncated result carries a get_result action.';
const CALL_DESTRUCTIVE_DESC =
  "Call any tool not explicitly annotated readOnlyHint: true. Include a short reason for the human reviewer after checking the schema and consequences. The reason grants no authority and is not sent downstream.";
const GET_RESULT_DESC =
  "Page a truncated direct-call result by id and byte offset. A program result is never paged; reduce it inside execute_code. Returns text, offset, nextOffset when more remains, and totalBytes.";
const AUTHORIZE_DESC =
  "Use after auth_required. Returns an OAuth or operator-credential handoff, or reports required deployment configuration. force=true restarts OAuth only; this tool never accepts credentials.";
const SKILLS_DESC =
  'List or fetch on-demand guidance. Fetch usage once per task for program syntax, selection, repair, examples, and runtime details.';

/**
 * Sentences appended to a meta-tool description only when this connection
 * actually has connector guides. Tool descriptions are always-loaded context,
 * so a deployment with no guides gets every base description unchanged rather
 * than paying for text about a feature it does not use.
 *
 * Registration is per connection and reads the configured connector set.
 */
const GUIDE_NOTES = {
  skills:
    " Also lists this deployment's connector guides by exact name.",
  search:
    " A result with guideRequired: true requires its exact named connector guide before the call.",
  destructive:
    " Fetch any exact connector guide named by discovery before the call.",
} as const;

/** `base`, plus its guide note when any VISIBLE connector carries a guide. */
function describedFor(
  registry: RegistryView,
  base: string,
  note: keyof typeof GUIDE_NOTES,
): string {
  return hasConnectorGuides(registry.listConnectors())
    ? base + GUIDE_NOTES[note]
    : base;
}

/**
 * Connecta refuses downstream tools that are not explicitly annotated
 * read-only, so its own meta-tools must carry the same hints — otherwise a
 * host that gates on annotations prompts for every search, and a connecta
 * aggregated behind another connecta would be refused by its own policy.
 */
const READ_ONLY_REMOTE = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

/** Read-only and served entirely from connecta's own storage. */
const READ_ONLY_LOCAL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CALL_INPUT_SCHEMA = {
  address: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  resultMode: z.enum(["mcp", "value"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(2).optional(),
  diagnostics: z.boolean().optional(),
};

/**
 * Register the six explicit meta-tools onto an McpServer instance.
 * `registerExecuteTool` adds the seventh, `execute_code`. Broad discovery and
 * multi-call work is reached through `connecta.search` / `connecta.describe` /
 * `connecta.batch` inside a program, which `execute_code` builds over the same
 * `CatalogService` and `InvocationService` these handlers use — one shared
 * services layer, two adapters above it.
 */
export function registerMetaTools(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    defaultToolTimeoutMs?: number | undefined;
    probeTimeoutMs?: number | undefined;
    discoveryConcurrency?: number | undefined;
    activity?: ActivityRequestContext | undefined;
    requestSignal?: AbortSignal | undefined;
    defer?: DeferredWork | undefined;
  },
): void {
  const mt = createMetaTools(registry, ctx.baseUrl, {
    defaultToolTimeoutMs: ctx.defaultToolTimeoutMs,
    probeTimeoutMs: ctx.probeTimeoutMs,
    discoveryConcurrency: ctx.discoveryConcurrency,
    activity: ctx.activity,
    requestSignal: ctx.requestSignal,
    defer: ctx.defer,
  });

  server.registerTool(
    "skills",
    {
      description: describedFor(registry, SKILLS_DESC, "skills"),
      inputSchema: z.object({ name: z.string().optional() }),
      annotations: READ_ONLY_LOCAL,
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => mt.skills(args as SkillArgs),
  );

  server.registerTool(
    "search_tools",
    {
      description: describedFor(
        registry,
        SEARCH_DESC,
        "search",
      ),
      inputSchema: z.object({
        query: z.string().optional(),
        connector: z.string().optional(),
        safety: z
          .enum(["readOnly", "approvalRequired", "all"])
          .optional(),
        limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
        offset: z.number().int().nonnegative().optional(),
        fullDescriptions: z.boolean().optional(),
        includeSchemas: z.enum(["compact", "json"]).optional(),
      }),
      annotations: READ_ONLY_REMOTE,
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => mt.searchTools(args as SearchArgs),
  );

  server.registerTool(
    "call_tool",
    {
      description: CALL_DESC,
      inputSchema: z.object(CALL_INPUT_SCHEMA),
      // call_tool admits only tools that are themselves explicitly read-only;
      // anything else is refused and routed to call_destructive_tool.
      annotations: READ_ONLY_REMOTE,
      // Omission defaults to model + app. Display-only views may call no tool.
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => mt.callTool(args as CallArgs),
  );

  server.registerTool(
    "call_destructive_tool",
    {
      description: describedFor(
        registry,
        CALL_DESTRUCTIVE_DESC,
        "destructive",
      ),
      inputSchema: z.object({
        ...CALL_INPUT_SCHEMA,
        // Bounded above, but with no lower bound: a model that sends `""` or
        // whitespace has written no reason, and failing an entire consequential
        // call over a cosmetic field the host merely displays is the wrong
        // trade. It is normalized to absent below instead.
        reason: z.string().max(500).optional(),
      }),
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => {
      // `reason` is the host's to display and connecta's to keep out of the
      // downstream call, so this destructuring is the whole of its handling:
      // nothing below reads it. Dropping it is also what makes an empty or
      // whitespace-only one "absent" rather than a validation failure — there
      // is no field left for it to be absent from.
      const { reason: _hostContext, ...call } = args as DestructiveCallArgs;
      return mt.callDestructiveTool(call);
    },
  );

  server.registerTool(
    "authorize_connector",
    {
      description: AUTHORIZE_DESC,
      inputSchema: z.object({
        connector: z.string(),
        force: z.boolean().optional(),
      }),
      // Starts (or with force, resets) a downstream OAuth flow — it changes
      // stored connector auth state, so it is deliberately not read-only.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => mt.authorizeConnector(args as AuthorizeArgs),
  );

  server.registerTool(
    "get_result",
    {
      description: GET_RESULT_DESC,
      inputSchema: z.object({
        id: z.string(),
        // Both bounds are the shared rules (isValidResultOffset,
        // isValidMaxResultBytes) expressed for the wire: spelling them against
        // the same constants keeps the schema from drifting away from the
        // in-handler checks if either floor ever moves.
        offset: z.number().int().min(MIN_RESULT_OFFSET).optional(),
        maxBytes: z.number().int().min(MIN_MAX_RESULT_BYTES).optional(),
      }),
      annotations: READ_ONLY_LOCAL,
      _meta: { ui: { visibility: ["model"] } },
    },
    async (args) => mt.getResult(args as GetResultArgs),
  );
}
