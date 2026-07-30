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
import {
  mapSettledWithConcurrency,
  resolveDiscoveryConcurrency,
} from "./concurrency.js";
import {
  closeConnectorScope,
  type DeferredWork,
} from "./connector-scope.js";
import {
  classifyCallError,
  messageLooksRetryable,
  type CallErrorDetails,
} from "./errors.js";
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
  withAbortableTimeout,
} from "./timeout.js";
import type {
  ConnectaSurface,
  ConnectorStatus,
  KVStorage,
} from "./types.js";

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
  content: TextContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  [x: string]: unknown;
}

const RESULT_TTL_SECONDS = 900;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function jsonResult(obj: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(obj) }],
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

function errorDetails(code: string, message: string): CallErrorDetails {
  return { code, message, retryable: messageLooksRetryable(message) };
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


/** True if `b` is a UTF-8 continuation byte (0b10xxxxxx). */
function isContinuationByte(b: number | undefined): boolean {
  return b !== undefined && (b & 0xc0) === 0x80;
}

/** Smallest accepted `get_result` byte offset. */
const MIN_RESULT_OFFSET = 0;

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
  const seg = segments[0];
  if (seg === undefined) return value;
  const rest = segments.slice(1);
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

const MAX_PROJECTION_AVAILABLE_FIELDS = 20;
const MAX_PROJECTION_SCHEMA_DEPTH = 12;
const MAX_PROJECTION_SCHEMA_NODES = 200;
const MAX_PROJECTION_SCHEMA_PATHS = 100;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

interface FieldProjection {
  data: Record<string, unknown>;
  unmatchedFields: string[];
}

interface ProjectionFeedback {
  data: Record<string, unknown>;
  $connecta: {
    type: "field_projection";
    unmatchedFields: string[];
    schemaDeclared?: true;
    schemaCoverage?: "complete" | "partial";
    invalidFields?: string[];
    availableFields?: string[];
    availableFieldsTruncated?: true;
  };
}

interface SchemaFieldAnalysis {
  paths: string[];
  complete: boolean;
  truncated: boolean;
}

function localSchemaRef(root: unknown, ref: string): unknown | undefined {
  if (ref === "#") return root;
  if (
    !ref.startsWith("#/") ||
    ref.length > 2_048 ||
    /~(?![01])/.test(ref)
  ) {
    return undefined;
  }
  const segments = ref.slice(2).split("/");
  if (segments.length > MAX_PROJECTION_SCHEMA_DEPTH) return undefined;
  let current = root;
  for (const encoded of segments) {
    if (current === null || typeof current !== "object") return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function hasSchemaType(
  schema: Record<string, unknown>,
  wanted: string,
): boolean {
  return (
    schema.type === wanted ||
    (Array.isArray(schema.type) && schema.type.includes(wanted))
  );
}

function selectableFieldName(name: string): boolean {
  return name.length > 0 && !name.includes(".") && !name.endsWith("[]");
}

/**
 * Collect selectable output paths without trusting a schema more than JSON
 * Schema permits. Traversal is iterative and budgeted before sorting or
 * rendering, so a cyclic, extremely deep, or extremely broad downstream
 * schema cannot turn projection feedback into unbounded host work.
 */
function analyzeSchemaFields(root: unknown): SchemaFieldAnalysis {
  interface PendingSchema {
    schema: unknown;
    prefix: string;
    depth: number;
    ancestors: Set<unknown>;
  }
  const pending: PendingSchema[] = [
    { schema: root, prefix: "", depth: 0, ancestors: new Set() },
  ];
  const paths = new Set<string>();
  let nodes = 0;
  let complete = true;
  let truncated = false;

  const addPath = (path: string): boolean => {
    if (paths.has(path)) return true;
    if (paths.size >= MAX_PROJECTION_SCHEMA_PATHS) {
      complete = false;
      truncated = true;
      return false;
    }
    paths.add(path);
    return true;
  };
  const enqueue = (item: PendingSchema): boolean => {
    if (nodes + pending.length >= MAX_PROJECTION_SCHEMA_NODES) {
      complete = false;
      truncated = true;
      return false;
    }
    pending.push(item);
    return true;
  };

  while (pending.length > 0) {
    const item = pending.pop()!;
    if (item.depth > MAX_PROJECTION_SCHEMA_DEPTH) {
      complete = false;
      truncated = true;
      continue;
    }
    if (++nodes > MAX_PROJECTION_SCHEMA_NODES) {
      complete = false;
      truncated = true;
      break;
    }
    if (item.schema === false) continue;
    if (
      item.schema === true ||
      item.schema === null ||
      typeof item.schema !== "object" ||
      item.ancestors.has(item.schema)
    ) {
      complete = false;
      continue;
    }

    const schema = item.schema as Record<string, unknown>;
    const ancestors = new Set(item.ancestors).add(item.schema);
    let recognized = false;
    if (
      schema.type !== undefined &&
      !(
        (typeof schema.type === "string" &&
          JSON_SCHEMA_TYPES.has(schema.type)) ||
        (Array.isArray(schema.type) &&
          schema.type.length > 0 &&
          schema.type.every(
            (type) =>
              typeof type === "string" && JSON_SCHEMA_TYPES.has(type),
          ))
      )
    ) {
      complete = false;
    }

    if (schema.$ref !== undefined) {
      recognized = true;
      const target =
        typeof schema.$ref === "string"
          ? localSchemaRef(root, schema.$ref)
          : undefined;
      if (target === undefined) complete = false;
      else {
        enqueue({
          schema: target,
          prefix: item.prefix,
          depth: item.depth + 1,
          ancestors,
        });
      }
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const variants = schema[keyword];
      if (!Array.isArray(variants)) continue;
      recognized = true;
      // Combining schemas can close or conditionally expose fields in ways
      // this compact recovery walker intentionally does not prove.
      complete = false;
      for (const variant of variants) {
        if (
          !enqueue({
            schema: variant,
            prefix: item.prefix,
            depth: item.depth + 1,
            ancestors,
          })
        ) {
          break;
        }
      }
    }
    if (truncated) break;

    const properties = schema.properties;
    const propertyRecord =
      properties !== null &&
      typeof properties === "object" &&
      !Array.isArray(properties)
        ? (properties as Record<string, unknown>)
        : undefined;
    if (properties !== undefined && propertyRecord === undefined) {
      complete = false;
    }
    const objectShape =
      hasSchemaType(schema, "object") || propertyRecord !== undefined;
    if (objectShape) {
      recognized = true;
      const patterns = schema.patternProperties;
      let hasPatterns = false;
      if (
        patterns !== undefined &&
        (patterns === null ||
          typeof patterns !== "object" ||
          Array.isArray(patterns))
      ) {
        complete = false;
      } else if (patterns !== undefined) {
        for (const key in patterns as Record<string, unknown>) {
          if (Object.prototype.hasOwnProperty.call(patterns, key)) {
            hasPatterns = true;
            break;
          }
        }
      }
      if (schema.additionalProperties !== false || hasPatterns) {
        complete = false;
      }
      if (propertyRecord) {
        for (const key in propertyRecord) {
          if (!Object.prototype.hasOwnProperty.call(propertyRecord, key)) {
            continue;
          }
          if (++nodes > MAX_PROJECTION_SCHEMA_NODES) {
            complete = false;
            truncated = true;
            break;
          }
          if (!selectableFieldName(key)) {
            complete = false;
            continue;
          }
          const path = item.prefix ? `${item.prefix}.${key}` : key;
          if (!addPath(path)) break;
          const child = propertyRecord[key];
          if (
            !enqueue({
              schema: child,
              prefix: path,
              depth: item.depth + 1,
              ancestors,
            })
          ) {
            break;
          }
        }
      }
    }
    if (truncated) break;

    const arrayShape =
      hasSchemaType(schema, "array") ||
      schema.items !== undefined ||
      schema.prefixItems !== undefined;
    if (arrayShape) {
      recognized = true;
      const arrayPath = `${item.prefix}[]`;
      if (addPath(arrayPath)) {
        if (Array.isArray(schema.prefixItems)) {
          complete = false;
          for (const child of schema.prefixItems) {
            if (
              !enqueue({
                schema: child,
                prefix: arrayPath,
                depth: item.depth + 1,
                ancestors,
              })
            ) {
              break;
            }
          }
        }
        if (schema.items === undefined) {
          if (!Array.isArray(schema.prefixItems)) complete = false;
        } else if (schema.items === true || Array.isArray(schema.items)) {
          complete = false;
          const children = Array.isArray(schema.items)
            ? schema.items
            : [];
          for (const child of children) {
            if (
              !enqueue({
                schema: child,
                prefix: arrayPath,
                depth: item.depth + 1,
                ancestors,
              })
            ) {
              break;
            }
          }
        } else if (schema.items !== false) {
          enqueue({
            schema: schema.items,
            prefix: arrayPath,
            depth: item.depth + 1,
            ancestors,
          });
        }
      }
    }

    const types = Array.isArray(schema.type)
      ? schema.type
      : schema.type === undefined
        ? []
        : [schema.type];
    const primitiveOnly =
      types.length > 0 &&
      types.every(
        (type) =>
          type === "string" ||
          type === "number" ||
          type === "integer" ||
          type === "boolean" ||
          type === "null",
      );
    if (!recognized && !primitiveOnly) complete = false;
    if (truncated) break;
  }

  return {
    paths: [...paths].sort(),
    complete,
    truncated,
  };
}

function schemaProjectionFeedback(
  outputSchema: unknown,
  unmatchedFields: string[],
): Omit<ProjectionFeedback["$connecta"], "type" | "unmatchedFields"> {
  const analysis = analyzeSchemaFields(outputSchema);
  const available = new Set(analysis.paths);
  const invalidFields = analysis.complete
    ? unmatchedFields.filter((field) => !available.has(field))
    : [];
  return {
    schemaDeclared: true,
    schemaCoverage: analysis.complete ? "complete" : "partial",
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    ...(analysis.paths.length > 0
      ? {
          availableFields: analysis.paths.slice(
            0,
            MAX_PROJECTION_AVAILABLE_FIELDS,
          ),
          ...(analysis.truncated ||
          analysis.paths.length > MAX_PROJECTION_AVAILABLE_FIELDS
            ? { availableFieldsTruncated: true as const }
            : {}),
        }
      : {}),
  };
}

/** Select the given dot-paths, retaining both matches and exact misses. */
function applyFields(
  value: unknown,
  fields: string[],
): FieldProjection {
  const out: Record<string, unknown> = {};
  const unmatchedFields: string[] = [];
  for (const path of fields) {
    const resolved = resolvePath(value, path.split("."));
    if (resolved === undefined) unmatchedFields.push(path);
    else out[path] = resolved;
  }
  return { data: out, unmatchedFields };
}

/**
 * Keep the historical flat projection when every path resolves. A miss gets a
 * wrapper with a reserved discriminator so neither `{}` nor downstream fields
 * named `data` / `projection` can be mistaken for projection feedback.
 */
function projectionValue(
  value: unknown,
  fields: string[],
  outputSchema?: unknown,
): Record<string, unknown> | ProjectionFeedback {
  const projected = applyFields(value, fields);
  if (projected.unmatchedFields.length === 0) return projected.data;
  return {
    data: projected.data,
    $connecta: {
      type: "field_projection",
      unmatchedFields: projected.unmatchedFields,
      ...(outputSchema
        ? schemaProjectionFeedback(outputSchema, projected.unmatchedFields)
        : {}),
    },
  };
}

/** Apply fields to each JSON-parseable text block; non-JSON blocks pass through. */
function applyFieldsToContent(
  content: TextContent[],
  fields: string[],
  outputSchema?: unknown,
): TextContent[] {
  return content.map((b) => {
    if (b.type !== "text") return b;
    let parsed: unknown;
    try {
      parsed = JSON.parse(b.text);
    } catch {
      return b;
    }
    return {
      ...b,
      text: JSON.stringify(projectionValue(parsed, fields, outputSchema)),
    };
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
function serializeResultText(value: unknown): string {
  const serialized = JSON.stringify(value);
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

/** Keep an oversized batch's inline outcome summary at fixed string overhead. */
function batchSummaryString(value: string): string {
  const bytes = enc.encode(value);
  const maxBytes = 512;
  if (bytes.length <= maxBytes) return value;
  const end = alignEndToCharBoundary(bytes, 0, maxBytes, bytes.length);
  return `${dec.decode(bytes.slice(0, end))}…`;
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
    text = JSON.stringify(content);
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
type ResultMode = "mcp" | "value";
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
export type BatchCall = CallArgs;
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
 * Every base meta-tool handler over a registry — all nine, whichever surface is
 * advertised, since folding a tool away only skips its registration and never
 * its handler. Exported for direct testing; registerMetaTools() wires the ones
 * this surface advertises onto an McpServer. `opts.defaultToolTimeoutMs`
 * supplies a deadline for calls that don't carry one. (execute_code is
 * registered separately by registerExecuteTool.)
 *
 * Deployment-wide result-size caps are read off the registry view rather than
 * passed in: `ConnectaConfig.calls.maxResultBytes`, its per-connector override,
 * and the independent `calls.maxBatchResultBytes` final-envelope boundary each
 * have one runtime source of truth.
 */
export function createMetaTools(
  registry: RegistryView,
  baseUrl: string,
  opts: {
    /** Deadline applied when a call passes no `timeoutMs`. Off when unset. */
    defaultToolTimeoutMs?: number;
    /** Per-connector deadline for the list/search/describe probe fan-out. Default 30_000. */
    probeTimeoutMs?: number;
    /** Maximum simultaneous connector discovery operations. Default 4. */
    discoveryConcurrency?: number;
    activity?: ActivityRequestContext;
    /** Inbound request cancellation shared by direct and batch child calls. */
    requestSignal?: AbortSignal;
    /** Runtime continuation for the bounded tail of probe-owned teardown. */
    defer?: DeferredWork;
    /**
     * The advertised surface, which the `skills` guidance must match: a
     * code-first deployment never gets guidance naming a tool it does not
     * advertise. Default `classic`.
     */
    surface?: ConnectaSurface;
  } = {},
) {
  const surface: ConnectaSurface = opts.surface ?? "classic";
  // Already normalized and warned about at registry construction.
  const globalCap = registry.maxResultBytes;
  const batchCap = registry.maxBatchResultBytes;
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
  });
  const invocation = new InvocationService(registry, catalog, opts.activity);
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
    timing: InvocationTiming;
    value?: unknown;
    error?: CallErrorDetails;
  }

  interface ProcessedCallResult {
    toolResult: ToolResult;
    value?: unknown;
  }

  /** MCP adapter: shared invocation semantics plus MCP-only result shaping. */
  async function runCall(
    call: BatchCall,
    source: ActivityCallSource,
    options: { allowDestructive?: boolean } = {},
  ): Promise<RunCallOutcome> {
    const results = registry.resultsStorage();
    const fields = call.fields && call.fields.length > 0 ? call.fields : null;
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
          // folded into `globalCap`). Resolved per call so one batch_call can
          // mix a tight-capped connector with siblings on the global cap. An
          // override the registry already warned about at startup is dropped
          // here, so the connector simply inherits `globalCap`.
          const cap = resolveMaxResultBytes(
            resolved.connector.maxResultBytes,
            globalCap,
          );
          if (call.resultMode === "value") {
            let value = fields
              ? projectionValue(
                  result,
                  fields,
                  resolved.definition.outputSchema,
                )
              : result;
            value = await guardValue(value, results, cap);
            return {
              toolResult: jsonResult({ ok: true, data: value }),
              value,
            };
          }
          if (resolved.connector.kind === "mcp") {
            const mcpResult = result as { content?: TextContent[] };
            let content = mcpResult?.content ?? [];
            if (fields) {
              content = applyFieldsToContent(
                content,
                fields,
                resolved.definition.outputSchema,
              );
            }
            return { toolResult: await guardContent(content, results, cap) };
          }
          const value = fields
            ? projectionValue(
                result,
                fields,
                resolved.definition.outputSchema,
              )
            : result;
          return {
            toolResult: await guardText(
              serializeResultText(value),
              results,
              cap,
            ),
            value,
          };
        },
      },
    );
    if (!outcome.ok) {
      const failedResult =
        outcome.error.code === "auth_required" ||
        outcome.error.code === "input_required_unsupported" ||
        call.resultMode === "value"
          ? jsonResult({
              ok: false,
              error: outcome.error,
              durationMs: outcome.durationMs,
              attempts: outcome.attempts,
              ...(call.diagnostics ? { timing: outcome.timing } : {}),
            })
          : errorResult(outcome.error.message);
      if (
        outcome.error.code === "auth_required" ||
        outcome.error.code === "input_required_unsupported"
      ) {
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
                listSkills(connectors, surface)
                  .map((skill) => `- \`${skill.name}\` — ${skill.description}`)
                  .join("\n"),
            },
          ],
        };
      }
      const skill = resolveSkill(args.name, connectors, surface);
      if (!skill.found) return errorResult(skill.message);
      return { content: [{ type: "text", text: skill.content }] };
    },

    async listConnectors(args: ListArgs = {}): Promise<ToolResult> {
      const probe = args.probe ?? true;
      // Live inventory owns a short-lived scope separate from the request's
      // call scope. Closing it cannot defeat call_tool/batch/execute_code reuse.
      const connectors = registry.listConnectors();
      const scope = probe ? {} : requestScope;
      const inspect = async (c: (typeof connectors)[number]) => {
        const statusStarted = Date.now();
        const observed = registry.healthFor(c.id);
        const drift = await registry.credentialDriftFor(c.id);
        let status:
          | ConnectorStatus
          | { state: "ok" | "error" | "unknown"; message?: string };
        if (drift) {
          status = { state: "auth_required", message: drift };
        } else if (probe) {
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
        } else {
          const derived =
            observed?.consecutiveFailures && observed.consecutiveFailures > 0
              ? ("error" as const)
              : registry.hasObservedSuccess(c.id) || c.kind === "api"
                ? ("ok" as const)
                : ("unknown" as const);
          status = {
            state: derived,
            ...(observed?.lastError ? { message: observed.lastError } : {}),
          };
        }
        // Stamped after any live probe so the response reports when its
        // observation completed, not when a potentially slow request began.
        const checkedAt = new Date().toISOString();
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
            } else {
              status = { state: "error" as const, message: msg(err) };
            }
            registry.recordFailure(c.id, Date.now() - statusStarted, err);
          }
        }
        const latencyMs = Date.now() - statusStarted;
        const latestObserved = registry.healthFor(c.id);
        return {
          id: c.id,
          ...(c.title ? { title: c.title } : {}),
          description: c.description,
          toolCount: tools?.length ?? 0,
          status: status.state,
          checkedAt,
          latencyMs,
          probe,
          ...(latestObserved ?? observed),
          ...("authorizationUrl" in status &&
            status.authorizationUrl && {
              authorizationUrl: status.authorizationUrl,
            }),
          ...(status.message && { message: status.message }),
        };
      };
      const settled = await mapSettledWithConcurrency(
        connectors,
        discoveryConcurrency,
        inspect,
      );
      if (probe) {
        await mapSettledWithConcurrency(
          connectors,
          discoveryConcurrency,
          (connector) =>
            closeConnectorScope(
              connector,
              registry.contextFor(connector.id, baseUrl, scope),
              opts.defer,
            ),
        );
      }
      const out = settled.map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      return jsonResult({ connectors: out });
    },

    async searchTools(args: SearchArgs): Promise<ToolResult> {
      return discoveryResult(
        async () =>
          groupedSearchResult(await catalog.search(args)),
        "Request a smaller limit, omit fullDescriptions, or use compact schemas.",
      );
    },

    async describeTools(args: DescribeArgs): Promise<ToolResult> {
      return discoveryResult(
        async () => ({ tools: await catalog.describe(args) }),
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
              ...((c.resultMode ?? args.resultMode) !== undefined
                ? { resultMode: c.resultMode ?? args.resultMode }
                : {}),
              ...((c.timeoutMs ?? args.timeoutMs) !== undefined
                ? { timeoutMs: c.timeoutMs ?? args.timeoutMs }
                : {}),
              ...((c.maxRetries ?? args.maxRetries) !== undefined
                ? { maxRetries: c.maxRetries ?? args.maxRetries }
                : {}),
              ...((c.diagnostics ?? args.diagnostics) !== undefined
                ? { diagnostics: c.diagnostics ?? args.diagnostics }
                : {}),
            },
            "batch_call",
          ),
        ),
      );
      const results = settled.map((s, i) => {
        const call = args.calls[i];
        if (!call) {
          throw new Error("Batch result has no corresponding call");
        }
        const { address } = call;
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
            ...((call.diagnostics ?? args.diagnostics)
              ? { timing: r.timing }
              : {}),
          };
        }
        if ((call.resultMode ?? args.resultMode) === "value") {
          return {
            address,
            ok: true,
            data: r.value,
            durationMs: r.durationMs,
            attempts: r.attempts,
            ...((call.diagnostics ?? args.diagnostics)
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
          ...((call.diagnostics ?? args.diagnostics)
            ? { timing: r.timing }
            : {}),
        };
      });
      const envelope = {
        results,
        durationMs: Date.now() - batchStarted,
      };
      const text = serializeResultText(envelope);
      const bytes = enc.encode(text);
      if (bytes.length <= batchCap) return jsonResult(envelope);

      const notice = await stashResult(
        text,
        registry.resultsStorage(),
        bytes.length,
      );
      return jsonResult({
        results: results.map((result) => {
          const common = {
            address: batchSummaryString(result.address),
            ok: !("error" in result),
            ...("durationMs" in result
              ? { durationMs: result.durationMs }
              : {}),
            ...("attempts" in result ? { attempts: result.attempts } : {}),
            ...("timing" in result ? { timing: result.timing } : {}),
          };
          if (!("error" in result)) return common;
          const error = result.error ?? "Batch call failed";
          const details =
            result.errorDetails ??
            errorDetails("batch_call_failed", error);
          return {
            ...common,
            error: batchSummaryString(error),
            errorDetails: {
              code: batchSummaryString(details.code),
              message: batchSummaryString(details.message),
              retryable: details.retryable,
              ...(details.retryAfterMs !== undefined
                ? { retryAfterMs: details.retryAfterMs }
                : {}),
              ...(details.connector !== undefined
                ? { connector: batchSummaryString(details.connector) }
                : {}),
              ...(details.operation !== undefined
                ? { operation: batchSummaryString(details.operation) }
                : {}),
              ...(details.recovery !== undefined
                ? { recovery: details.recovery }
                : {}),
              ...(details.nextAction !== undefined
                ? { nextAction: details.nextAction }
                : {}),
              ...(details.retry !== undefined
                ? { retry: batchSummaryString(details.retry) }
                : {}),
            },
          };
        }),
        durationMs: envelope.durationMs,
        ...notice,
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
const SEARCH_DESC = `Unknown address: use 2–4 distinctive action/object terms, not the full request; omit limit initially (default ${DEFAULT_SEARCH_LIMIT}) and page only if needed, up to ${MAX_SEARCH_LIMIT}. Partial and no-match searches report term coverage and next-step guidance. includeSchemas="compact" adds the input and any declared output shape; matches also carry declared annotations. Call directly when sufficient. Empty query browses all.`;
const DESCRIBE_DESC = `Only when search_tools omitted schemas, a compact shape is ambiguous, or exact JSON constraints are needed. Inspects up to ${MAX_DESCRIBE_ADDRESSES} addresses with schemas and annotations; "compact" is default, while "json" preserves exact constraints.`;
const CALL_DESC =
  'Use for one tool explicitly annotated readOnlyHint: true. For 2–10 independent read-only calls use batch_call; for dependent steps or data reduction use execute_code when available. Unannotated, write-capable, and destructive tools are refused and require call_destructive_tool. fields selects JSON dot-paths; any misses return data plus `$connecta` field-projection feedback. resultMode "value" unwraps results, timeoutMs sets a deadline, safe maxRetries are annotation-gated, diagnostics adds timing, and large results page through get_result.';
const CALL_DESTRUCTIVE_DESC =
  "Invoke any tool that is not explicitly annotated readOnlyHint: true, including unannotated, write-capable, or destructive tools. The MCP destructiveHint on this meta-tool lets the host request human approval before execution. Use only after reviewing the downstream tool schema and consequences.";
const GET_RESULT_DESC =
  "Page a truncated result stashed by call_tool/batch_call. Input { id, offset?, maxBytes? } → { text, offset, nextOffset?, totalBytes } sliced by byte offset. maxBytes is a whole number of bytes >= 1 (omit for the deployment default) and offset a whole number of bytes >= 0; an offset inside a multi-byte character is moved back to that character's first byte and the offset served is returned. Unknown/expired id is an error.";
const BATCH_DESC =
  "Use for 2–10 independent tools explicitly annotated readOnlyHint: true. Calls run in parallel with shared request-scoped clients; use execute_code when available instead for dependencies or in-sandbox reduction. Unannotated, write-capable, and destructive tools are refused. Batch timeout, safe retry, result mode, and diagnostics defaults may be overridden per call. An oversized final envelope returns ordered outcome summaries plus a get_result page handle.";
const AUTHORIZE_DESC =
  "Use after auth_required. Returns an OAuth or operator-credential handoff, or reports required deployment configuration. force=true restarts OAuth only; this tool never accepts credentials.";
const SKILLS_DESC =
  'List or fetch concise guidance for choosing among Connecta meta-tools. Call skills({ name: "usage" }) once when the routing workflow is unfamiliar; do not refetch it in the same task.';

/**
 * Code-first replacements for the descriptions that route work between tools.
 * Every one of these mentions a tool the consolidated surface removed, so on a
 * code-first deployment the routing sentence has to point at the in-program
 * function that took the work over — a description naming `batch_call` on a
 * surface without one teaches a call that cannot succeed.
 *
 * The classic strings above are left byte-for-byte alone: classic is the
 * compatibility surface and the eval's control arm, and rewording it would
 * change what that control measures.
 */
const CODE_FIRST_SEARCH_DESC = `${SEARCH_DESC} Expand an ambiguous compact shape, or read exact JSON constraints, with connecta.describe inside execute_code.`;
const CODE_FIRST_CALL_DESC =
  'Use for ONE tool explicitly annotated readOnlyHint: true — the cheapest path for a single cold call. For two or more calls, dependent steps, loops, joins, or data reduction use execute_code, whose connecta.call and connecta.batch reach the same tools. Unannotated, write-capable, and destructive tools are refused and require call_destructive_tool. fields selects JSON dot-paths; any misses return data plus `$connecta` field-projection feedback. resultMode "value" unwraps results, timeoutMs sets a deadline, safe maxRetries are annotation-gated, diagnostics adds timing, and large results page through get_result.';
const CODE_FIRST_GET_RESULT_DESC =
  "Page a truncated result stashed by call_tool or call_destructive_tool; a program's oversized return is not paged, so reduce it in code instead. Input { id, offset?, maxBytes? } → { text, offset, nextOffset?, totalBytes } sliced by byte offset. maxBytes is a whole number of bytes >= 1 (omit for the deployment default) and offset a whole number of bytes >= 0; an offset inside a multi-byte character is moved back to that character's first byte and the offset served is returned. Unknown/expired id is an error.";

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

const CALL_INPUT_SCHEMA = {
  address: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  fields: z.array(z.string()).optional(),
  resultMode: z.enum(["mcp", "value"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxRetries: z.number().int().min(0).max(2).optional(),
  diagnostics: z.boolean().optional(),
};

/**
 * Register the base meta-tools onto an McpServer instance: nine on the classic
 * surface, six on the code-first one, where `list_connectors`,
 * `describe_tools`, and `batch_call` have folded into the program surface
 * (`registerExecuteTool` adds the seventh, `execute_code`).
 *
 * Only the registrations differ. Every handler still exists on the object
 * `createMetaTools` returns, and a folded tool's behavior is reached through
 * `connecta.search` / `connecta.describe` / `connecta.batch` inside a program —
 * the same code paths, one layer down.
 */
export function registerMetaTools(
  server: McpServer,
  registry: RegistryView,
  ctx: {
    baseUrl: string;
    defaultToolTimeoutMs?: number;
    probeTimeoutMs?: number;
    discoveryConcurrency?: number;
    activity?: ActivityRequestContext;
    requestSignal?: AbortSignal;
    defer?: DeferredWork;
    /** The advertised surface. Default `classic`. */
    surface?: ConnectaSurface;
  },
): void {
  const surface: ConnectaSurface = ctx.surface ?? "classic";
  const codeFirst = surface === "code-first";
  const mt = createMetaTools(registry, ctx.baseUrl, {
    surface,
    ...(ctx.defaultToolTimeoutMs !== undefined
      ? { defaultToolTimeoutMs: ctx.defaultToolTimeoutMs }
      : {}),
    ...(ctx.probeTimeoutMs !== undefined
      ? { probeTimeoutMs: ctx.probeTimeoutMs }
      : {}),
    ...(ctx.discoveryConcurrency !== undefined
      ? { discoveryConcurrency: ctx.discoveryConcurrency }
      : {}),
    ...(ctx.activity !== undefined ? { activity: ctx.activity } : {}),
    ...(ctx.requestSignal !== undefined
      ? { requestSignal: ctx.requestSignal }
      : {}),
    ...(ctx.defer !== undefined ? { defer: ctx.defer } : {}),
  });

  server.registerTool(
    "skills",
    {
      description: describedFor(registry, SKILLS_DESC, "skills"),
      inputSchema: z.object({ name: z.string().optional() }),
      annotations: READ_ONLY_LOCAL,
    },
    async (args) => mt.skills(args as SkillArgs),
  );

  // Folded on the code-first surface: a program browses the same inventory with
  // connecta.search({}) (every catalog) or connecta.search({ connector }) (one).
  // Live connector probing is an operator concern, not a model one — it stays on
  // the operator pages and /health, which is where the ethos puts observability.
  if (!codeFirst) {
    server.registerTool(
      "list_connectors",
      {
        description: LIST_DESC,
        inputSchema: z.object({ probe: z.boolean().optional() }),
        annotations: READ_ONLY_REMOTE,
      },
      async (args) => mt.listConnectors(args as ListArgs),
    );
  }

  server.registerTool(
    "search_tools",
    {
      description: describedFor(
        registry,
        codeFirst ? CODE_FIRST_SEARCH_DESC : SEARCH_DESC,
        "search",
      ),
      inputSchema: z.object({
        query: z.string().optional(),
        connector: z.string().optional(),
        limit: z.number().int().positive().max(MAX_SEARCH_LIMIT).optional(),
        offset: z.number().int().nonnegative().optional(),
        fullDescriptions: z.boolean().optional(),
        includeSchemas: z.enum(["compact", "json"]).optional(),
      }),
      annotations: READ_ONLY_REMOTE,
    },
    async (args) => mt.searchTools(args as SearchArgs),
  );

  // Folded on the code-first surface: connecta.describe takes the same
  // addresses, format, and per-address error reporting inside a program.
  if (!codeFirst) {
    server.registerTool(
      "describe_tools",
      {
        description: describedFor(registry, DESCRIBE_DESC, "describe"),
        inputSchema: z.object({
          addresses: z.array(z.string()).max(MAX_DESCRIBE_ADDRESSES),
          format: z.enum(["compact", "json"]).optional(),
          fullDescriptions: z.boolean().optional(),
        }),
        annotations: READ_ONLY_REMOTE,
      },
      async (args) => mt.describeTools(args as DescribeArgs),
    );
  }

  server.registerTool(
    "call_tool",
    {
      description: codeFirst ? CODE_FIRST_CALL_DESC : CALL_DESC,
      inputSchema: z.object(CALL_INPUT_SCHEMA),
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
      inputSchema: z.object(CALL_INPUT_SCHEMA),
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
    },
    async (args) => mt.authorizeConnector(args as AuthorizeArgs),
  );

  server.registerTool(
    "get_result",
    {
      description: codeFirst ? CODE_FIRST_GET_RESULT_DESC : GET_RESULT_DESC,
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
    },
    async (args) => mt.getResult(args as GetResultArgs),
  );

  // Folded on the code-first surface: connecta.batch runs the same 1–10
  // parallel read-only calls and returns the same typed per-call outcomes.
  if (!codeFirst) {
    server.registerTool(
      "batch_call",
      {
        description: BATCH_DESC,
        inputSchema: z.object({
          calls: z
            .array(z.object(CALL_INPUT_SCHEMA))
            .min(1)
            .max(10),
          resultMode: z.enum(["mcp", "value"]).optional(),
          timeoutMs: z.number().int().positive().optional(),
          maxRetries: z.number().int().min(0).max(2).optional(),
          diagnostics: z.boolean().optional(),
        }),
        // Same gate as call_tool: every call in the batch must be explicitly
        // read-only or the batch is refused.
        annotations: READ_ONLY_REMOTE,
      },
      async (args) => mt.batchCall(args as BatchArgs),
    );
  }
}
