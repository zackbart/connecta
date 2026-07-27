import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactSchema, rankTools, summarizeDescription } from "./catalog.js";
import {
  recordToolActivity,
  type ActivityCallSource,
  type ActivityRequestContext,
} from "./activity.js";
import { closeConnectorScope } from "./connector-scope.js";
import { unwrapMcpResult } from "./mcp-result.js";
import {
  classifyCallError,
  ConnectorCallError,
  messageLooksRetryable,
  type CallErrorDetails,
} from "./errors.js";
import {
  isValidMaxResultBytes,
  MIN_MAX_RESULT_BYTES,
  resolveMaxResultBytes,
  type RegistryView,
} from "./registry.js";
import {
  connectorGuide,
  connectorSkillName,
  hasConnectorGuides,
  listSkills,
  resolveSkill,
} from "./skills.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  normalizeTimeoutMs,
  withAbortableTimeout,
} from "./timeout.js";
import { credentialVerdictApplies } from "./credential-health.js";
import type { ConnectorStatus, KVStorage, ToolDef } from "./types.js";

interface TextContent {
  type: "text";
  text: string;
}
export interface ToolResult {
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [x: string]: unknown;
}

const RESULT_TTL_SECONDS = 900;

export function jsonResult(obj: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
    ...(obj !== null && typeof obj === "object" && !Array.isArray(obj)
      ? { structuredContent: obj as Record<string, unknown> }
      : {}),
  };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const DEFAULT_SEARCH_LIMIT = 25;
/**
 * A discovery page is for choosing the next tool, not exporting the catalog.
 * One hundred leaves room for broad browsing while keeping each deliberate
 * page far below the catalog sizes Connecta supports.
 */
export const MAX_SEARCH_LIMIT = 100;
/** Same one-request work bound for address-based discovery. */
export const MAX_DESCRIBE_ADDRESSES = 100;
/**
 * Final UTF-8 ceiling for a generated search/describe response. The count
 * limits are the ordinary guard; this catches unusually large full schemas or
 * descriptions that make even a bounded page expensive.
 */
export const MAX_DISCOVERY_RESULT_BYTES = 256_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

type ErrorDetails = CallErrorDetails;

export class DiscoveryPolicyError extends Error {
  constructor(
    readonly code: "invalid_args" | "result_too_large",
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryPolicyError";
  }
}

/** Validate before ranking so a huge page request does no proportional work. */
export function discoverySearchLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SEARCH_LIMIT
  ) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      `limit must be a whole number from 1 through ${MAX_SEARCH_LIMIT}. Page through larger catalogs with offset.`,
    );
  }
  return value;
}

/** Validate the raw list so duplicate addresses consume the same bound. */
export function discoveryAddresses(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      "addresses must be an array.",
    );
  }
  if (value.length > MAX_DESCRIBE_ADDRESSES) {
    throw new DiscoveryPolicyError(
      "invalid_args",
      `addresses must contain at most ${MAX_DESCRIBE_ADDRESSES} entries. Split a larger list across describe_tools calls.`,
    );
  }
  return value;
}

/** Serialize once and count the exact bytes jsonResult would emit. */
function boundedDiscoveryText(
  value: unknown,
  hint: string,
): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) {
    throw new TypeError("Discovery result is not JSON-serializable.");
  }
  const bytes = enc.encode(text).length;
  if (bytes > MAX_DISCOVERY_RESULT_BYTES) {
    throw new DiscoveryPolicyError(
      "result_too_large",
      `Discovery result is ${bytes} UTF-8 bytes, over the ${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling. ${hint}`,
    );
  }
  return text;
}

/** Apply the same final result guard to code-mode discovery helpers. */
export function assertDiscoveryResultSize(
  value: unknown,
  hint: string,
): void {
  boundedDiscoveryText(value, hint);
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

function discoveryResult(value: unknown, hint: string): ToolResult {
  try {
    const text = boundedDiscoveryText(value, hint);
    return {
      content: [{ type: "text", text }],
      ...(value !== null && typeof value === "object" && !Array.isArray(value)
        ? { structuredContent: value as Record<string, unknown> }
        : {}),
    };
  } catch (err) {
    if (err instanceof DiscoveryPolicyError) {
      return discoveryErrorResult(err);
    }
    throw err;
  }
}

/**
 * The longest the engine will park a synchronous inbound request in *waiting
 * alone*. The engine already treats ~15 s as the outer bound of one reasonable
 * connector call (EXECUTE_HOST_CALL_TIMEOUT_MS), so sleeping for minutes trades
 * a fast, informative failure for a hung one. A connector-reported window this
 * long isn't truncated — it's declined (see `retryBackoffMs`) and reported
 * verbatim as `error.retryAfterMs`, so the agent, which can afford to wait,
 * decides when to re-issue.
 */
export const MAX_RETRY_BACKOFF_MS = 10_000;

/**
 * How long to wait before the next attempt, or `undefined` for "don't retry".
 *
 * A connector that read a `Retry-After` header knows the window exactly, so it
 * is honoured **exactly or not at all**: truncating an exponential *guess* is
 * harmless, but truncating a *known* window means deliberately retrying inside
 * a rate limit — the harm this channel exists to prevent. A window longer than
 * `MAX_RETRY_BACKOFF_MS` therefore declines the retry rather than shortening
 * it. (`retryAfterMs` is normalized non-negative, so `0` means "retry now".)
 * Connectors that report no window keep the historical exponential guess.
 *
 * Waits are per attempt, matching the per-attempt `timeoutMs` race in
 * `runCall`. Exported for direct testing.
 */
export function retryBackoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
): number | undefined {
  if (retryAfterMs === undefined) {
    return Math.min(250 * 2 ** (attempt - 1), 1_000);
  }
  return retryAfterMs <= MAX_RETRY_BACKOFF_MS ? retryAfterMs : undefined;
}

/** Details for failures that never reached a connector (no thrown value). */
function errorDetails(code: string, message: string): ErrorDetails {
  return { code, message, retryable: messageLooksRetryable(message) };
}

/** True if `b` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuationByte(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/** Smallest accepted `get_result` byte offset. */
export const MIN_RESULT_OFFSET = 0;

/**
 * The one definition of a usable `get_result` offset: a whole number of bytes
 * at or past {@link MIN_RESULT_OFFSET}. Shared by the registered zod schema and
 * the handler's own check, the way `isValidMaxResultBytes` is shared across the
 * cap's intake points (issue #32) — so a value valid at the wire is valid in
 * process, and the two cannot drift.
 *
 * Everything else is rejected rather than coerced, because coercion is how an
 * out-of-domain offset used to void a result silently: `Math.max(0, NaN)` is
 * `NaN`, which slices to nothing, serializes as `"offset": null`, and reports
 * no `nextOffset` — a caller sees a successful, empty result instead of an
 * error. An offset past the end of the payload stays legal: it is a whole
 * number of bytes, and it answers with an empty final page.
 */
export function isValidResultOffset(value: number): boolean {
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

/**
 * Move a byte `end` back to the nearest UTF-8 codepoint boundary in
 * `(offset, total]`, so decoding `bytes[offset, end)` never splits a codepoint
 * (which would emit U+FFFD and break byte-exact reassembly). If backing up
 * would make no progress — a single codepoint wider than the window — extend
 * forward to the end of that codepoint instead so paging always advances.
 * Assumes `offset` is itself a codepoint boundary (offsets are the prior
 * `nextOffset`, which this function guarantees, and 0 is always a boundary).
 *
 * The return is always `> offset` while `offset < total`, whatever `end` is
 * asked for. That is the belt-and-braces half of issue #32: cap validation
 * keeps an empty window from arising in the first place, and this keeps an
 * empty window from turning into a `nextOffset === offset` paging loop if one
 * ever does. Exported for direct testing of that invariant.
 */
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

// --- fields selection (feature 2) -----------------------------------------

/** Resolve a dot-path (segments) against a value; `key[]` maps the tail over an array. */
function resolvePath(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value;
  const [seg, ...rest] = segments;
  const isArr = seg.endsWith("[]");
  const key = isArr ? seg.slice(0, -2) : seg;
  let next: unknown = value;
  if (key !== "") {
    if (value === null || typeof value !== "object") return undefined;
    next = (value as Record<string, unknown>)[key];
  }
  if (isArr) {
    if (!Array.isArray(next)) return undefined;
    return next.map((el) => resolvePath(el, rest));
  }
  return resolvePath(next, rest);
}

/** Select the given dot-paths from a value → `{ "<path>": value }` (omitting misses). */
function applyFields(
  value: unknown,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const resolved = resolvePath(value, path.split("."));
    if (resolved !== undefined) out[path] = resolved;
  }
  return out;
}

/** Apply fields to each JSON-parseable text block; non-JSON blocks pass through. */
function applyFieldsToContent(
  content: TextContent[],
  fields: string[],
): TextContent[] {
  return content.map((b) => {
    if (b.type !== "text") return b;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return b;
    }
    return { ...b, text: JSON.stringify(applyFields(parsed, fields), null, 2) };
  });
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
export function serializeResultText(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? String(value) : serialized;
}

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
}> {
  const id = crypto.randomUUID();
  await results.set(`result:${id}`, text, { ttlSeconds: RESULT_TTL_SECONDS });
  return {
    truncated: true,
    resultId: id,
    totalBytes,
    hint: "use get_result {id, offset} to page, or re-call with fields to select less",
  };
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
): Promise<ToolResult> {
  if (bytes.length <= cap) {
    return { content: [{ type: "text", text }] };
  }
  const notice = await stashResult(text, results, bytes.length);
  const head = dec.decode(
    bytes.slice(0, alignEndToCharBoundary(bytes, 0, cap, bytes.length)),
  );
  return {
    content: [{ type: "text", text: `${head}\n${JSON.stringify(notice)}` }],
  };
}

/** {@link guardEncoded} over a string that has not been measured yet. */
async function guardText(
  text: string,
  results: KVStorage,
  cap: number,
): Promise<ToolResult> {
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
): Promise<unknown> {
  const text = serializeResultText(value);
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return value;
  return stashResult(text, results, bytes.length);
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
): Promise<ToolResult> {
  let text: string;
  try {
    text = JSON.stringify(content, null, 2);
  } catch {
    // A block carrying a BigInt or a cycle cannot be serialized, so it cannot
    // be measured, stashed, or paged either — there is nothing this guard could
    // do with it. Pass it through as the old text-only measure did, rather than
    // turning a call that used to succeed into result_processing_failed.
    return { content };
  }
  const bytes = enc.encode(text);
  // Under the cap the downstream blocks pass through untouched, non-text ones
  // included, in their original order.
  if (bytes.length <= cap) return { content };
  if (content.every((b) => b.type === "text")) {
    return guardEncoded(text, bytes, results, cap);
  }
  const notice = await stashResult(text, results, bytes.length);
  return { content: [{ type: "text", text: JSON.stringify(notice) }] };
}

// --- compact schema rendering (feature 3a) --------------------------------

// --- argument shapes -------------------------------------------------------

export interface SearchArgs {
  query?: string;
  connector?: string;
  limit?: number;
  offset?: number;
  fullDescriptions?: boolean;
  includeSchemas?: "compact" | "json";
}
export interface DescribeArgs {
  addresses: string[];
  format?: "compact" | "json";
  fullDescriptions?: boolean;
}
export interface ListArgs {
  /** When false, return cached/observed health without downstream I/O. */
  probe?: boolean;
}
export type ResultMode = "mcp" | "value";
export interface CallArgs {
  address: string;
  args?: Record<string, unknown>;
  fields?: string[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  /** Retries after the first attempt; honored only for safely annotated tools. */
  maxRetries?: number;
  /** Include connector/catalog/result-processing timing segments. */
  diagnostics?: boolean;
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
export interface BatchCall {
  address: string;
  args?: Record<string, unknown>;
  fields?: string[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  maxRetries?: number;
  diagnostics?: boolean;
}
export interface BatchArgs {
  calls: BatchCall[];
  resultMode?: ResultMode;
  timeoutMs?: number;
  maxRetries?: number;
  diagnostics?: boolean;
}
export interface AuthorizeArgs {
  connector: string;
  force?: boolean;
}
export interface SkillArgs {
  name?: string;
}

/**
 * The nine meta-tool handlers over a registry. Exported for direct testing;
 * registerMetaTools() wires them onto an McpServer. `opts.defaultToolTimeoutMs`
 * supplies a deadline for calls that don't carry one. (execute_code, the
 * optional tenth tool, is registered separately by registerExecuteTool.)
 *
 * The deployment-wide result-size cap is read off the registry view rather than
 * passed in: `ConnectaConfig.calls.maxResultBytes` and the per-connector
 * override are the only places a cap is set, so there is one answer to where a
 * deployment sets it (issue #44).
 */
export function createMetaTools(
  registry: RegistryView,
  baseUrl: string,
  opts: {
    /** Deadline applied when a call passes no `timeoutMs`. Off when unset. */
    defaultToolTimeoutMs?: number;
    /** Per-connector deadline for the list/search/describe probe fan-out. Default 30_000. */
    probeTimeoutMs?: number;
    activity?: ActivityRequestContext;
  } = {},
) {
  // Already normalized and warned about at registry construction.
  const globalCap = registry.maxResultBytes;
  const defaultToolTimeoutMs = normalizeTimeoutMs(opts.defaultToolTimeoutMs);
  const probeTimeoutMs =
    normalizeTimeoutMs(opts.probeTimeoutMs) ?? DEFAULT_PROBE_TIMEOUT_MS;
  // createMetaTools() is called once per inbound MCP request. Sharing this
  // identity lets remote connectors reuse one downstream client inside that
  // request without leaking request-bound I/O into the next one.
  const requestScope = {};
  const withProbeDeadline = <T>(
    label: string,
    operation: (options: {
      signal: AbortSignal;
      timeoutMs: number;
    }) => Promise<T>,
  ) =>
    withAbortableTimeout(
      (signal) => operation({ signal, timeoutMs: probeTimeoutMs }),
      probeTimeoutMs,
      label,
    );

  interface RunCallOutcome {
    toolResult: ToolResult;
    durationMs: number;
    attempts: number;
    timing: {
      catalogMs: number;
      connectorMs: number;
      backoffMs: number;
      resultProcessingMs: number;
      totalMs: number;
    };
    value?: unknown;
    error?: ErrorDetails;
  }

  /** Shared call path used by call tools and batch_call: safety → fields → size guard. */
  async function runCall(
    call: BatchCall,
    source: ActivityCallSource,
    options: { allowDestructive?: boolean } = {},
  ): Promise<RunCallOutcome> {
    const started = Date.now();
    let catalogMs = 0;
    let connectorMs = 0;
    let backoffMs = 0;
    let resultProcessingMs = 0;
    let attempts = 0;
    const timing = () => ({
      catalogMs,
      connectorMs,
      backoffMs,
      resultProcessingMs,
      totalMs: Date.now() - started,
    });
    const resolved = registry.resolveAddress(call.address);
    const record = (
      outcome: "success" | "error" | "timeout",
      errorCode?: string,
    ) => {
      if (!resolved) return;
      recordToolActivity(opts.activity, {
        connectorId: resolved.connector.id,
        toolName: resolved.toolName,
        address: `${resolved.connector.id}.${resolved.toolName}`,
        source,
        outcome,
        durationMs: Date.now() - started,
        attempts,
        ...(errorCode ? { errorCode } : {}),
      });
    };
    const failed = (error: ErrorDetails): RunCallOutcome => {
      const durationMs = Date.now() - started;
      const diagnostics = timing();
      record(error.code === "timeout" ? "timeout" : "error", error.code);
      return {
        toolResult:
          call.resultMode === "value"
            ? jsonResult({
                ok: false,
                error,
                durationMs,
                attempts,
                ...(call.diagnostics ? { timing: diagnostics } : {}),
              })
            : errorResult(error.message),
        durationMs,
        attempts,
        timing: diagnostics,
        error,
      };
    };
    if (!resolved) {
      return failed(
        errorDetails("unknown_address", `Unknown address "${call.address}"`),
      );
    }
    const results = registry.resultsStorage();
    // Result-size cap for THIS call: the connector's own override wins, then
    // the deployment-wide value, then the built-in default (already folded
    // into `globalCap`). Resolved per call so one batch_call can mix a
    // tight-capped connector with siblings on the global cap. An override the
    // registry already warned about at startup is dropped here, so the
    // connector simply inherits `globalCap`.
    const cap = resolveMaxResultBytes(
      resolved.connector.maxResultBytes,
      globalCap,
    );
    const fields = call.fields && call.fields.length > 0 ? call.fields : null;
    // An explicit per-call deadline always wins; the config default only fills
    // the gap, and stays off entirely when the deployment sets none.
    const timeoutMs = normalizeTimeoutMs(call.timeoutMs) ?? defaultToolTimeoutMs;
    const maxRetries = Math.min(
      2,
      Math.max(0, Math.trunc(call.maxRetries ?? 0)),
    );
    const catalogStarted = Date.now();
    let definition: ToolDef | undefined;
    try {
      definition = (
        await registry.getTools(resolved.connector.id, baseUrl, requestScope)
      ).find((tool) => tool.name === resolved.toolName);
    } catch (err) {
      catalogMs += Date.now() - catalogStarted;
      // A connector whose catalog cannot be fetched is as unusable as one whose
      // execution fails, so it feeds health accounting the same way the
      // execution catch below does — otherwise a connector every call_tool
      // fails against (a revoked downstream grant, say) still reads clean from
      // the cheap `list_connectors({ probe: false })` signal.
      //
      // Recorded HERE rather than inside the registry's catalog fetch on
      // purpose: `registry` is this connection's VIEW, so a toolkit-scoped
      // session records into its own log as well as the deployment-wide one,
      // which `Registry.refreshTools` could not reach. A cache hit that avoids
      // a live listTools call therefore records nothing either way — it is not
      // evidence of health, and success stays what it has always been: an
      // actual downstream call that returned.
      registry.recordFailure(resolved.connector.id, Date.now() - started, err);
      // classifyCallError so a typed auth_required thrown while listing tools
      // (e.g. a revoked downstream OAuth grant) keeps its code.
      return failed(classifyCallError(err, "catalog_lookup_failed"));
    }
    catalogMs += Date.now() - catalogStarted;
    if (!definition) {
      return failed(
        errorDetails(
          "unknown_tool",
          `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
        ),
      );
    }
    const explicitlyReadOnly =
      definition.annotations?.readOnlyHint === true &&
      definition.annotations?.destructiveHint !== true;
    if (!explicitlyReadOnly && !options.allowDestructive) {
      return failed(
        errorDetails(
          "destructive_tool_requires_approval",
          `Tool "${call.address}" is not explicitly read-only. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
        ),
      );
    }
    const retrySafe =
      definition.annotations?.readOnlyHint === true ||
      definition.annotations?.idempotentHint === true;

    let result: unknown;
    while (true) {
      attempts++;
      const controller = timeoutMs ? new AbortController() : undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ctx = registry.contextFor(
        resolved.connector.id,
        baseUrl,
        requestScope,
        { signal: controller?.signal, timeoutMs },
      );
      const connectorStarted = Date.now();
      try {
        const pending = resolved.connector.callTool(
          resolved.toolName,
          call.args ?? {},
          ctx,
        );
        result = timeoutMs
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(
                    new ConnectorCallError(
                      "timeout",
                      `Tool call timed out after ${timeoutMs}ms`,
                    ),
                  );
                  controller?.abort();
                }, timeoutMs);
              }),
            ])
          : await pending;
        connectorMs += Date.now() - connectorStarted;
        const mcpResult = result as {
          content?: TextContent[];
          isError?: boolean;
        };
        if (resolved.connector.kind === "mcp" && mcpResult?.isError) {
          throw new Error(
            mcpResult.content?.map((block) => block.text).join("") ||
              "Downstream tool call failed",
          );
        }
        break;
      } catch (err) {
        // Includes connector setup, downstream execution, and timeout wait.
        connectorMs += Date.now() - connectorStarted;
        const details = classifyCallError(err);
        if (attempts <= maxRetries && retrySafe && details.retryable) {
          const wait = retryBackoffMs(attempts, details.retryAfterMs);
          if (wait !== undefined) {
            const backoffStarted = Date.now();
            if (wait > 0) {
              await new Promise((resolve) => setTimeout(resolve, wait));
            }
            backoffMs += Date.now() - backoffStarted;
            continue;
          }
          // The reported window is longer than the engine will park a
          // synchronous request for. Fall through to failure with
          // retryAfterMs reported verbatim so the agent can re-issue.
        }
        registry.recordFailure(
          resolved.connector.id,
          Date.now() - started,
          err,
        );
        return failed(details);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    registry.recordSuccess(resolved.connector.id, Date.now() - started);
    const processingStarted = Date.now();
    try {
      const mr = result as { content?: TextContent[]; isError?: boolean };
      if (call.resultMode === "value") {
        let value = unwrapMcpResult(resolved.connector.kind, result);
        if (fields) value = applyFields(value, fields);
        value = await guardValue(value, results, cap);
        resultProcessingMs += Date.now() - processingStarted;
        const durationMs = Date.now() - started;
        const diagnostics = timing();
        record("success");
        return {
          toolResult: jsonResult({
            ok: true,
            data: value,
            durationMs,
            attempts,
            ...(call.diagnostics ? { timing: diagnostics } : {}),
          }),
          durationMs,
          attempts,
          timing: diagnostics,
          value,
        };
      }
      if (resolved.connector.kind === "mcp") {
        let content = mr?.content ?? [];
        if (fields) content = applyFieldsToContent(content, fields);
        const toolResult = await guardContent(content, results, cap);
        resultProcessingMs += Date.now() - processingStarted;
        record("success");
        return {
          toolResult,
          durationMs: Date.now() - started,
          attempts,
          timing: timing(),
        };
      }
      const value = fields ? applyFields(result, fields) : result;
      const toolResult = await guardText(
        serializeResultText(value),
        results,
        cap,
      );
      resultProcessingMs += Date.now() - processingStarted;
      record("success");
      return {
        toolResult,
        durationMs: Date.now() - started,
        attempts,
        timing: timing(),
        value,
      };
    } catch (err) {
      resultProcessingMs += Date.now() - processingStarted;
      return failed(errorDetails("result_processing_failed", msg(err)));
    }
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

    async listConnectors(args: ListArgs = {}): Promise<ToolResult> {
      const probe = args.probe ?? true;
      // Live inventory owns a short-lived scope separate from the request's
      // call scope. Closing it cannot defeat call_tool/batch/execute_code reuse.
      const connectors = registry.listConnectors();
      const scope = probe ? {} : requestScope;
      const out = await Promise.all(
        connectors.map(async (c) => {
          const statusStarted = Date.now();
          const observed = registry.healthFor(c.id);
          const verdict = await registry.credentialHealthFor(c.id);
          let status:
            | ConnectorStatus
            | { state: "ok" | "error" | "unknown"; message?: string };
          if (probe) {
            try {
              status = await withProbeDeadline(
                `list_connectors probe of "${c.id}"`,
                (options) =>
                  registry.statusFor(c.id, baseUrl, scope, options),
              );
            } catch (err) {
              // A probe that outran probeTimeoutMs (or otherwise threw)
              // degrades this connector to an error status rather than
              // hanging the whole list_connectors call.
              status = { state: "error", message: msg(err) };
            }
          } else if (
            verdict &&
            // Deployment-wide, deliberately, like `hasObservedSuccess` beside
            // it: a sibling toolkit's successful call proves the shared
            // credential works, and a verdict retired for one view but not
            // another would make the same connector read differently per scope
            // for a reason that has nothing to do with scope.
            credentialVerdictApplies(verdict, registry.observedSuccessAt(c.id))
          ) {
            // The proactive layer (issue #24): a liveness check already found
            // the stored credential dead, so say so on the cheap path instead of
            // waiting for an agent's real call to discover it. Only while it is
            // the freshest evidence — a successful call since then retires it.
            status = {
              state: verdict.state,
              ...(verdict.message ? { message: verdict.message } : {}),
              ...(verdict.authorizationUrl
                ? { authorizationUrl: verdict.authorizationUrl }
                : {}),
            };
          } else {
            // "error" comes from THIS view's own observations — a sibling
            // toolkit's failure is not this session's experience — while
            // ok/unknown may lean on the deployment-wide success signal, since
            // "the connector answers at all" is a fact about the connector.
            // Unscoped, the two are the same log, so this is unchanged there.
            const derived =
              observed?.consecutiveFailures && observed.consecutiveFailures > 0
                ? ("error" as const)
                : registry.hasObservedSuccess(c.id) || c.kind === "api"
                  ? ("ok" as const)
                  : ("unknown" as const);
            status = {
              // A successful liveness check upgrades "unknown" — nothing has
              // been called yet, but the credential was verified, which is how
              // re-authorization shows up here as ok rather than as an absence
              // of evidence. It never DOWNgrades an observed failure: a real
              // call that failed is stronger evidence than a background check.
              state:
                derived === "unknown" && verdict?.state === "ok"
                  ? ("ok" as const)
                  : derived,
              ...(observed?.lastError ? { message: observed.lastError } : {}),
            };
          }
          // Stamped where the observation actually happened — after the status
          // probe, not before it. A 30-second probe stamped at its start would
          // report a verdict older than it is, and would lose the race against a
          // real call that succeeded WHILE it ran (that success must retire the
          // verdict, and only an honest timestamp says so).
          const checkedAt = new Date().toISOString();
          // A live status probe IS a liveness observation of the stored
          // credential, so it updates the same verdict a background check
          // writes: the cached read afterwards agrees with what the operator
          // just saw, and they are not swept again moments later. Recorded from
          // the STATUS phase only, and only when the connector actually answered
          // — a catalog refresh below is not a credential check (the sweep never
          // fetches one), it is already counted in the health log, and letting
          // its failure land here would spend the freshness budget on it. The
          // registry ignores this for connectors storing no credential of ours.
          if (probe && (status.state === "ok" || status.state === "auth_required")) {
            await registry.recordCredentialHealth(c.id, {
              state: status.state,
              checkedAt,
              ...(status.message ? { message: status.message } : {}),
              ...("authorizationUrl" in status && status.authorizationUrl
                ? { authorizationUrl: status.authorizationUrl }
                : {}),
            });
          }
          let tools = registry.peekTools(c.id);
          // An auth_required status may have just started OAuth. A second
          // listTools probe would overwrite its state/verifier while returning
          // the first (now stale) authorization URL.
          if (probe && status.state === "ok") {
            try {
              tools = await withProbeDeadline(
                `list_connectors catalog refresh of "${c.id}"`,
                (options) =>
                  registry.refreshTools(c.id, baseUrl, scope, options),
              );
              registry.recordSuccess(c.id, Date.now() - statusStarted);
            } catch (err) {
              const details = classifyCallError(err);
              if (details.code === "auth_required") {
                let authStatus: ConnectorStatus | undefined;
                try {
                  authStatus = await withProbeDeadline(
                    `list_connectors authorization status of "${c.id}"`,
                    (options) =>
                      registry.statusFor(c.id, baseUrl, scope, options),
                  );
                } catch {
                  // The typed auth verdict is still authoritative; this second
                  // read exists only to recover the connector's pending URL.
                }
                status =
                  authStatus?.state === "auth_required"
                    ? authStatus
                    : {
                        state: "auth_required" as const,
                        message: details.message,
                      };
                await registry.recordCredentialHealth(c.id, {
                  state: "auth_required",
                  checkedAt,
                  ...(status.message ? { message: status.message } : {}),
                  ...("authorizationUrl" in status &&
                  status.authorizationUrl
                    ? { authorizationUrl: status.authorizationUrl }
                    : {}),
                });
              } else {
                status = { state: "error" as const, message: msg(err) };
              }
              registry.recordFailure(c.id, Date.now() - statusStarted, err);
            }
          }
          const latencyMs = Date.now() - statusStarted;
          const latestObserved = registry.healthFor(c.id);
          const credentialCheck = probe
            ? await registry.credentialHealthFor(c.id)
            : verdict;
          return {
            id: c.id,
            ...(c.title ? { title: c.title } : {}),
            description: c.description,
            toolCount: tools?.length ?? 0,
            status: status.state,
            checkedAt,
            latencyMs,
            probe,
            ...(latestObserved ?? observed ?? {}),
            ...(credentialCheck ? { credentialCheck } : {}),
            ...("authorizationUrl" in status && status.authorizationUrl
              ? { authorizationUrl: status.authorizationUrl }
              : {}),
            ...(status.message ? { message: status.message } : {}),
          };
        }),
      ).finally(async () => {
        if (!probe) return;
        await Promise.all(
          connectors.map((connector) =>
            closeConnectorScope(
              connector,
              registry.contextFor(connector.id, baseUrl, scope),
            ),
          ),
        );
      });
      return jsonResult({ connectors: out });
    },

    async searchTools(args: SearchArgs): Promise<ToolResult> {
      const q = args.query ?? "";
      let limit: number;
      try {
        limit = discoverySearchLimit(args.limit);
      } catch (err) {
        if (err instanceof DiscoveryPolicyError) {
          return discoveryErrorResult(err);
        }
        throw err;
      }
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      const conns = args.connector
        ? [registry.getConnector(args.connector)].filter(
            (c): c is NonNullable<typeof c> => Boolean(c),
          )
        : registry.listConnectors();
      const matches: Array<{
        connectorId: string;
        connectorTitle?: string;
        connectorDescription?: string;
        connectorGuideSkill?: string;
        tool: ToolDef;
        score: number;
        order: number;
      }> = [];
      const catalogs = await Promise.allSettled(
        conns.map((c) =>
          withProbeDeadline(
            `search_tools probe of "${c.id}"`,
            (options) =>
              registry.getTools(c.id, baseUrl, requestScope, options),
          ),
        ),
      );
      let orderBase = 0;
      catalogs.forEach((catalog, connectorIndex) => {
        const c = conns[connectorIndex];
        if (catalog.status === "fulfilled") {
          for (const ranked of rankTools(catalog.value, q)) {
            matches.push({
              connectorId: c.id,
              connectorTitle: c.title,
              connectorDescription: c.description,
              ...(connectorGuide(c)
                ? { connectorGuideSkill: connectorSkillName(c.id) }
                : {}),
              tool: ranked.tool,
              score: ranked.score,
              order: orderBase + ranked.order,
            });
          }
        }
        orderBase += catalog.status === "fulfilled" ? catalog.value.length : 1;
      });
      matches.sort((a, b) => b.score - a.score || a.order - b.order);
      const page = matches.slice(offset, offset + limit);
      const groups: {
        id: string;
        title?: string;
        description?: string;
        /** Skill name of this connector's usage guide, when it has one. */
        guide?: string;
        tools: Array<{
          name: string;
          address: string;
          description?: string;
          inputSchema?: unknown;
          outputSchema?: unknown;
          annotations?: ToolDef["annotations"];
        }>;
      }[] = [];
      const byConnector = new Map<string, (typeof groups)[number]>();
      for (const match of page) {
        let group = byConnector.get(match.connectorId);
        if (!group) {
          group = {
            id: match.connectorId,
            ...(match.connectorTitle ? { title: match.connectorTitle } : {}),
            description: match.connectorDescription,
            ...(match.connectorGuideSkill
              ? { guide: match.connectorGuideSkill }
              : {}),
            tools: [],
          };
          byConnector.set(match.connectorId, group);
          groups.push(group);
        }
        const schema = match.tool.inputSchema ?? { type: "object" };
        group.tools.push({
          name: match.tool.name,
          address: `${match.connectorId}.${match.tool.name}`,
          description: summarizeDescription(
            match.tool.description,
            args.fullDescriptions === true,
          ),
          ...(args.includeSchemas
            ? {
                inputSchema:
                  args.includeSchemas === "json"
                    ? schema
                    : compactSchema(schema),
              }
            : {}),
          ...(args.includeSchemas && match.tool.outputSchema
            ? {
                outputSchema:
                  args.includeSchemas === "json"
                    ? match.tool.outputSchema
                    : compactSchema(match.tool.outputSchema),
              }
            : {}),
          ...(match.tool.annotations
            ? { annotations: match.tool.annotations }
            : {}),
        });
      }
      const nextOffset =
        offset + page.length < matches.length
          ? offset + page.length
          : undefined;
      return discoveryResult(
        {
          connectors: groups,
          total: matches.length,
          offset,
          limit,
          hasMore: nextOffset !== undefined,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        },
        "Request a smaller limit, omit fullDescriptions, or use compact schemas.",
      );
    },

    async describeTools(args: DescribeArgs): Promise<ToolResult> {
      try {
        discoveryAddresses(args.addresses);
      } catch (err) {
        if (err instanceof DiscoveryPolicyError) {
          return discoveryErrorResult(err);
        }
        throw err;
      }
      const format = args.format ?? "compact";
      const resolved = args.addresses.map((address) => ({
        address,
        resolved: registry.resolveAddress(address),
      }));
      const connectorIds = [
        ...new Set(
          resolved
            .map((entry) => entry.resolved?.connector.id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const loaded = await Promise.allSettled(
        connectorIds.map((id) =>
          withProbeDeadline(
            `describe_tools probe of "${id}"`,
            (options) =>
              registry.getTools(id, baseUrl, requestScope, options),
          ),
        ),
      );
      const catalogs = new Map<string, ToolDef[] | Error>();
      loaded.forEach((result, index) => {
        catalogs.set(
          connectorIds[index],
          result.status === "fulfilled"
            ? result.value
            : result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason)),
        );
      });
      const out = resolved.map(({ address, resolved }) => {
        if (!resolved) {
          return { address, error: `Unknown address "${address}"` };
        }
        const catalog = catalogs.get(resolved.connector.id);
        if (catalog instanceof Error) {
          return { address, error: catalog.message };
        }
        const tool = catalog?.find((t) => t.name === resolved.toolName);
        if (!tool) {
          return {
            address,
            error: `Unknown tool "${resolved.toolName}" on connector "${resolved.connector.id}"`,
          };
        }
        const schema = tool.inputSchema ?? { type: "object" };
        return {
          address,
          name: tool.name,
          description: summarizeDescription(
            tool.description,
            args.fullDescriptions === true,
          ),
          ...(connectorGuide(resolved.connector)
            ? { guide: connectorSkillName(resolved.connector.id) }
            : {}),
          inputSchema: format === "json" ? schema : compactSchema(schema),
          ...(tool.outputSchema
            ? {
                outputSchema:
                  format === "json"
                    ? tool.outputSchema
                    : compactSchema(tool.outputSchema),
              }
            : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        };
      });
      return discoveryResult(
        { tools: out },
        'Split the address list or use format: "compact".',
      );
    },

    async callTool(args: CallArgs): Promise<ToolResult> {
      return (await runCall(args, "call_tool")).toolResult;
    },

    async callDestructiveTool(args: CallArgs): Promise<ToolResult> {
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

    async batchCall(args: BatchArgs): Promise<ToolResult> {
      const batchStarted = Date.now();
      const settled = await Promise.allSettled(
        args.calls.map((c) =>
          runCall(
            {
              ...c,
              resultMode: c.resultMode ?? args.resultMode,
              timeoutMs: c.timeoutMs ?? args.timeoutMs,
              maxRetries: c.maxRetries ?? args.maxRetries,
              diagnostics: c.diagnostics ?? args.diagnostics,
            },
            "batch_call",
          ),
        ),
      );
      const results = settled.map((s, i) => {
        const address = args.calls[i].address;
        if (s.status === "rejected") {
          return {
            address,
            ok: false,
            error: msg(s.reason),
            errorDetails: classifyCallError(s.reason, "batch_call_failed"),
          };
        }
        const r = s.value;
        if (r.error) {
          return {
            address,
            ok: false,
            error: r.error.message,
            errorDetails: r.error,
            durationMs: r.durationMs,
            attempts: r.attempts,
            ...((args.calls[i].diagnostics ?? args.diagnostics)
              ? { timing: r.timing }
              : {}),
          };
        }
        if ((args.calls[i].resultMode ?? args.resultMode) === "value") {
          return {
            address,
            ok: true,
            data: r.value,
            durationMs: r.durationMs,
            attempts: r.attempts,
            ...((args.calls[i].diagnostics ?? args.diagnostics)
              ? { timing: r.timing }
              : {}),
          };
        }
        return {
          address,
          ok: true,
          result: r.toolResult.content,
          durationMs: r.durationMs,
          attempts: r.attempts,
          ...((args.calls[i].diagnostics ?? args.diagnostics)
            ? { timing: r.timing }
            : {}),
        };
      });
      return jsonResult({
        results,
        durationMs: Date.now() - batchStarted,
      });
    },

    async authorizeConnector(args: AuthorizeArgs): Promise<ToolResult> {
      const connector = registry.getConnector(args.connector);
      if (!connector) {
        return errorResult(`Unknown connector "${args.connector}"`);
      }
      if (!connector.startAuth) {
        return errorResult(
          `Connector "${args.connector}" does not use downstream OAuth — its auth is static (headers/none), so there is nothing to authorize.`,
        );
      }
      const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
      try {
        const status = await connector.startAuth(ctx, { force: args.force });
        // startAuth just spoke to the downstream about this exact credential, so
        // its answer replaces any older liveness verdict — including the stale
        // `auth_required` that sent the agent here, once it reports ok.
        await registry.recordCredentialHealth(connector.id, {
          state: status.state,
          checkedAt: new Date().toISOString(),
          ...(status.message ? { message: status.message } : {}),
          ...(status.authorizationUrl
            ? { authorizationUrl: status.authorizationUrl }
            : {}),
        });
        if (status.state === "auth_required" && !status.authorizationUrl) {
          // auth_required with nothing to open is a dead end for the operator.
          return errorResult(
            `Connector "${connector.id}": authorization required but no URL is available — retry authorize_connector.`,
          );
        }
        return jsonResult({
          connector: connector.id,
          status: status.state,
          ...(status.authorizationUrl
            ? {
                authorizationUrl: status.authorizationUrl,
                instructions:
                  "Have the operator open authorizationUrl in a browser and complete the consent flow. The provider then redirects back to this server's /oauth/callback/<connector> route, which finishes the flow automatically. Re-run list_connectors afterwards to confirm status is ok.",
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

const LIST_DESC =
  "List connectors with status, cached tool count, and recent real-call health. Use probe=false for a fast inventory; use probe=true (default) only to diagnose live health or authorization.";
const SEARCH_DESC = `Start here when a tool address is unknown. Exact/name matches rank above description matches; an empty query browses all. Pages contain at most ${MAX_SEARCH_LIMIT} tools. includeSchemas="compact" usually removes the describe_tools round trip.`;
const DESCRIBE_DESC = `Inspect up to ${MAX_DESCRIBE_ADDRESSES} known tool addresses when search_tools did not include a sufficient schema. Returns descriptions, input/output schemas, and behavior annotations; format "compact" is the default.`;
const CALL_DESC =
  'Use for one tool explicitly annotated readOnlyHint: true. For 2–10 independent read-only calls use batch_call; for dependent steps or data reduction use execute_code when available. Unannotated, write-capable, and destructive tools are refused and require call_destructive_tool. fields selects JSON dot-paths, resultMode "value" unwraps results, timeoutMs sets a deadline, safe maxRetries are annotation-gated, diagnostics adds timing, and large results page through get_result.';
const CALL_DESTRUCTIVE_DESC =
  "Invoke any tool that is not explicitly annotated readOnlyHint: true, including unannotated, write-capable, or destructive tools. The MCP destructiveHint on this meta-tool lets the host request human approval before execution. Use only after reviewing the downstream tool schema and consequences.";
const GET_RESULT_DESC =
  "Page a truncated result stashed by call_tool/batch_call. Input { id, offset?, maxBytes? } → { text, offset, nextOffset?, totalBytes } sliced by byte offset. maxBytes is a whole number of bytes >= 1 (omit for the deployment default) and offset a whole number of bytes >= 0; an offset inside a multi-byte character is moved back to that character's first byte and the offset served is returned. Unknown/expired id is an error.";
const BATCH_DESC =
  "Use for 2–10 independent tools explicitly annotated readOnlyHint: true. Calls run in parallel with shared request-scoped clients; use execute_code when available instead for dependencies or in-sandbox reduction. Unannotated, write-capable, and destructive tools are refused. Batch timeout, safe retry, result mode, and diagnostics defaults may be overridden per call.";
const AUTHORIZE_DESC =
  "Use after a connector reports auth_required. Starts downstream OAuth and returns an authorizationUrl for the operator to open. force=true wipes stored credentials first and restarts consent.";
const SKILLS_DESC =
  'List or fetch concise guidance for choosing among Connecta meta-tools. Call skills({ name: "usage" }) once when the routing workflow is unfamiliar; do not refetch it in the same task.';

/**
 * Sentences appended to a meta-tool description only when this connection
 * actually has connector guides. Tool descriptions are always-loaded context,
 * so a deployment with no guides gets every base description unchanged rather
 * than paying for text about a feature it does not use.
 *
 * Registration is per connection and reads the connection's own registry view,
 * so under a toolkit these sentences reflect the SCOPED connector set: a scoped
 * session whose connectors carry no guides sees the base descriptions, and
 * never learns from a tool description that guides exist out of scope.
 */
const GUIDE_NOTES = {
  skills:
    ' skills({}) also lists this deployment\'s per-connector usage guides as "connector:<connectorId>"; fetch the guide for a connector before working with it for the first time.',
  search:
    " A connector group carrying `guide` has a usage guide; fetch it with skills({ name: <guide> }).",
  describe:
    " An entry carrying `guide` belongs to a connector with a usage guide; fetch it with skills({ name: <guide> }).",
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

/** Register the nine meta-tools onto an McpServer instance. */
export function registerMetaTools(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    defaultToolTimeoutMs?: number;
    probeTimeoutMs?: number;
    activity?: ActivityRequestContext;
  },
): void {
  const mt = createMetaTools(registry, ctx.baseUrl, {
    defaultToolTimeoutMs: ctx.defaultToolTimeoutMs,
    probeTimeoutMs: ctx.probeTimeoutMs,
    activity: ctx.activity,
  });

  server.registerTool(
    "skills",
    {
      description: describedFor(registry, SKILLS_DESC, "skills"),
      inputSchema: { name: z.string().optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => mt.skills(args as SkillArgs),
  );

  server.registerTool(
    "list_connectors",
    {
      description: LIST_DESC,
      inputSchema: { probe: z.boolean().optional() },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.listConnectors(args as ListArgs),
  );

  server.registerTool(
    "search_tools",
    {
      description: describedFor(registry, SEARCH_DESC, "search"),
      inputSchema: {
        query: z.string().optional(),
        connector: z.string().optional(),
        limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
        offset: z.number().int().nonnegative().optional(),
        fullDescriptions: z.boolean().optional(),
        includeSchemas: z.enum(["compact", "json"]).optional(),
      },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.searchTools(args as SearchArgs),
  );

  server.registerTool(
    "describe_tools",
    {
      description: describedFor(registry, DESCRIBE_DESC, "describe"),
      inputSchema: {
        addresses: z.array(z.string()).max(MAX_DESCRIBE_ADDRESSES),
        format: z.enum(["compact", "json"]).optional(),
        fullDescriptions: z.boolean().optional(),
      },
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.describeTools(args as DescribeArgs),
  );

  server.registerTool(
    "call_tool",
    {
      description: CALL_DESC,
      inputSchema: {
        address: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        fields: z.array(z.string()).optional(),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      // call_tool admits only tools that are themselves explicitly read-only;
      // anything else is refused and routed to call_destructive_tool.
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.callTool(args as CallArgs),
  );

  server.registerTool(
    "call_destructive_tool",
    {
      description: CALL_DESTRUCTIVE_DESC,
      inputSchema: {
        address: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        fields: z.array(z.string()).optional(),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args) => mt.callDestructiveTool(args as CallArgs),
  );

  server.registerTool(
    "authorize_connector",
    {
      description: AUTHORIZE_DESC,
      inputSchema: {
        connector: z.string(),
        force: z.boolean().optional(),
      },
      // Starts (or with force, resets) a downstream OAuth flow — it changes
      // stored connector auth state, so it is deliberately not read-only.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args) => mt.authorizeConnector(args as AuthorizeArgs),
  );

  server.registerTool(
    "get_result",
    {
      description: GET_RESULT_DESC,
      inputSchema: {
        id: z.string(),
        // Both bounds are the shared rules (isValidResultOffset,
        // isValidMaxResultBytes) expressed for the wire: spelling them against
        // the same constants keeps the schema from drifting away from the
        // in-handler checks if either floor ever moves.
        offset: z.number().int().min(MIN_RESULT_OFFSET).optional(),
        maxBytes: z.number().int().min(MIN_MAX_RESULT_BYTES).optional(),
      },
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => mt.getResult(args as GetResultArgs),
  );

  server.registerTool(
    "batch_call",
    {
      description: BATCH_DESC,
      inputSchema: {
        calls: z
          .array(
            z.object({
              address: z.string(),
              args: z.record(z.string(), z.unknown()).optional(),
              fields: z.array(z.string()).optional(),
              resultMode: z.enum(["mcp", "value"]).optional(),
              timeoutMs: z.number().int().positive().optional(),
              maxRetries: z.number().int().min(0).max(2).optional(),
              diagnostics: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(10),
        resultMode: z.enum(["mcp", "value"]).optional(),
        timeoutMs: z.number().int().positive().optional(),
        maxRetries: z.number().int().min(0).max(2).optional(),
        diagnostics: z.boolean().optional(),
      },
      // Same gate as call_tool: every call in the batch must be explicitly
      // read-only or the batch is refused.
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.batchCall(args as BatchArgs),
  );
}
