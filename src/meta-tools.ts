import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  ActivityCallSource,
  ActivityRequestContext,
} from "./activity.js";
import { advertisedSchema } from "./advertised-schema.js";
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
import { boundedEchoText, msg, type CallErrorDetails } from "./errors.js";
import { serializeResultText } from "./executor-result.js";
import {
  InvocationService,
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
import { isExplicitlyReadOnly, type ApprovalPolicy } from "./tool-safety.js";

export {
  MAX_DESCRIBE_ADDRESSES,
  MAX_DISCOVERY_RESULT_BYTES,
  MAX_SEARCH_LIMIT,
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
    const result = jsonResult(value, text);
    const bytes = enc.encode(JSON.stringify(result)).length;
    if (bytes > MAX_DISCOVERY_RESULT_BYTES) {
      throw new DiscoveryPolicyError(
        "result_too_large",
        `Discovery result is ${bytes} UTF-8 bytes, over the ${MAX_DISCOVERY_RESULT_BYTES}-byte ceiling. ${hint}`,
      );
    }
    return result;
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

/** Prefix of the chunked paging envelope; `v1`'s single inline key still reads. */
const RESULT_ENVELOPE_V2 = "connecta-result-v2:";

/**
 * The current envelope: v2's header plus the inline cap of the call that
 * stashed it, `<total>:<chunk>:<cap>:`, so get_result can clamp a page to the
 * connector's own cap without the stash carrying connector identity.
 */
const RESULT_ENVELOPE_V3 = "connecta-result-v3:";
const RESULT_ENVELOPE_V3_HEADER = new RegExp(`^${RESULT_ENVELOPE_V3}(\\d+):(\\d+):(\\d+):`);

/** `<total bytes>:<bytes per chunk>:` follow the prefix, then chunk 0's base64. */
const RESULT_ENVELOPE_V2_HEADER = new RegExp(`^${RESULT_ENVELOPE_V2}(\\d+):(\\d+):`);

/**
 * Smallest chunk of result text stored under one key. A multiple of three so
 * every chunk's base64 stands alone and a byte offset inside it lands on a
 * whole quad, and about twice the 24,000-byte default page so a default page
 * reads one or two chunks rather than dozens.
 */
const RESULT_CHUNK_BYTES = 49_152;

/**
 * Keys one stashed result may occupy. Chunking trades write count for read
 * count, and both are real: every chunk is a storage write at stash time, and
 * `fileStorage` rewrites its whole file per write. Above roughly 1.5 MB the
 * chunks widen instead of multiplying, so a result costs a bounded number of
 * writes and a page still reads a small fraction of it.
 */
const RESULT_MAX_CHUNKS = 32;

/** Chunk width for a result of `totalBytes`, always a multiple of three. */
function resultChunkBytes(totalBytes: number): number {
  return Math.max(
    RESULT_CHUNK_BYTES,
    Math.ceil(totalBytes / RESULT_MAX_CHUNKS / 3) * 3,
  );
}

/**
 * Base64 of `bytes`, in three-byte-aligned batches so the argument list of one
 * spread never grows with the result. Alignment matters: an unaligned batch
 * would pad mid-stream and the concatenation would no longer decode.
 */
function base64Of(bytes: Uint8Array): string {
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += 12_288) {
    out += btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12_288)));
  }
  return out;
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
interface ResultStash {
  set: RegistryView["stashResult"];
  warn: () => void;
  /**
   * The call was not explicitly read-only, so it may have changed something
   * downstream. Its notice says the call already ran: an agent that cannot see
   * a write's result must page it, never repeat the write to look again.
   */
  write: boolean;
  /** The call's effective inline cap; recorded so its pages obey it too. */
  cap: number;
}

/** Opens a write's notice, ahead of any paging instruction. */
const WRITE_ALREADY_RAN =
  "This write already ran: do not call it again to see its result.";

/**
 * How the inline preview relates to what `get_result` pages: a byte prefix of
 * it, so paging continues where the preview stops; a readable rendering of a
 * different stashed text (several text blocks, whose envelope pages from 0);
 * or no preview at all.
 */
type PreviewShape =
  | { kind: "prefix"; bytes: number }
  | { kind: "text-of-envelope" }
  | { kind: "none" };

/**
 * Offers a read the route meta-tools.md prefers for finding something in it:
 * repeat the call inside a program and reduce it there. Paging comes second,
 * for reading the whole thing. Led by paging alone, the eval's weakest model
 * read a 185 KB log in eight pages, skipped the range holding the answer, and
 * reported the decoy near the top instead. A write never gets this: repeating
 * it is the one thing its notice forbids.
 */
const READ_REDUCE_FIRST =
  "To find something specific, repeat this read inside execute_code with connecta.call and filter or search the result there, returning only what matters";

function pagingHint(
  results: ResultStash,
  totalBytes: number,
  preview: PreviewShape,
): string {
  if (!results.write) {
    const [shown, full] =
      preview.kind === "prefix"
        ? [`Bytes 0-${preview.bytes} of ${totalBytes} follow.`, "to read it in full, page the rest"]
        : preview.kind === "text-of-envelope"
          ? ["Its text follows.", `to read the full ${totalBytes}-byte content array as JSON, page it`]
          : [`The result is ${totalBytes} bytes.`, "to read it in full, page it"];
    return `${shown} ${READ_REDUCE_FIRST}; ${full} with get_result using nextAction.`;
  }
  const body =
    preview.kind === "prefix"
      ? `Bytes 0-${preview.bytes} of ${totalBytes} follow; page the rest with get_result using nextAction.`
      : preview.kind === "text-of-envelope"
        ? `Its text follows; page the full ${totalBytes}-byte content array as JSON with get_result using nextAction.`
        : `Page all ${totalBytes} bytes with get_result using nextAction.`;
  return `${WRITE_ALREADY_RAN} ${body}`;
}

/**
 * Stash a completed result and describe it with a notice that leads whatever
 * the caller returns, or a notice without a paging route when stashing fails.
 *
 * The notice goes first because clients cut oversized results from the end:
 * Claude Code keeps the first 2,000 characters of a result it spills to disk,
 * and a notice at the tail never reached the agent (see
 * documentation/meta-tools.md#result-representation). It is one compact JSON
 * line with no raw newline, so the preview starts after the first `\n`.
 */
async function stashResult(
  bytes: Uint8Array,
  results: ResultStash,
  preview: PreviewShape,
) {
  const totalBytes = bytes.length;
  const id = crypto.randomUUID();
  try {
    // Base64 permits byte-range decoding, and splitting the envelope across
    // keys keeps a page's storage read proportional to the page instead of to
    // the whole result (issue #540). Chunk 0 carries the header; the get_result
    // reader below maps a byte offset back to chunk index and base64 quad.
    const chunkBytes = resultChunkBytes(totalBytes);
    const chunks = [`${RESULT_ENVELOPE_V3}${totalBytes}:${chunkBytes}:${results.cap}:`];
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = base64Of(bytes.subarray(offset, offset + chunkBytes));
      if (offset === 0) chunks[0] += chunk;
      else chunks.push(chunk);
    }
    if (!await results.set(`result:${id}`, chunks, RESULT_TTL_SECONDS)) {
      throw new Error("Result stash capacity exhausted");
    }
  } catch {
    // Paging is advisory after a completed call, including an approved write.
    // Neither backend prose nor a retry hint belongs in this successful result.
    try {
      results.warn();
    } catch {
      // Logging cannot change the call either.
    }
    return {
      truncated: true,
      totalBytes,
      hint: results.write
        ? `Paging is unavailable. ${WRITE_ALREADY_RAN}`
        : "Paging is unavailable. Use execute_code to reduce read-only results before returning them.",
    };
  }
  return {
    truncated: true,
    resultId: id,
    totalBytes,
    hint: pagingHint(results, totalBytes, preview),
    nextAction: {
      tool: "get_result",
      arguments: { id, offset: preview.kind === "prefix" ? preview.bytes : 0 },
    },
  };
}

interface GuardedResult<T> {
  result: T;
  truncated: boolean;
}

/** The first `cap` bytes of `bytes`, ending on a character boundary. */
function headOf(bytes: Uint8Array, cap: number): Uint8Array {
  return bytes.subarray(0, alignEndToCharBoundary(bytes, 0, cap, bytes.length));
}

/** One text block: the notice line, then the preview. */
function noticeFirst(notice: object, preview: string): ToolResult {
  return { content: [{ type: "text", text: `${JSON.stringify(notice)}\n${preview}` }] };
}

/**
 * Return `text` as a single content block; if it exceeds `cap` bytes, stash the
 * full text and return a JSON truncation notice pointing at get_result,
 * followed by the first `cap` bytes. The preview is a byte prefix of what
 * pages, so the notice's next action continues where it stops. `bytes` is
 * `text` already encoded, so a caller that had to measure it to make this
 * decision doesn't encode it twice.
 */
async function guardEncoded(
  text: string,
  bytes: Uint8Array,
  results: ResultStash,
  cap: number,
): Promise<GuardedResult<ToolResult>> {
  if (bytes.length <= cap) {
    return {
      result: { content: [{ type: "text", text }] },
      truncated: false,
    };
  }
  const head = headOf(bytes, cap);
  const notice = await stashResult(bytes, results, {
    kind: "prefix",
    bytes: head.length,
  });
  return { result: noticeFirst(notice, dec.decode(head)), truncated: true };
}

/** {@link guardEncoded} over a string that has not been measured yet. */
async function guardText(
  text: string,
  results: ResultStash,
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
  results: ResultStash,
  cap: number,
): Promise<GuardedResult<unknown>> {
  const text = serializeResultText(value);
  const bytes = enc.encode(text);
  if (bytes.length <= cap) return { result: value, truncated: false };
  const notice = await stashResult(bytes, results, { kind: "none" });
  return {
    result: notice.resultId ? notice : {
      ...notice,
      preview: escapedHeadOf(bytes, cap),
    },
    truncated: true,
  };
}

/**
 * The longest head of `bytes` whose JSON string form fits `cap` bytes. Value
 * mode carries an unpageable preview inside its JSON envelope, where escaping
 * could double a quote-heavy head cut at `cap` bytes; a response that only
 * exists because paging failed must not be the one that breaks the cap.
 */
function escapedHeadOf(bytes: Uint8Array, cap: number): string {
  let limit = cap;
  for (;;) {
    const head = limit === 0 ? "" : dec.decode(headOf(bytes, limit));
    const escaped = enc.encode(JSON.stringify(head)).length;
    if (escaped <= cap || limit === 0) return head;
    limit = Math.max(0, Math.min(limit - 1, Math.floor((limit * cap) / escaped)));
  }
}

/**
 * Bound a downstream MCP `content` array by `cap`.
 *
 * A lone text block is measured, stashed, previewed, and paged as its text:
 * its envelope adds nothing but a wrapper and a second layer of JSON escaping,
 * which made a JSON payload's preview unreadable and inflated every page.
 *
 * Anything else is measured as the serialized envelope — the same string that
 * gets stashed and paged, and the one that counts every block rather than only
 * the text ones. Both halves matter (issue #43). Measuring only text blocks
 * meant an oversized all-image result scored zero bytes and was returned inline
 * unbounded, with no `resultId` to page from; and measuring one string while
 * truncating another left `totalBytes` describing something the cap was never
 * compared against.
 *
 * Over the cap, what a client gets depends on whether a preview is usable.
 * Several text blocks preview as their text joined by newlines, while
 * get_result pages the envelope from offset 0, where the block boundaries
 * live. An envelope carrying non-text blocks is replaced by the notice alone:
 * the head of a half-written base64 image is of no use to anyone. Either way
 * the full envelope is stashed and pages through `get_result`.
 */
async function guardContent(
  content: TextContent[],
  results: ResultStash,
  cap: number,
): Promise<GuardedResult<ToolResult>> {
  const only = content.length === 1 ? content[0] : undefined;
  if (only?.type === "text" && typeof only.text === "string") {
    const bytes = enc.encode(only.text);
    // Under the cap the block passes through untouched, annotations included.
    if (bytes.length <= cap) return { result: { content }, truncated: false };
    return guardEncoded(only.text, bytes, results, cap);
  }
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
    const joined = enc.encode(content.map((b) => b.text).join("\n"));
    const notice = await stashResult(bytes, results, { kind: "text-of-envelope" });
    return {
      result: noticeFirst(notice, dec.decode(headOf(joined, cap))),
      truncated: true,
    };
  }
  const notice = await stashResult(bytes, results, { kind: "none" });
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
  includeSchemas?: "compact" | "json" | "typescript";
}
type ResultMode = "mcp" | "value";
export interface CallArgs {
  address: string;
  args?: Record<string, unknown>;
  resultMode?: ResultMode;
  timeoutMs?: number;
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
    canManageAuth?: ((id: string) => boolean) | undefined;
    credentialHandoffUrl?: string | undefined;
    /** Inbound request cancellation shared by every call this request makes. */
    requestSignal?: AbortSignal | undefined;
    /** Runtime-owned tail for stale catalog refreshes. */
    defer?: DeferredWork | undefined;
    /** Config approval exemptions (#566), shown on discovery rows. */
    approval?: ApprovalPolicy | undefined;
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
    requestSignal: opts.requestSignal,
    approval: opts.approval,
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
          const results: ResultStash = {
            write: !isExplicitlyReadOnly(resolved.definition),
            cap,
            set: (key, value, ttlSeconds) => registry.stashResult(key, value, ttlSeconds),
            warn: () => registry.contextFor(
              resolved.connector.id, baseUrl, requestScope,
            ).logger.warn("[connecta] result paging unavailable", {
              connector: resolved.connector.id,
              tool: resolved.toolName,
            }),
          };
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
            const mcpResult = result as {
              content?: TextContent[];
              structuredContent?: unknown;
            };
            let content = mcpResult?.content ?? [];
            if (
              !content.some((block) => block.type === "text") &&
              mcpResult?.structuredContent !== undefined
            ) {
              content = [...content, {
                type: "text",
                text: JSON.stringify(mcpResult.structuredContent),
              }];
            }
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
        // Sanitized `unavailable` diagnostics ride the structured shape too;
        // the plain-text path would drop them (#539).
        outcome.error.details !== undefined ||
        // So does a conflict's `current`: where things stand is the retry.
        outcome.error.current !== undefined ||
        [
          "auth_required",
          "invalid_args",
          "input_required_unsupported",
        ].includes(outcome.error.code);
      const makeFailedResult = () =>
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
      let failedResult = makeFailedResult();
      // Value mode repeats the error in text and structuredContent. Account for
      // both copies and JSON escaping when the bounded provider reason is large.
      if (!recoveryRequired) {
        const cap = resolveMaxResultBytes(
          outcome.resolved?.connector.maxResultBytes, globalCap,
        );
        let budget = 512;
        while (enc.encode(JSON.stringify(failedResult)).length > cap && budget > 0) {
          budget = Math.floor(budget / 2);
          outcome.error.message = boundedEchoText(outcome.error.message, budget);
          failedResult = makeFailedResult();
        }
      }
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
      if (args.connector !== undefined && enc.encode(args.connector).length > 512) {
        return discoveryErrorResult(new DiscoveryPolicyError(
          "invalid_args", "connector must be at most 512 UTF-8 bytes.",
        ));
      }
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
      const unavailableResult = () => ({
        ...jsonResult({
          error: {
            code: "unavailable",
            message: "Result paging storage is unavailable.",
            retryable: true,
          },
        }),
        isError: true,
      });
      // `false` is a storage failure — retryable, and distinct from an id that
      // is simply gone. Every key a page touches answers the same way, so a
      // backend that dies halfway through a multi-chunk page says so.
      const read = async (key: string): Promise<string | null | false> => {
        try {
          return await results.get(key) ?? null;
        } catch {
          return false;
        }
      };
      const stored = await read(`result:${args.id}`);
      if (stored === false) return unavailableResult();
      if (stored === null) {
        return errorResult(`Unknown or expired result id "${boundedEchoText(args.id)}"`);
      }
      const requestedOffset = args.offset ?? 0;
      // Read and decode only the chunks this page covers, plus a few bytes of
      // UTF-8 boundary lookaround. Pre-upgrade entries stay readable for their
      // short TTL: v2 is this format without the recorded cap, v1 inlined the
      // whole envelope under one key, which is v2 with a single chunk as wide
      // as the result, and raw text before that still pays one full encode
      // per page.
      const current = RESULT_ENVELOPE_V3_HEADER.exec(stored.slice(0, 96));
      const chunked = current ?? RESULT_ENVELOPE_V2_HEADER.exec(stored.slice(0, 80));
      const inline = chunked ? null : /^connecta-result-v1:(\d+):/.exec(stored.slice(0, 64));
      const header = chunked ?? inline;
      // A page never exceeds the inline cap of the call that stashed it — the
      // connector's override when it had one — whatever maxBytes asks for.
      // Clients cut an oversized page exactly as they cut the original result,
      // so honouring a larger request would hand the agent an error in place
      // of its data. Entries from before the cap was recorded use the
      // deployment-wide one.
      const cap = current ? Number(current[3]) : globalCap;
      const maxBytes = Math.min(args.maxBytes ?? cap, cap);
      let bytes: Uint8Array;
      let total: number;
      let start = 0;
      if (header) {
        total = Number(header[1]);
        const chunkBytes = chunked ? Number(chunked[2]) : Math.max(total, 1);
        start = Math.floor(Math.max(0, Math.min(requestedOffset, total) - 3) / 3) * 3;
        const end = Math.min(total, requestedOffset + maxBytes + 4);
        bytes = new Uint8Array(Math.max(0, end - start));
        const lastChunk = Math.floor(Math.max(end - 1, start) / chunkBytes);
        for (let index = Math.floor(start / chunkBytes); index <= lastChunk; index++) {
          const encoded = index === 0
            ? stored.slice(header[0].length)
            : await read(`result:${args.id}#${index}`);
          if (encoded === false) return unavailableResult();
          if (encoded === null) {
            // A chunk expired or was evicted under its own header; the id can no
            // longer serve this range, and inventing U+0000 filler would be worse.
            return errorResult(`Unknown or expired result id "${boundedEchoText(args.id)}"`);
          }
          const chunkStart = index * chunkBytes;
          // Both bounds are chunk-local. `from` inherits `start`'s three-byte
          // alignment because every chunk boundary is a multiple of three.
          const from = Math.max(start, chunkStart) - chunkStart;
          const to = Math.min(end, chunkStart + chunkBytes, total) - chunkStart;
          const binary = atob(encoded.slice(from / 3 * 4, Math.ceil(to / 3) * 4));
          for (let at = from; at < to; at++) {
            bytes[chunkStart + at - start] = binary.charCodeAt(at - from);
          }
        }
      } else {
        bytes = enc.encode(stored);
        total = bytes.length;
      }
      // Validated above, so no coercion is needed here — only alignment. A
      // client that computes its own offsets can land inside a multi-byte
      // character, which would decode as U+FFFD; the offset actually served is
      // the boundary at or before it, and it is what the response reports back
      // as `offset` (issue #38).
      const offset = start + alignStartToCharBoundary(bytes, requestedOffset - start);
      // Both sides of `maxBytes` are validated by now — the argument above, the
      // cap at intake — so `offset + maxBytes` always reaches past `offset`.
      // Align the slice end to a codepoint boundary so a multi-byte char is
      // never split across pages (which would emit U+FFFD on both sides).
      // `nextOffset` is this aligned end, so it is a valid boundary for the
      // next call and paging reassembles the original byte-for-byte.
      const end = start + alignEndToCharBoundary(
        bytes,
        offset - start,
        offset - start + maxBytes,
        total - start,
      );
      const slice = dec.decode(bytes.subarray(offset - start, end - start));
      const hasMore = end < total;
      // The same notice-first shape as a truncated call: one line of header,
      // then the page as raw text. A JSON `text` field escaped every quote and
      // newline in the page — a second layer over JSON payloads — which
      // inflated pages past the size clients accept and made them hard to read.
      return noticeFirst({
        resultId: args.id,
        offset,
        bytes: Math.max(0, end - offset),
        totalBytes: total,
        hasMore,
        ...(hasMore
          ? { nextAction: { tool: "get_result", arguments: { id: args.id, offset: end } } }
          : {}),
      }, slice);
    },

    async authorizeConnector(args: AuthorizeArgs): Promise<ToolResult> {
      const connector = registry.getConnector(args.connector);
      if (!connector) {
        return errorResult(`Unknown connector "${boundedEchoText(args.connector)}"`);
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
        if (!ctx.credential || !opts.credentialHandoffUrl) {
          return jsonResult({
            connector: connector.id,
            recovery: "unavailable",
            message:
              "Credential recovery needs both a vault and the optional UI. Configure " +
              "vault and ui in deployment code, then call " +
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
          operatorUrl: opts.credentialHandoffUrl,
          instructions:
            "Have the operator open operatorUrl, set and test the credential, " +
            "then retry the original call. No redeploy is needed. " +
            (connector.authScope === "personal"
              ? "Credential mutation requires the signed-in principal who owns this connection."
              : "Shared credential mutation requires a signed-in human with access to this connector."),
        });
      }
      if (!opts.canManageAuth?.(connector.id)) return jsonResult({ connector: connector.id, recovery: "unavailable", message: "Your identity is not permitted to manage authentication for this connection." });
      const ctx = registry.contextFor(connector.id, baseUrl, requestScope);
      try {
        const status = await connector.startAuth(
          ctx,
          args.force !== undefined ? { force: args.force } : {},
        );
        if (status.authorizationUrl) {
          await registry.bindOAuthHandoff(
            connector.id,
            status.authorizationUrl,
          );
        }
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

const SEARCH_DESC = `Use top-level search for catalog inspection or approval-required work before call_destructive_tool. Unknown-address read-only work belongs in one execute_code program that searches, calls, and returns the answer. Use 2–4 action/object terms and includeSchemas="compact"; the default limit is ${DEFAULT_SEARCH_LIMIT}. Set connector when known. safety="readOnly" finds tools that run unasked; "approvalRequired" finds the fail-closed complement. These filters grant no authority. Empty query browses.`;
const CALL_DESC =
  'Call one known-address tool explicitly annotated readOnlyHint: true. Use execute_code for unknown-address, multiple, dependent, or reduced read-only work. Unannotated or write-capable tools fail closed to call_destructive_tool. A truncated result carries a get_result action.';
const CALL_DESTRUCTIVE_DESC =
  "Call any tool not explicitly annotated readOnlyHint: true. Include a short reason for the human reviewer after checking the schema and consequences. The reason grants no authority and is not sent downstream.";
const GET_RESULT_DESC =
  "Page a truncated direct-call result by id and byte offset. A program result is never paged; reduce it inside execute_code. Returns a one-line JSON header (offset, bytes, totalBytes, hasMore, nextAction) and then the page as raw text. maxBytes is an upper bound, clamped to the result's inline cap.";
const AUTHORIZE_DESC =
  "Use after auth_required. Returns an OAuth or operator-credential handoff, or reports required deployment configuration. force=true restarts OAuth only; this tool never accepts credentials.";
const SKILLS_DESC =
  'List or fetch on-demand guidance. Fetch usage only when the always-loaded instructions are insufficient or a program needs repair.';

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
  diagnostics: z.boolean().optional(),
};

// The six input schemas, built once at module scope so their JSON Schema is
// derived once per process (see advertisedSchema). Nothing here may read
// deployment configuration or the request's identity: anything that varies
// belongs in the per-registration description instead.
const SKILLS_INPUT = advertisedSchema(z.object({ name: z.string().optional() }));

const SEARCH_INPUT = advertisedSchema(
  z.object({
    query: z.string().optional(),
    connector: z.string().optional(),
    safety: z.enum(["readOnly", "approvalRequired", "all"]).optional(),
    limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
    offset: z.number().int().nonnegative().optional(),
    fullDescriptions: z.boolean().optional(),
    includeSchemas: z.enum(["compact", "json", "typescript"]).optional(),
  }),
);

const CALL_INPUT = advertisedSchema(z.strictObject(CALL_INPUT_SCHEMA));

const CALL_DESTRUCTIVE_INPUT = advertisedSchema(
  z.strictObject({
    ...CALL_INPUT_SCHEMA,
    // Bounded above, but with no lower bound: a model that sends `""` or
    // whitespace has written no reason, and failing an entire consequential
    // call over a cosmetic field the host merely displays is the wrong
    // trade. It is normalized to absent in the handler instead.
    reason: z.string().max(500).optional(),
  }),
);

const AUTHORIZE_INPUT = advertisedSchema(
  z.object({
    connector: z.string(),
    force: z.boolean().optional(),
  }),
);

const GET_RESULT_INPUT = advertisedSchema(
  z.object({
    id: z.string(),
    // Both bounds are the shared rules (isValidResultOffset,
    // isValidMaxResultBytes) expressed for the wire: spelling them against
    // the same constants keeps the schema from drifting away from the
    // in-handler checks if either floor ever moves.
    offset: z.number().int().min(MIN_RESULT_OFFSET).optional(),
    maxBytes: z.number().int().min(MIN_MAX_RESULT_BYTES).optional(),
  }),
);

/**
 * Register the six explicit meta-tools onto an McpServer instance.
 * `registerExecuteTool` adds the seventh, `execute_code`, and
 * `registerResumeTool` the eighth, `resume_execution`. Broad discovery and
 * multi-call work uses discovery and ordinary JavaScript promises inside a
 * program, which `execute_code` builds over the same
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
    canManageAuth?: ((id: string) => boolean) | undefined;
    credentialHandoffUrl?: string | undefined;
    requestSignal?: AbortSignal | undefined;
    defer?: DeferredWork | undefined;
    approval?: ApprovalPolicy | undefined;
  },
): void {
  const mt = createMetaTools(registry, ctx.baseUrl, {
    defaultToolTimeoutMs: ctx.defaultToolTimeoutMs,
    probeTimeoutMs: ctx.probeTimeoutMs,
    discoveryConcurrency: ctx.discoveryConcurrency,
    activity: ctx.activity,
    canManageAuth: ctx.canManageAuth,
    credentialHandoffUrl: ctx.credentialHandoffUrl,
    requestSignal: ctx.requestSignal,
    defer: ctx.defer,
    approval: ctx.approval,
  });

  server.registerTool(
    "skills",
    {
      description: describedFor(registry, SKILLS_DESC, "skills"),
      inputSchema: SKILLS_INPUT,
      annotations: READ_ONLY_LOCAL,
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
      inputSchema: SEARCH_INPUT,
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.searchTools(args as SearchArgs),
  );

  server.registerTool(
    "call_tool",
    {
      description: CALL_DESC,
      inputSchema: CALL_INPUT,
      // call_tool admits only tools that are themselves explicitly read-only;
      // anything else is refused and routed to call_destructive_tool.
      annotations: READ_ONLY_REMOTE,
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
      inputSchema: CALL_DESTRUCTIVE_INPUT,
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        openWorldHint: true,
      },
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
      inputSchema: AUTHORIZE_INPUT,
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
      inputSchema: GET_RESULT_INPUT,
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => mt.getResult(args as GetResultArgs),
  );
}
