import { isRecord } from "../json.js";
// Shared REST call shapes, pinned-schema conversion and indexed vendor declarations.
import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import type { JsonSchema } from "../../../types.js";
import { Refusal } from "../../../http/errors.js";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
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
} from "../../../http/vendor.js";
import type { Operation, OperationIndex, RestMethod } from "./operation-index.js";
import type { GuardedRequest } from "../../../connectors/guarded-fetch.js";

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
  /** Request headers from the vendor's reviewed `headers` allowlist. */
  readonly headers?: Readonly<Record<string, string>>;
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

/**
 * The cursor for the next page: pass `next` back as `param`, a query
 * parameter unless `in` says the operation takes it in its body.
 * `path` names a different GET that continues the list when the first page
 * came from a call that created it. `hasMore` without `next` means the operation has no cursor.
 */
export interface RestPage {
  hasMore: boolean;
  next?: string;
  param?: string;
  in?: "query" | "body";
  path?: string;
}

export interface RestResult {
  status: number;
  data: unknown;
  page?: RestPage;
}

/** A reviewed POST that only reads: `[method, path template, reason]`. */
export type RestReadPost = readonly [method: RestMethod, path: string, reason: string];

type Json = Record<string, unknown>;
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

/** Convert the JSON forms published by pinned indexes. No vendor encoders run here. */
export function schema(node: JsonSchema): Schema.Codec<unknown> {
  const n = node as Json;
  let out: Schema.Codec<unknown>;
  const types = n["type"];
  if (n["truncated"] === true) out = Schema.Unknown;
  else if (Array.isArray(n["enum"]))
    out = n["enum"].length === 1 ? Schema.Literal(n["enum"][0]) : Schema.Literals(n["enum"] as [string, ...string[]]);
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
  if (n["writeOnly"] === true) out = out.annotate({ writeOnly: true });
  return typeof n["description"] === "string" ? out.annotate({ description: n["description"] }) : out;
}

/** Declare each indexed operation once; request schema subtrees stay suspended until manifest/client use. */
export function indexedVendor(name: string, index: OperationIndex, named: readonly KitOperation[] = []): Vendor {
  for (const op of index.ops) {
    if (
      [...op.path.matchAll(/\{([^}]*)\}/g)].some((match) => !/^[A-Za-z0-9_-]+$/.test(match[1]!)) ||
      /[{}]/.test(op.path.replace(/\{[^}]*\}/g, ""))
    )
      throw new Error(`Indexed operation ${op.method} ${op.path} has an unsupported path parameter name.`);
  }
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
          // These declarations feed only the manifest. The live client uses `named` below.
          op.path as `/${string}`,
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
