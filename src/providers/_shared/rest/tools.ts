// Connecta's generic REST connector over one vendor's pinned operation index.
//
// `restTools(vendor)` returns four tools named `<vendor>_api_search`,
// `_api_details`, `_api_read`, and `_api_write`. The first two read the index
// and send nothing. `_api_read` sends GET, plus the vendor's reviewed
// read-only POSTs; classification is per tool name, so that rule is enforced
// here in the handler, not inferred. `_api_write` sends every other method and
// is always destructive, with `method` and `path` top-level arguments so a
// host's approval prompt shows them.
//
// Every call is matched to an operation and checked against its contract
// before transport (unknown path → nearest operations; unknown or missing
// parameters → `validation.issues`), then the vendor's reviewed refusals run,
// then the vendor frames the request. Every vendor answers in one envelope:
// `{ status, data, page?: { hasMore, next?, param? } }`, with an optional
// `select` projection and no default projection. A write is dispatched once
// (INV-9): nothing here retries it or replays it against another
// implementation.
//
// A vendor adopts this module with configuration only: its transport, its
// failure mapper, and optional `scope` (defaults and pins), `encode` (body
// and query framing), `page` (cursor extraction), `refuse` (safety tables),
// `readPosts`, and an idempotency header. Named tools reuse `restCall` and
// `callRest` to share the same validation-free request path.
import type { ApiTool } from "../../../connectors/api-connector.js";
import {
  guardedFetch,
  type GuardedFetchOptions,
  type GuardedRequest,
  type GuardedTransport,
} from "../../../connectors/guarded-fetch.js";
import { recordRecovery } from "../../../call-recovery.js";
import { ConnectorCallError, unavailableCallError } from "../../../errors.js";
import type { ConnectorContext, JsonSchema } from "../../../types.js";
import type { Operation, OperationIndex, RestMethod } from "./operation-index.js";

/** One call matched to its operation, after the vendor's defaults and pins. */
export interface RestCall {
  readonly method: RestMethod;
  /** The concrete path the caller named. */
  readonly path: string;
  readonly op: Operation;
  /** Path parameter values by template name. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly body: unknown;
}

/** How the vendor frames one call on the wire. */
export interface RestFraming {
  query?: GuardedRequest["query"];
  /** A JSON body; exclusive with `rawBody`. */
  body?: unknown;
  /** A pre-framed body, such as a form-encoded string, with its own `Content-Type` header. */
  rawBody?: BodyInit;
  headers?: Record<string, string | undefined>;
}

/** The cursor for the next page: pass `next` back as the `param` query parameter. */
export interface RestPage {
  hasMore: boolean;
  next?: string;
  param?: string;
}

export interface RestResult {
  status: number;
  data: unknown;
  page?: RestPage;
}

/** A reviewed POST that only reads: `[method, path template, reason]`. */
export type RestReadPost = readonly [method: RestMethod, path: string, reason: string];

export interface RestVendor {
  /** Lowercase tool-name prefix: `${vendor}_api_search` and so on. */
  readonly vendor: string;
  /** Display name in descriptions and refusals. */
  readonly title: string;
  readonly index: OperationIndex;
  /**
   * The transport for an operation's server (`undefined` is the default
   * origin), or a refusal that says where to go instead.
   */
  transport(server: string | undefined): GuardedTransport | string;
  /** Map a failed response to what the caller does next (H11). */
  failure(status: number, headers: Headers, body: unknown): ConnectorCallError;
  /** Reviewed POSTs that only read; `_api_read` admits exactly these. */
  readonly readPosts?: readonly RestReadPost[];
  /** Reviewed safety refusals: return the reason to refuse, before any request. */
  refuse?(call: RestCall): string | undefined;
  /** Apply configured defaults and enforce pins; throw to refuse. */
  scope?(call: RestCall): RestCall;
  /** Frame the request. Defaults to scalar query values and a JSON body. */
  encode?(call: RestCall): RestFraming;
  /** Read the next-page cursor from a successful body. */
  page?(data: unknown, call: RestCall): RestPage | undefined;
  /** A header write tools fill with a caller key or a generated one, and return. */
  readonly idempotencyHeader?: string;
  /** Where multipart or binary uploads go instead of `_api_write`. */
  readonly upload?: string;
  /** One clause on how `_api_write` frames bodies, for its schema. */
  readonly bodyHint?: string;
}

const READ = { readOnlyHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
const MAX_SELECT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}

/**
 * A guarded transport whose requests, response bodies included, end after
 * `timeoutMs`: a stream the vendor never closes cannot hold a call open past
 * it. The request's own signal still cancels first.
 */
export function restTransport(options: Omit<GuardedFetchOptions, "fetch"> & { timeoutMs: number }): GuardedTransport {
  const { timeoutMs, ...rest } = options;
  return guardedFetch({
    ...rest,
    fetch: (url, init) => {
      const cap = AbortSignal.timeout(timeoutMs);
      return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, cap]) : cap });
    },
  });
}

/** Match a call to its operation and apply the vendor's defaults and pins. */
export function restCall(
  vendor: RestVendor,
  method: RestMethod,
  path: string,
  input: { query?: Readonly<Record<string, unknown>>; body?: unknown } = {},
): RestCall {
  const { op, params } = vendor.index.resolve(method, path);
  const call: RestCall = { method: op.method, path, op, params, query: input.query ?? {}, body: input.body };
  return vendor.scope ? vendor.scope(call) : call;
}

function defaultFraming(vendor: RestVendor, call: RestCall): RestFraming {
  const query: NonNullable<GuardedRequest["query"]> = {};
  for (const [name, value] of Object.entries(call.query)) {
    if (value === undefined) continue;
    const scalar = (item: unknown): item is string | number | boolean =>
      typeof item === "string" || typeof item === "number" || typeof item === "boolean";
    if (scalar(value) || (Array.isArray(value) && value.every(scalar))) query[name] = value;
    else invalid(`${vendor.title} query parameter ${name} takes a string, number, boolean, or a list of them.`);
  }
  return { query, ...(call.body !== undefined ? { body: call.body } : {}) };
}

async function failureBody(response: Parameters<Parameters<GuardedTransport>[2]>[0]): Promise<unknown> {
  try {
    const parsed = await response.jsonResult();
    return "value" in parsed ? parsed.value : undefined;
  } catch {
    // An unreadable or oversized error body still has a status to map.
    return undefined;
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function successBody(
  vendor: RestVendor,
  response: Parameters<Parameters<GuardedTransport>[2]>[0],
  ctx: ConnectorContext,
): Promise<unknown> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (/\b(?:x-ndjson|jsonl|stream\+json)\b/.test(type)) {
      return (await response.text())
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { line };
          }
        });
    }
    if (/\bjson\b|\+json\b/.test(type)) {
      // Read, then parse: a read that times out must not pass for malformed JSON.
      const body = await response.text();
      if (body.trim() === "") return null;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new ConnectorCallError("connector_call_failed", `${vendor.title} returned malformed JSON.`, {
          retryable: false,
        });
      }
    }
    if (type === "" || /^text\/|\bxml\b|\bcsv\b/.test(type)) {
      const text = await response.text();
      return text === "" ? null : text;
    }
    const bytes = await response.bytes();
    return bytes.length === 0 ? null : { contentType: type, bytes: bytes.length, base64: base64(bytes) };
  } catch (error) {
    if (error instanceof ConnectorCallError) throw error;
    if (ctx.signal?.aborted === true && error === ctx.signal.reason) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ConnectorCallError("unavailable", `${vendor.title} did not finish its response within the read cap.`, {
        details: { code: "timeout" },
      });
    }
    // The request was sent and the status arrived; only the body was lost. Told
    // in Connecta's words (the runtime's can quote the transport), never raw.
    // `callRest` decides whether that is safe to repeat.
    throw unavailableCallError(error, undefined, `${vendor.title} answered, but its response could not be read.`);
  }
}

/**
 * Network failures that prove nothing was sent: no connection was ever
 * established, so the vendor cannot have acted. Anything else after dispatch
 * (a reset, a 5xx, a lost body) may follow a write that landed.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
]);

/**
 * A request that is not safe to repeat (a write without an idempotency key)
 * must never be advertised as retryable after it may have reached the vendor
 * (INV-9). Definite answers pass through: refusals and 4xx verdicts, a failure
 * proven to precede any connection, and timeouts, which the invocation layer
 * already reports as `write_outcome_unknown`.
 */
function unknownOutcome(vendor: RestVendor, error: unknown): unknown {
  if (!(error instanceof ConnectorCallError) || error.code !== "unavailable" || !error.retryable) return error;
  const code = error.details?.code;
  if (code === "timeout" || (code !== undefined && NEVER_CONNECTED.has(code))) return error;
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.title} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false },
  );
}

/**
 * Send one prepared call and read it into the envelope. No validation and no
 * refusal tables run here: the generic tools do both first, and named tools
 * build their calls from fixed operations. `visibleHeaders` carry values the
 * result returns to the caller, such as an idempotency key.
 */
export async function callRest(
  vendor: RestVendor,
  call: RestCall,
  ctx: ConnectorContext,
  visibleHeaders: Record<string, string> = {},
): Promise<RestResult> {
  const send = vendor.transport(call.op.server);
  if (typeof send === "string") invalid(send);
  const framing = vendor.encode ? vendor.encode(call) : defaultFraming(vendor, call);
  // Safe to repeat: a read, or a write that carried the vendor's idempotency key.
  const header = vendor.idempotencyHeader?.toLowerCase();
  const repeatable =
    call.method === "GET" ||
    call.method === "HEAD" ||
    (vendor.readPosts ?? []).some(([method, path]) => method === call.method && path === call.op.path) ||
    (header !== undefined && Object.keys(visibleHeaders).some((name) => name.toLowerCase() === header));
  const request: GuardedRequest = {
    method: call.method,
    path: call.path,
    ...(framing.query ? { query: framing.query } : {}),
    ...(framing.headers ? { headers: framing.headers } : {}),
    visibleHeaders,
    ...(framing.rawBody !== undefined
      ? { rawBody: framing.rawBody }
      : framing.body !== undefined
        ? { body: framing.body }
        : {}),
  };
  try {
    return await send(request, ctx, async (response) => {
      if (!response.ok) throw vendor.failure(response.status, response.headers, await failureBody(response));
      // HEAD answers with headers alone; they are its data.
      const data = call.method === "HEAD" ? headerData(response.headers) : await successBody(vendor, response, ctx);
      const page = vendor.page?.(data, call);
      return { status: response.status, data, ...(page ? { page } : {}) };
    });
  } catch (error) {
    // The whole transport call: connect/send failures, 5xx, and a lost body alike.
    throw repeatable ? error : unknownOutcome(vendor, error);
  }
}

/** A HEAD response's headers as data, without cookies. */
function headerData(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (name !== "set-cookie") out[name] = value;
  });
  return out;
}

/** Keep only the named dot paths; a path through an array applies to each item. */
function project(value: unknown, paths: readonly string[]): unknown {
  type Tree = Map<string, Tree | true>;
  const root: Tree = new Map();
  for (const path of paths) {
    let node = root;
    const parts = path.split(".");
    for (const [index, part] of parts.entries()) {
      const existing = node.get(part);
      // A shorter path already keeps this whole subtree.
      if (existing === true) break;
      if (index === parts.length - 1) {
        node.set(part, true);
        break;
      }
      const next: Tree = existing ?? new Map();
      node.set(part, next);
      node = next;
    }
  }
  const pick = (current: unknown, tree: Tree): unknown => {
    if (Array.isArray(current)) return current.map((item) => pick(item, tree));
    if (!isRecord(current)) return current;
    const out: Record<string, unknown> = {};
    for (const [key, child] of tree) {
      if (!Object.hasOwn(current, key)) continue;
      out[key] = child === true ? current[key] : pick(current[key], child);
    }
    return out;
  };
  return pick(value, root);
}

function selected(args: Record<string, unknown>, result: RestResult): RestResult {
  const select = args["select"];
  if (!Array.isArray(select) || select.length === 0) return result;
  return { ...result, data: project(result.data, select as string[]) };
}

const PATH: JsonSchema = {
  type: "string",
  minLength: 2,
  maxLength: 2048,
  description: "Concrete path from search with ids filled in, e.g. /v1/customers/cus_123. No query string.",
};

const QUERY: JsonSchema = {
  type: "object",
  description: "Query parameters as JSON, named as details lists them.",
};

const SELECT: JsonSchema = {
  type: "array",
  maxItems: MAX_SELECT,
  items: { type: "string", minLength: 1, maxLength: 200 },
  description: "Dot paths to keep from data, e.g. data.id; a path through a list applies to each item.",
};

const PAGE: JsonSchema = {
  type: "object",
  description: "Present on lists: pass next as the param query parameter for the following page.",
  properties: { hasMore: { type: "boolean" }, next: { type: "string" }, param: { type: "string" } },
  required: ["hasMore"],
};

function envelope(extra: Record<string, JsonSchema> = {}): JsonSchema {
  return {
    type: "object",
    properties: {
      status: { type: "integer", description: "HTTP status." },
      data: {
        description: "Response body: JSON, text, NDJSON rows, { contentType, bytes, base64 }, or HEAD's headers.",
      },
      page: PAGE,
      ...extra,
    },
    required: ["status", "data"],
  };
}

function closed(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

/** The four generic tools over one vendor's index. */
export function restTools(vendor: RestVendor): ApiTool[] {
  const { index, title } = vendor;
  const tool = (kind: string) => `${vendor.vendor}_api_${kind}`;
  const readPosts = vendor.readPosts ?? [];
  for (const [method, path] of readPosts) {
    // A reviewed exception the index no longer carries is a stale review.
    if (!index.operation(method, path)) {
      throw new Error(`${title} reviewed read-only ${method} ${path} is not in the pinned API index.`);
    }
  }
  const reads = (op: Operation): boolean =>
    op.method === "GET" ||
    op.method === "HEAD" ||
    readPosts.some(([method, path]) => method === op.method && path === op.path);
  const writeMethods = index.methods.filter((method) => method !== "GET" && method !== "HEAD");
  const head = index.methods.includes("HEAD");
  const readMethods = [...new Set(["GET", ...(head ? ["HEAD"] : []), ...readPosts.map(([method]) => method)])];
  const routeOf = (op: Operation) => (reads(op) ? tool("read") : tool("write"));

  // An unreachable host and a reviewed refusal are answered before argument
  // checks: no corrected argument would make either call go through.
  const guard = (call: RestCall): void => {
    const send = vendor.transport(call.op.server);
    if (typeof send === "string") invalid(send);
    const refusal = vendor.refuse?.(call);
    if (refusal) invalid(refusal);
  };

  return [
    {
      name: tool("search"),
      description: `Find ${title} API operations by keyword or path in the pinned API index. Returns method, path, and summary; reads no account data.`,
      annotations: READ,
      inputSchema: closed(
        {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Keywords or a path, e.g. refund charge.",
          },
          method: { type: "string", enum: [...index.methods], description: "Only operations with this method." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Most operations to return; default 10." },
        },
        ["query"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                method: { type: "string" },
                path: { type: "string" },
                summary: { type: "string" },
                tool: { type: "string", description: "The tool that calls it." },
              },
              required: ["method", "path", "tool"],
            },
          },
          revision: { type: "string", description: "Pinned index revision." },
        },
        required: ["operations", "revision"],
      },
      handler: (args: Record<string, unknown>) => ({
        operations: index
          .search(String(args["query"]), {
            ...(typeof args["method"] === "string" ? { method: args["method"] as RestMethod } : {}),
            limit: typeof args["limit"] === "number" ? args["limit"] : 10,
          })
          .map((op) => ({
            method: op.method,
            path: op.path,
            operationId: op.operationId,
            summary: op.summary,
            tag: op.tag,
            tool: routeOf(op),
          })),
        revision: index.revision,
      }),
    },
    {
      name: tool("details"),
      description: `Read one ${title} API operation's request contract: path, query, and body parameters with types, enums, and required names. Reads no account data.`,
      annotations: READ,
      inputSchema: closed(
        {
          method: { type: "string", enum: [...index.methods], description: "The operation's HTTP method." },
          path: { ...PATH, description: "The path template from search, or a concrete path." },
          param: { type: "string", minLength: 1, maxLength: 200, description: "Return only this parameter." },
        },
        ["method", "path"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          method: { type: "string" },
          path: { type: "string" },
          tool: { type: "string", description: "The tool that calls it." },
          parameters: { type: "array", description: "Path and query parameters." },
          body: {
            type: "object",
            description: "Body content type and schema; truncated: true marks unexpanded levels.",
          },
          revision: { type: "string" },
        },
        required: ["method", "path", "tool", "parameters", "revision"],
      },
      handler: (args: Record<string, unknown>) => {
        const method = String(args["method"]);
        const path = String(args["path"]);
        const op = index.operation(method, path) ?? index.resolve(method, path).op;
        return {
          ...index.contract(op, typeof args["param"] === "string" ? args["param"] : undefined),
          tool: routeOf(op),
          revision: index.revision,
        };
      },
    },
    {
      name: tool("read"),
      description:
        `Call a ${title} API GET${head ? " or HEAD" : ""} operation${readPosts.length ? ", or a reviewed read-only POST" : ""}. ` +
        "Arguments are checked against the pinned index before anything is sent.",
      annotations: READ,
      inputSchema: closed(
        {
          path: PATH,
          ...(readMethods.length > 1
            ? {
                method: {
                  type: "string",
                  enum: readMethods,
                  description: "GET by default; another method only for an operation search routes here.",
                },
              }
            : {}),
          ...(readPosts.length ? { body: { type: "object", description: "Body for a reviewed read-only POST." } } : {}),
          query: QUERY,
          select: SELECT,
        },
        ["path"],
      ),
      outputSchema: envelope(),
      handler: async (args: Record<string, unknown>, ctx: ConnectorContext) => {
        const method = (typeof args["method"] === "string" ? args["method"] : "GET") as RestMethod;
        const call = restCall(vendor, method, String(args["path"]), {
          query: isRecord(args["query"]) ? args["query"] : {},
          body: args["body"],
        });
        if (!reads(call.op)) {
          invalid(`${call.method} ${call.op.path} is not a reviewed read; call it with ${tool("write")}.`);
        }
        if ((call.method === "GET" || call.method === "HEAD") && call.body !== undefined) {
          invalid(`A ${call.method} operation takes query, not body.`);
        }
        guard(call);
        index.check(call.op, call.query, call.body);
        return selected(args, await callRest(vendor, call, ctx));
      },
    },
    {
      name: tool("write"),
      description:
        `Call a ${title} API write (${writeMethods.join(", ")}); method and path are stated for approval. ` +
        `Checked against the pinned index first.${vendor.idempotencyHeader ? " Pass idempotencyKey to retry safely." : ""}`,
      annotations: DESTRUCTIVE,
      inputSchema: closed(
        {
          method: { type: "string", enum: writeMethods, description: "The operation's HTTP method." },
          path: PATH,
          query: QUERY,
          body: {
            type: ["object", "array"],
            description: `Request body as JSON${vendor.bodyHint ? `; ${vendor.bodyHint}` : ""}.`,
          },
          ...(vendor.idempotencyHeader
            ? {
                idempotencyKey: {
                  type: "string",
                  minLength: 1,
                  maxLength: 255,
                  description: "Reuse to retry this exact write; one is generated and returned when omitted.",
                },
              }
            : {}),
          select: SELECT,
        },
        ["method", "path"],
      ),
      outputSchema: envelope(
        vendor.idempotencyHeader
          ? {
              idempotencyKey: {
                type: "string",
                description: "The key sent; reuse it, with the same arguments, while the vendor retains it.",
              },
            }
          : {},
      ),
      handler: async (args: Record<string, unknown>, ctx: ConnectorContext) => {
        const call = restCall(vendor, args["method"] as RestMethod, String(args["path"]), {
          query: isRecord(args["query"]) ? args["query"] : {},
          body: args["body"],
        });
        if (call.method === "GET" || call.method === "HEAD") {
          invalid(`${call.method} operations are reads; call them with ${tool("read")}.`);
        }
        guard(call);
        const framing = index.bodyType(call.op);
        if (framing && /^multipart\/|octet-stream/.test(framing)) {
          invalid(
            `${call.method} ${call.op.path} takes a ${framing} upload, which ${tool("write")} does not send.` +
              (vendor.upload ? ` ${vendor.upload}` : ""),
          );
        }
        index.check(call.op, call.query, call.body);
        const header = vendor.idempotencyHeader && call.method !== "DELETE" ? vendor.idempotencyHeader : undefined;
        const given = typeof args["idempotencyKey"] === "string" ? args["idempotencyKey"] : undefined;
        const key = header ? (given ?? crypto.randomUUID()) : undefined;
        // Recorded before dispatch: if the invocation deadline interrupts this
        // call, no failure of ours arrives, and the invocation returns the key
        // from here with write_outcome_unknown.
        if (key) recordRecovery(ctx, { idempotencyKey: key });
        try {
          const result = await callRest(vendor, call, ctx, header && key ? { [header]: key } : {});
          return { ...selected(args, result), ...(key ? { idempotencyKey: key } : {}) };
        } catch (error) {
          // A generated key exists nowhere else, so a failure must carry it:
          // only that key lets the caller check or retry this exact write.
          if (!key || given || !(error instanceof ConnectorCallError)) throw error;
          throw new ConnectorCallError(
            error.code,
            `${error.message} ${header}: ${key}. Reusing it with the exact original arguments retries this write ` +
              "without repeating it only while the vendor retains the key; after that, look the object up before retrying.",
            {
              retryable: error.retryable,
              ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
              ...(error.validation ? { validation: error.validation } : {}),
              ...(error.repair ? { repair: error.repair } : {}),
              ...(error.details ? { details: error.details } : {}),
            },
          );
        }
      },
    },
  ];
}
