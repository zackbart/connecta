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
import { resolveDiscoveryConcurrency } from "./concurrency.js";
import type { CallErrorDetails } from "./errors.js";
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

type PathResolution =
  | { status: "matched"; value: unknown }
  | { status: "partial"; value: unknown }
  | { status: "unmatched" };

/** Resolve a dot-path and retain misses below every `[]` boundary. */
function resolvePath(value: unknown, segments: string[]): PathResolution {
  const seg = segments[0];
  if (seg === undefined) {
    return value === undefined
      ? { status: "unmatched" }
      : { status: "matched", value };
  }
  const rest = segments.slice(1);
  const isArr = seg.endsWith("[]");
  const key = isArr ? seg.slice(0, -2) : seg;
  let next: unknown = value;
  if (key !== "") {
    if (value === null || typeof value !== "object") {
      return { status: "unmatched" };
    }
    next = (value as Record<string, unknown>)[key];
  }
  if (isArr) {
    if (!Array.isArray(next)) return { status: "unmatched" };
    if (next.length === 0) return { status: "matched", value: [] };
    const elements = next.map((el) => resolvePath(el, rest));
    const matched = elements.some((element) => element.status !== "unmatched");
    const missed = elements.some((element) => element.status !== "matched");
    if (!matched) return { status: "unmatched" };
    return {
      status: missed ? "partial" : "matched",
      // Undefined placeholders retain the historical array positions in the
      // partial value. JSON renders them as null; partialFields says they are
      // unresolved rather than genuine downstream nulls.
      value: elements.map((element) =>
        element.status === "unmatched" ? undefined : element.value,
      ),
    };
  }
  return resolvePath(next, rest);
}

const MAX_PROJECTION_AVAILABLE_FIELDS = 20;
const MAX_PROJECTION_SCHEMA_DEPTH = 12;
const MAX_PROJECTION_SCHEMA_NODES = 200;
const MAX_PROJECTION_SCHEMA_PATHS = 100;
const MAX_PROJECTION_PATH_CHARS = 256;
const MAX_PROJECTION_PATH_BYTES = 512;
const MAX_PROJECTION_TOTAL_PATH_CHARS = 512;
const MAX_PROJECTION_TOTAL_PATH_BYTES = 768;
const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);
const NON_SEMANTIC_REF_SIBLINGS = new Set([
  "$anchor",
  "$comment",
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "default",
  "definitions",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

interface FieldProjection {
  data: Record<string, unknown>;
  unmatchedFields: string[];
  partialFields: string[];
}

interface ProjectionFeedback {
  data: Record<string, unknown>;
  $connecta: {
    type: "field_projection";
    unmatchedFields: string[];
    partialFields?: string[];
    hint?: string;
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
  let totalPathChars = 0;
  let totalPathBytes = 0;
  let complete = true;
  let truncated = false;

  const addPath = (path: string): boolean => {
    if (paths.has(path)) return true;
    // Check UTF-16 length before encoding, so a hostile multi-megabyte key
    // never causes a same-sized temporary allocation merely to reject it.
    if (
      path.length > MAX_PROJECTION_PATH_CHARS ||
      totalPathChars + path.length > MAX_PROJECTION_TOTAL_PATH_CHARS
    ) {
      complete = false;
      truncated = true;
      return false;
    }
    const pathBytes = enc.encode(path).length;
    if (
      pathBytes > MAX_PROJECTION_PATH_BYTES ||
      totalPathBytes + pathBytes > MAX_PROJECTION_TOTAL_PATH_BYTES ||
      paths.size >= MAX_PROJECTION_SCHEMA_PATHS
    ) {
      complete = false;
      truncated = true;
      return false;
    }
    paths.add(path);
    totalPathChars += path.length;
    totalPathBytes += pathBytes;
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
      let hasSemanticSiblings = false;
      for (const key in schema) {
        if (
          Object.prototype.hasOwnProperty.call(schema, key) &&
          !NON_SEMANTIC_REF_SIBLINGS.has(key)
        ) {
          hasSemanticSiblings = true;
          break;
        }
      }
      if (hasSemanticSiblings) {
        // Modern JSON Schema applies $ref siblings as an intersection. A
        // compact field walker cannot prove that intersection's selectable
        // paths, so do not publish paths from either half as available.
        complete = false;
        continue;
      }
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
          if (key.length > MAX_PROJECTION_PATH_CHARS) {
            complete = false;
            truncated = true;
            break;
          }
          if (!selectableFieldName(key)) {
            complete = false;
            continue;
          }
          const child = propertyRecord[key];
          // A false property schema forbids the property; advertising its name
          // as selectable would turn an impossible value into a valid hint.
          if (child === false) continue;
          const path = item.prefix ? `${item.prefix}.${key}` : key;
          if (!addPath(path)) break;
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
  const missingArrayMarker = unmatchedFields.some((field) =>
    analysis.paths.some(
      (availableField) =>
        availableField.includes("[]") &&
        availableField.replaceAll("[]", "") === field,
    ),
  );
  return {
    ...(missingArrayMarker
      ? {
          hint:
            'Traverse arrays with [] after the array field name, for example "results[].id".',
        }
      : {}),
    schemaDeclared: true,
    schemaCoverage: analysis.complete ? "complete" : "partial",
    ...(invalidFields.length > 0 ? { invalidFields } : {}),
    ...(analysis.paths.length > 0
      ? {
          availableFields: analysis.paths.slice(
            0,
            MAX_PROJECTION_AVAILABLE_FIELDS,
          ),
        }
      : {}),
    ...(analysis.truncated ||
    analysis.paths.length > MAX_PROJECTION_AVAILABLE_FIELDS
      ? { availableFieldsTruncated: true as const }
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
  const partialFields: string[] = [];
  for (const path of fields) {
    const resolved = resolvePath(value, path.split("."));
    if (resolved.status === "unmatched") {
      unmatchedFields.push(path);
    } else {
      out[path] = resolved.value;
      if (resolved.status === "partial") partialFields.push(path);
    }
  }
  return { data: out, unmatchedFields, partialFields };
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
  // `$connecta` is reserved at the top level of a projection. Even a fully
  // matched downstream field with that exact name is escaped below `data`, so
  // no user-controlled value can impersonate Connecta's discriminator.
  const reservedCollision = Object.prototype.hasOwnProperty.call(
    projected.data,
    "$connecta",
  );
  if (
    projected.unmatchedFields.length === 0 &&
    projected.partialFields.length === 0 &&
    !reservedCollision
  ) {
    return projected.data;
  }
  const problemFields = [
    ...projected.unmatchedFields,
    ...projected.partialFields,
  ];
  return {
    data: projected.data,
    $connecta: {
      type: "field_projection",
      unmatchedFields: projected.unmatchedFields,
      ...(projected.partialFields.length > 0
        ? { partialFields: projected.partialFields }
        : {}),
      ...(outputSchema
        ? schemaProjectionFeedback(outputSchema, problemFields)
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
    hint: "use get_result {id, offset} to page, or re-call with fields to select less",
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
  fields?: string[];
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
    defaultToolTimeoutMs?: number;
    /** Per-connector deadline for the search/describe probe fan-out. Default 30_000. */
    probeTimeoutMs?: number;
    /** Maximum simultaneous connector discovery operations. Default 4. */
    discoveryConcurrency?: number;
    activity?: ActivityRequestContext;
    /** Inbound request cancellation shared by every call this request makes. */
    requestSignal?: AbortSignal;
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
          // folded into `globalCap`). Resolved per call so one request can
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
            const guarded = await guardValue(value, results, cap);
            value = guarded.result;
            return {
              toolResult: jsonResult({ ok: true, data: value }),
              value,
              ...(guarded.truncated
                ? { friction: "result_too_large" as const }
                : {}),
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
            const guarded = await guardContent(content, results, cap);
            return {
              toolResult: guarded.result,
              ...(guarded.truncated
                ? { friction: "result_too_large" as const }
                : {}),
            };
          }
          const value = fields
            ? projectionValue(
                result,
                fields,
                resolved.definition.outputSchema,
              )
            : result;
          const guarded = await guardText(
            serializeResultText(value),
            results,
            cap,
          );
          return {
            toolResult: guarded.result,
            value,
            ...(guarded.truncated
              ? { friction: "result_too_large" as const }
              : {}),
          };
        },
        activityFriction: (processed) => processed.friction,
      },
    );
    if (!outcome.ok) {
      const structuredRecovery = outcome.error.nextAction !== undefined;
      const failedResult =
        structuredRecovery ||
        outcome.error.code === "auth_required" ||
        outcome.error.code === "invalid_args" ||
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
        structuredRecovery ||
        outcome.error.code === "auth_required" ||
        outcome.error.code === "invalid_args" ||
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
      // forwards only the call fields, so it never reaches the connector.
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

const SEARCH_DESC = `Use top-level search only for exactly one unreduced read, then call_tool, or for write-capable work, then call_destructive_tool. For read-only reduction, dependent or multiple calls, never search here: make one execute_code program that searches and calls. Use 2–4 distinctive action/object terms, not the full request; set connector to the obvious integration id to load one catalog instead of all; omit limit initially (default ${DEFAULT_SEARCH_LIMIT}), page to ${MAX_SEARCH_LIMIT} if needed. safety="readOnly" returns only calls available to call_tool/code; "approvalRequired" returns the rest; omitted/"all" returns all. This filters results, not authority. includeSchemas="compact" adds the input and any declared output shape, bounded; plain objects expose inputKeys, requiredInputKeys, and outputKeys; truncation flags mark incomplete shapes; matches also carry declared annotations. Require purpose/address fit plus compatible inputs, truncation, safety, and outputs — never the first lexical match. Empty or whitespace-only query browses all; non-empty input with no ASCII terms returns no match.`;
const CALL_DESC =
  'Use for ONE tool explicitly annotated readOnlyHint: true — the cheapest path for a single cold call. For two or more calls, dependent steps, loops, joins, or data reduction use execute_code, whose connecta.call and connecta.batch reach the same tools. Unannotated, write-capable, and destructive tools are refused and require call_destructive_tool. fields selects JSON dot-paths; traverse arrays with [] (for example results[].id). Misses return data plus `$connecta` feedback. resultMode "value" unwraps results, timeoutMs sets a deadline, safe maxRetries are annotation-gated, diagnostics adds timing, and large results page through get_result.';
const CALL_DESTRUCTIVE_DESC =
  "Invoke any tool that is not explicitly annotated readOnlyHint: true, including unannotated, write-capable, or destructive tools. Include a short reason explaining the intended consequence for the human reviewer; it grants no authority and is never passed downstream. The MCP destructiveHint on this meta-tool lets the host request human approval before execution. Use only after reviewing the downstream tool schema and consequences.";
const GET_RESULT_DESC =
  "Page a truncated result stashed by call_tool or call_destructive_tool; a program's oversized return is not paged, so reduce it in code instead. Input { id, offset?, maxBytes? } → { text, offset, nextOffset?, totalBytes } sliced by byte offset. maxBytes is a whole number of bytes >= 1 (omit for the deployment default) and offset a whole number of bytes >= 0; an offset inside a multi-byte character is moved back to that character's first byte and the offset served is returned. Unknown/expired id is an error.";
const AUTHORIZE_DESC =
  "Use after auth_required. Returns an OAuth or operator-credential handoff, or reports required deployment configuration. force=true restarts OAuth only; this tool never accepts credentials.";
const SKILLS_DESC =
  'List or fetch concise guidance for choosing among Connecta meta-tools. Call skills({ name: "usage" }) once when the routing workflow is unfamiliar; do not refetch it in the same task.';

const SEARCH_WITH_DESCRIBE_DESC = `${SEARCH_DESC} Expand an ambiguous compact shape, or read exact JSON constraints, with connecta.describe inside execute_code.`;

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
    " skills({}) also lists this deployment's scoped connector guides; fetch only an exact name listed there or carried by discovery, never one inferred from a connector id.",
  search:
    " A result carrying `guide` also carries a bounded `guideSummary`. `guideRequired: true` is a hard stop: fetch that exact guide before calling. `guideRequiredReasons` explains why — `connector_required` and `approval_required` stand however you expand the schema; `schema_truncated` clears once describe returns the exact one. Otherwise fetch only when the summary names a connector convention relevant to the task. A complete, unambiguous read-only schema needs no otherwise-irrelevant guide fetch.",
  destructive:
    " Before a consequential call, inspect the address through discovery or describe and fetch any connector guide it names.",
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
    defaultToolTimeoutMs?: number;
    probeTimeoutMs?: number;
    discoveryConcurrency?: number;
    activity?: ActivityRequestContext;
    requestSignal?: AbortSignal;
  },
): void {
  const mt = createMetaTools(registry, ctx.baseUrl, {
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
        SEARCH_WITH_DESCRIBE_DESC,
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
      // The trusted program-view shell delegates bounded named reads here.
      // It is already one of the seven model tools; app visibility adds no
      // tool and this handler repeats ordinary fail-closed read admission.
      _meta: { ui: { visibility: ["model", "app"] } },
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
