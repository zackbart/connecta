// Step-1 REST bridge: pinned contracts and legacy hatch bytes on the provider kit.
// The index remains the hatch validator; every network answer comes from Connection.
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../../connectors/api-connector.js";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "../../../call-recovery.js";
import { ConnectorCallError, keyResendAdvice } from "../../../errors.js";
import { providerFailureMessage } from "../../../write-outcome.js";
import type { JsonSchema } from "../../../types.js";
import { Refusal, toConnectorCallError, type HttpFailure } from "../../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
import {
  Classification,
  Dispatches,
  IdempotencyKey,
  Recovery,
  Signal,
  type CallServices,
} from "../../../http/services.js";
import { read, write } from "../../../http/tools.js";
import {
  vendor as declareVendor,
  get,
  head,
  post,
  put,
  patch,
  del,
  type Vendor,
  type Operation as KitOperation,
  type Connection,
} from "../../../http/vendor.js";
import type { Operation, OperationIndex, RestMethod } from "./operation-index.js";
import type { RestCall, RestResult, RestVendor } from "./tools.js";

type Json = Record<string, unknown>;
const MAX_SELECT = 50;
const READ = { readOnlyHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true } as const;
function isRecord(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid(message: string): never {
  throw new ConnectorCallError("invalid_args", message);
}
export function checked<A>(run: () => A): Effect.Effect<A, Refusal> {
  return Effect.try({ try: run, catch: (error) => error }).pipe(
    Effect.catch((error) =>
      error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
    ),
  );
}

/** Index matches retain encoded segments; HttpApiClient uses encodeURIComponent. */
export function typedParams(params: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).map(([name, encoded]) => {
      let value: string;
      try {
        value = decodeURIComponent(encoded);
      } catch {
        return invalid(`Indexed path parameter ${name} is not valid URI encoding.`);
      }
      if (encodeURIComponent(value) !== encoded)
        invalid(`Indexed path parameter ${name} does not round-trip through the typed path encoder.`);
      return [name, value];
    }),
  );
}

/** Only the JSON forms the pinned index and legacy hatch catalogs publish. No vendor encoders run here. */
export function schema(node: JsonSchema): Schema.Codec<unknown> {
  const n = node as Json;
  let out: Schema.Codec<unknown>;
  const types = n["type"];
  if (n["truncated"] === true) out = Schema.Unknown;
  else if (Array.isArray(n["enum"])) out = Schema.Literals(n["enum"] as [string, ...string[]]);
  else if (Array.isArray(n["anyOf"])) out = Schema.Union(n["anyOf"].map((v) => schema(v as JsonSchema)));
  else if (Array.isArray(types))
    out = Schema.Union(types.map((type) => schema({ ...n, type, description: undefined } as JsonSchema)));
  else if (types === "object" || isRecord(n["properties"])) {
    const required = n["required"] as string[] | undefined;
    const fields = Object.fromEntries(
      Object.entries((n["properties"] ?? {}) as Json).map(([key, value]) => {
        const part = schema(value as JsonSchema);
        const annotated =
          part.ast._tag === "Unknown" && isRecord(value) && typeof value["description"] === "string"
            ? part.pipe(Schema.annotateKey({ description: value["description"] }))
            : part;
        return [key, required?.includes(key) ? annotated : Schema.optionalKey(annotated)];
      }),
    );
    out =
      n["properties"] && n["additionalProperties"] !== true
        ? Schema.Struct(fields)
        : Schema.StructWithRest(Schema.Struct(fields), [
            Schema.Record(
              Schema.String,
              isRecord(n["additionalProperties"]) ? schema(n["additionalProperties"] as JsonSchema) : Schema.Unknown,
            ),
          ]);
  } else if (types === "array") {
    let array = Schema.Array(schema((n["items"] ?? {}) as JsonSchema));
    if (typeof n["minItems"] === "number") array = array.check(Schema.isMinLength(n["minItems"]));
    if (typeof n["maxItems"] === "number") array = array.check(Schema.isMaxLength(n["maxItems"]));
    if (n["uniqueItems"] === true) array = array.check(Schema.isUnique());
    out = array;
  } else if (types === "string") {
    let string = Schema.String;
    if (typeof n["minLength"] === "number") string = string.check(isMinChars(n["minLength"]));
    if (typeof n["maxLength"] === "number") string = string.check(isMaxChars(n["maxLength"]));
    out = string;
  } else if (types === "integer" || types === "number") {
    let number = types === "integer" ? Integer : Schema.Finite;
    if (typeof n["minimum"] === "number") number = number.check(Schema.isGreaterThanOrEqualTo(n["minimum"]));
    if (typeof n["maximum"] === "number") number = number.check(Schema.isLessThanOrEqualTo(n["maximum"]));
    out = number;
  } else out = types === "boolean" ? Schema.Boolean : types === "null" ? Schema.Null : Schema.Unknown;
  if (n["nullable"] === true) out = Schema.Union([out, Schema.Null]);
  return typeof n["description"] === "string" ? out.annotate({ description: n["description"] }) : out;
}

/** Declare each indexed operation once; request schema subtrees stay suspended until manifest/client use. */
export function indexedVendor(name: string, index: OperationIndex, named: readonly KitOperation[] = []): Vendor {
  const constructors = { GET: get, HEAD: head, POST: post, PUT: put, PATCH: patch, DELETE: del };
  const overrides = new Map(
    named.map((op) => {
      const declared = op as unknown as { method: string; path: string };
      return [`${declared.method} ${declared.path.replace(/:([^/]+)/g, "{$1}")}`, op];
    }),
  );
  for (const key of overrides.keys())
    if (!index.ops.some((op) => `${op.method} ${op.path}` === key))
      throw new Error(`Named operation ${key} is absent from the pinned index.`);
  const cache = new Map<string, ReturnType<typeof schema>>();
  const cached = (node: JsonSchema) => {
    const key = JSON.stringify(node);
    let found = cache.get(key);
    if (!found) {
      found = schema(node);
      cache.set(key, found);
    }
    return found;
  };
  const build = () => {
    const endpoints = index.ops.map(
      (op) =>
        overrides.get(`${op.method} ${op.path}`) ??
        (constructors[op.method] as typeof post)(
          "indexed" + op.row,
          op.path.replace(/\{([^}]+)\}/g, ":$1") as `/${string}`,
          {
            // Parameter names come directly from the vendor template; hatch validation still uses index.check.
            params: Schema.Struct(
              Object.fromEntries([...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1]!, Schema.String])),
            ),
            query: Schema.suspend(() => {
              const parameters = index.contract(op).parameters.filter((p) => p.in === "query");
              return Schema.Struct(
                Object.fromEntries(
                  parameters.map((p) => [p.name, p.required ? cached(p.schema) : Schema.optionalKey(cached(p.schema))]),
                ),
              );
            }),
            ...(op.method === "GET" || op.method === "HEAD"
              ? {}
              : { payload: Schema.suspend(() => cached(index.contract(op).body?.schema ?? {})) }),
            success: Schema.Unknown,
          },
        ),
    );
    if (!endpoints.length) throw new Error("An indexed vendor needs operations.");
    return declareVendor(name, endpoints[0]!, ...endpoints.slice(1)).api;
  };
  if (!named.length) throw new Error("An indexed vendor declares at least its typed credential probe.");
  let built: Vendor["api"] | undefined;
  return {
    ...declareVendor(name, named[0]!, ...named.slice(1)),
    indexed: { operations: index.ops.map((op) => `${op.method} ${op.path}`).sort(), api: () => (built ??= build()) },
  };
}

export interface RestKitOptions extends Pick<
  RestVendor,
  | "vendor"
  | "title"
  | "index"
  | "valueSafety"
  | "readPosts"
  | "headers"
  | "textBodies"
  | "pathExample"
  | "path"
  | "scope"
  | "refuse"
  | "upload"
  | "bodyHint"
  | "idempotencyHeader"
> {
  readonly connection: Connection;
  /** Origin refusals precede argument repair, just as on the legacy hatch. */
  readonly checkServer?: (server: string | undefined) => string | undefined;
  readonly send: (call: RestCall) => Effect.Effect<RestResult, HttpFailure, CallServices>;
}

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

function pathSchema(example = "/v1/customers/cus_123"): JsonSchema {
  return {
    type: "string",
    minLength: 2,
    maxLength: 2048,
    description: `Concrete path from search with ids filled in, e.g. ${example}. No query string.`,
  };
}

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
  description:
    "Present on lists: pass next as the param query parameter (a body field when in is body) for the next page. hasMore without next: no cursor exists.",
  properties: {
    hasMore: { type: "boolean" },
    next: { type: "string" },
    param: { type: "string" },
    in: { type: "string", enum: ["query", "body"] },
    path: { type: "string", description: "GET this path for the next page, when it differs from this call's." },
  },
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

/** Restore declaration key order only after proving the kit generated the identical schema. */
export function catalogOrder(actual: unknown, legacy: unknown): unknown {
  if (Array.isArray(legacy)) {
    if (!Array.isArray(actual) || actual.length !== legacy.length)
      throw new Error("Kit catalog array differs from the legacy declaration.");
    return legacy.map((value, index) => catalogOrder(actual[index], value));
  }
  if (isRecord(legacy)) {
    if (
      !isRecord(actual) ||
      Object.keys(actual).length !== Object.keys(legacy).length ||
      Object.keys(legacy).some((key) => !Object.hasOwn(actual, key))
    )
      throw new Error("Kit catalog keys differ from the legacy declaration.");
    return Object.fromEntries(Object.entries(legacy).map(([key, value]) => [key, catalogOrder(actual[key], value)]));
  }
  if (actual !== legacy) throw new Error("Kit catalog value differs from the legacy declaration.");
  return actual;
}

/** Four legacy tools, with kit leases, capacity, mapping and dispatch. */
export function restKitTools(vendor: RestKitOptions): ApiTool[] {
  const { index, title } = vendor;
  const tool = (kind: string) => `${vendor.vendor}_api_${kind}`;
  const PATH = pathSchema(vendor.pathExample);
  const headerNames = Object.keys(vendor.headers ?? {});
  const HEADERS: Record<string, JsonSchema> = headerNames.length
    ? {
        headers: {
          type: "object",
          description: "Optional request headers this vendor's operations read; nothing else is accepted.",
          properties: Object.fromEntries(
            Object.entries(vendor.headers!).map(([name, description]) => [
              name,
              { type: "string", minLength: 1, maxLength: 200, description },
            ]),
          ),
          additionalProperties: false,
        },
      }
    : {};
  const headersOf = (args: Record<string, unknown>) =>
    isRecord(args["headers"]) ? { headers: args["headers"] as Record<string, string> } : {};
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
  // The methods an idempotency key is sent with: never DELETE (see the handler).
  const keyed = vendor.idempotencyHeader ? writeMethods.filter((method) => method !== "DELETE") : [];
  const keyedText = keyed.join(" or ");
  const head = index.methods.includes("HEAD");
  const readMethods = [...new Set(["GET", ...(head ? ["HEAD"] : []), ...readPosts.map(([method]) => method)])];
  const routeOf = (op: Operation) => (reads(op) ? tool("read") : tool("write"));

  const guard = (call: RestCall): void => {
    const server = vendor.checkServer?.(call.op.server);
    if (server) invalid(server);
    const refusal = vendor.valueSafety.refusal(call.method, call.op.path) ?? vendor.refuse?.(call);
    if (refusal) invalid(refusal);
  };
  const declarations: Omit<ApiTool, "handler">[] = [
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
          ...(readPosts.length
            ? {
                body: {
                  type: vendor.textBodies ? ["object", "string"] : "object",
                  description: `Body for a reviewed read-only POST${vendor.textBodies ? "; a string for a text-framed operation" : ""}.`,
                },
              }
            : {}),
          query: QUERY,
          ...HEADERS,
          select: SELECT,
        },
        ["path"],
      ),
      outputSchema: envelope(),
    },
    {
      name: tool("write"),
      description:
        `Call a ${title} API write (${writeMethods.join(", ")}); method and path are stated for approval. ` +
        `Checked against the pinned index first.${keyed.length ? ` Pass idempotencyKey to retry a ${keyedText} safely${keyed.length < writeMethods.length ? "; a DELETE sends no key" : ""}.` : ""}`,
      annotations: DESTRUCTIVE,
      inputSchema: closed(
        {
          method: { type: "string", enum: writeMethods, description: "The operation's HTTP method." },
          path: PATH,
          query: QUERY,
          body: {
            type: vendor.textBodies ? ["object", "array", "string"] : ["object", "array"],
            description: `Request body as JSON${vendor.bodyHint ? `; ${vendor.bodyHint}` : ""}.`,
          },
          ...HEADERS,
          ...(vendor.idempotencyHeader
            ? {
                idempotencyKey: {
                  type: "string",
                  minLength: 1,
                  maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
                  description: `Reuse to retry this exact ${keyedText}; one is generated and returned when omitted.`,
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
    },
  ];
  const resolve = (args: Json, method: RestMethod) => {
    const path = vendor.path ? vendor.path(String(args["path"])) : String(args["path"]);
    const { op, params } = index.resolve(method, path);
    const call: RestCall = {
      method: op.method,
      path,
      op,
      params,
      query: isRecord(args["query"]) ? args["query"] : {},
      body: args["body"],
      ...headersOf(args),
    };
    return vendor.scope ? vendor.scope(call) : call;
  };
  const search = (args: Json) => ({
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
  });
  const details = (args: Json) => {
    const method = String(args["method"]),
      path = String(args["path"]);
    const op = index.operation(method, path) ?? index.resolve(method, path).op;
    return {
      ...index.contract(op, typeof args["param"] === "string" ? args["param"] : undefined),
      tool: routeOf(op),
      revision: index.revision,
    };
  };
  const execute = (args: Json, writing: boolean) =>
    checked(() => {
      const call = resolve(args, (typeof args["method"] === "string" ? args["method"] : "GET") as RestMethod);
      if (writing && (call.method === "GET" || call.method === "HEAD"))
        invalid(`${call.method} operations are reads; call them with ${tool("read")}.`);
      if (!writing && !reads(call.op))
        invalid(`${call.method} ${call.op.path} is not a reviewed read; call it with ${tool("write")}.`);
      if (!writing && (call.method === "GET" || call.method === "HEAD") && call.body !== undefined)
        invalid(`A ${call.method} operation takes query, not body.`);
      guard(call);
      const framing = index.bodyType(call.op);
      if (writing && framing && /^multipart\/|octet-stream/.test(framing))
        invalid(
          `${call.method} ${call.op.path} takes a ${framing} upload, which ${tool("write")} does not send.` +
            (vendor.upload ? ` ${vendor.upload}` : ""),
        );
      index.check(call.op, call.query, call.body);
      return call;
    }).pipe(
      Effect.flatMap((call) =>
        Effect.gen(function* () {
          const header = writing && call.method !== "DELETE" ? vendor.idempotencyHeader : undefined;
          const given = typeof args["idempotencyKey"] === "string" ? args["idempotencyKey"] : undefined;
          if (writing && given !== undefined)
            yield* checked(() => {
              const key = given.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
              if (!key)
                invalid("idempotencyKey is blank; pass a key with at least one non-whitespace character, or omit it.");
              if (!/^[\t\x20-\x7e\x80-\xff]*$/.test(key))
                invalid(
                  "idempotencyKey contains a character an HTTP header cannot carry (a control character, or one past Latin-1); pass a printable key, or omit it.",
                );
            });
          const key = header ? (given ?? crypto.randomUUID()) : undefined;
          if (key) yield* (yield* Recovery).record({ idempotencyKey: key });
          const classification = yield* Classification,
            dispatches = yield* Dispatches,
            signal = yield* Signal;
          return yield* vendor.send(call).pipe(
            Effect.provideService(IdempotencyKey, key && header ? { header, key } : undefined),
            Effect.map((result) => ({ ...selected(args, result), ...(key ? { idempotencyKey: key } : {}) })),
            Effect.catch((failure) => {
              if (!key || given) return Effect.fail(failure);
              const error = toConnectorCallError(failure, vendor.connection.errors, {
                classification,
                dispatches,
                withholds: vendor.connection.safety.withholdsErrors,
                signal,
              });
              const diagnostic = providerFailureMessage(error, `${error.message} ${header}: ${key}.`);
              const dispatched = dispatches.some((d) => d.request?.dispatched && d.request.key === key);
              return Effect.fail(
                new Refusal({
                  error: dispatched
                    ? keyResendAdvice(
                        diagnostic,
                        key,
                        " Reusing it with the exact original arguments retries this write without repeating it only while the vendor retains the key; after that, look the object up before retrying.",
                      )
                    : diagnostic,
                }),
              );
            }),
          );
        }),
      ),
    );
  return declarations.map((declaration, i) => {
    const spec = {
      name: declaration.name,
      description: declaration.description,
      input: schema(declaration.inputSchema!),
      output: schema(declaration.outputSchema!),
      run: (args: unknown) =>
        i === 0
          ? checked(() => search(args as Json))
          : i === 1
            ? checked(() => details(args as Json))
            : execute(args as Json, i === 3),
    };
    const built =
      i === 3
        ? write(vendor.connection, { ...spec, destructive: true })
        : read(vendor.connection, {
            ...spec,
            review:
              readPosts.map(([, path, reason]) => `${path}: ${reason}`).join("\n") ||
              "Only GET and HEAD operations are admitted.",
          });
    Object.assign(built, {
      inputSchema: catalogOrder(built.inputSchema, declaration.inputSchema),
      outputSchema: catalogOrder(built.outputSchema, declaration.outputSchema),
    });
    return built;
  });
}
