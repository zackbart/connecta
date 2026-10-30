// Provider kit. Unreachable from src/index.ts.
//
// Tool builders. A tool is a name, a description, an input Schema, an output
// Schema, and a program; the builder renders both Schemas as catalog JSON
// Schema and annotates the tool from which builder was called (never from an
// HTTP method). At run time the call's served classification decides, so a
// deployment that reclassifies a tool is obeyed by the transport and the
// write-outcome rule alike. Failures leave through the one mapping in
// src/http/errors.ts.
//
// The result is an ordinary `ApiTool`, so a kit tool sits in `api()` beside
// hand-written ones and keeps every guarantee `api()` already gives:
// argument validation, sent-secret redaction, withheld handler text. Its
// boundary also decides every write's outcome, from the core ledger the kit's
// transport records into, so a kit connector declares `tracksEveryRequest`.
import { Context, Effect, Schema } from "effect";
import { inLogicalCall } from "../provider-call.js";
import { registerToolEntry } from "../runtime/call-entry.js";
import type { ApiHandlerContext } from "../connectors/api-connector.js";
import type { ApiTool } from "../connectors/api-connector.js";
import type { JsonSchema } from "../types.js";
import { ConnectorCallError } from "../errors.js";
import { refuseWithheldValues } from "../providers/_shared/rest/value-safety.js";
import { causeError, runEdge } from "../runtime/run.js";
import {
  recordUnauthorized,
  Refusal,
  RequestRefused,
  toConnectorCallError,
  withheldDefect,
  type HttpFailure,
} from "./errors.js";
import { ArgumentProblems } from "./argument-problems.js";
import { fieldsContract, selectFields, type FieldsContract } from "./fields.js";
import { catalogSchema, Integer } from "./json-schema.js";
import { boundCursor, Cursor, StandardPage, type Page } from "./paging.js";
import {
  Classification,
  Dispatches,
  IdempotencyKey,
  Recovery,
  ReadTool,
  WriteCapacity,
  writeRequestKey,
  fromConnectorContext,
  type WriteRequest,
  type CallServices,
} from "./services.js";
import type { Connection } from "./vendor.js";

/** An input Schema the kit can render as catalog JSON Schema and decode without services. */
type Input = Schema.Top & { readonly DecodingServices: never };

/** A fixed step, or a bounded set of deterministic identities selected once from validated arguments. */
type WriteSteps<A> = Readonly<
  Record<
    string,
    | "once"
    | {
        readonly maxItems: number;
        readonly items: (args: A) => readonly string[];
        /** Pure: the kit derives each item's request once, before run. */
        readonly request: (item: string, args: A) => WriteRequest;
      }
  >
>;

export interface ToolSpec<I extends Input, O extends Schema.Top> {
  readonly name: string;
  readonly description: string;
  /**
   * Arguments. `api()` validates them against the rendered JSON Schema first,
   * so an agent reads the same `invalid_args` as today; the builder then
   * decodes them with this Schema, and a decode failure is a defect, because
   * the two renderings must agree.
   */
  readonly input: I;
  /** Preserve caller key order after decoding, for byte-sensitive legacy request framing. */
  readonly inputOrder?: "original";
  /** What the program returns; its type is checked against the projection statically. */
  readonly output: O;
  /** Default: one implicit `write` step. Declare every step before serving, including reads served as writes. */
  readonly writeSteps?: WriteSteps<I["Type"]>;
  /**
   * Argument checks the input Schema cannot express. Record every problem
   * instead of throwing at the first; the kit refuses once, before `run`,
   * with all of them and the schema's synthesized example call.
   */
  readonly check?: (args: I["Type"], problems: ArgumentProblems) => void;
  readonly run: (args: I["Type"]) => Effect.Effect<O["Type"], HttpFailure, CallServices>;
}

const keyed = new WeakSet<ApiTool>();

/** Whether a kit write builder declared an idempotency key for this tool. */
export function takesIdempotencyKey(tool: ApiTool): boolean {
  return keyed.has(tool);
}

/** Copy decoded values only; the input supplies key order, never values or admission. */
function originalOrder<A>(decoded: A, original: unknown): A {
  const copies = new WeakMap<object, unknown>();
  const copy = (value: unknown, source: unknown): unknown => {
    if (value === source || value === null || typeof value !== "object") return value;
    if (copies.has(value)) return copies.get(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      copies.set(value, out);
      value.forEach((item, index) => out.push(copy(item, Array.isArray(source) ? source[index] : undefined)));
      return out;
    }
    const values = value as Record<string, unknown>;
    const keys = source !== null && typeof source === "object" && !Array.isArray(source) ? Object.keys(source) : [];
    const present = keys.filter((key) => Object.hasOwn(values, key));
    const ordered = new Set(present);
    const out: Record<string, unknown> = {};
    copies.set(value, out);
    for (const key of [...present, ...Object.keys(values).filter((key) => !ordered.has(key))]) {
      Object.defineProperty(out, key, {
        value: copy(
          values[key],
          source !== null && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return copy(decoded, original) as A;
}

/** Refuse `fields` on anything but a Schema.Struct. */
function struct(schema: Schema.Top, what: string): Schema.Top {
  if (!(schema as { readonly fields?: unknown }).fields)
    throw new Error(`fields needs ${what} declared as a Schema.Struct.`);
  return schema;
}

/** A tool's own check plus every bad `fields` path, refused together before anything is sent. */
function withFields<A extends { readonly fields?: readonly string[] }>(
  contract: FieldsContract,
  check: ((args: never, problems: ArgumentProblems) => void) | undefined,
) {
  return (args: A, problems: ArgumentProblems) => {
    contract.issues(problems, args.fields);
    const { fields: _fields, ...rest } = args;
    check?.(rest as never, problems);
  };
}

/**
 * A read: admitted to call_tool and programs. `fields: true` (decision 0011
 * S5) appends a `fields` argument that narrows the returned record; the input
 * and output must then be Structs, and a path outside the output's properties
 * is refused before anything is sent.
 */
export function read<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O> & { readonly review?: string; readonly fields?: true },
): ApiTool {
  if (spec.review !== undefined && !spec.review.trim()) throw new Error("A read review must be nonempty.");
  if (spec.fields === undefined) return build(connection, spec, "read", { readOnlyHint: true }, undefined, spec.review);
  const contract = fieldsContract("result", struct(spec.output, "the output"));
  struct(spec.input, "the input");
  const input = Schema.Struct({
    ...(spec.input as unknown as Schema.Struct<Schema.Struct.Fields>).fields,
    fields: Schema.optionalKey(contract.input),
  });
  return build(
    connection,
    {
      ...spec,
      input,
      check: withFields(contract, spec.check),
      run: (args: { readonly fields?: readonly string[] }) =>
        Effect.gen(function* () {
          const { fields, ...rest } = args;
          return selectFields(yield* spec.run(rest as I["Type"]), fields);
        }),
      // A selection may omit any property: the result is typed unknown and rendered sparse.
      output: Schema.Unknown,
    } as unknown as ToolSpec<Input, typeof Schema.Unknown>,
    "read",
    { readOnlyHint: true },
    undefined,
    spec.review,
    sparse(catalogSchema(spec.output, "output")),
  );
}

/** Fetch one entity with the same read contract as a list. */
export function get<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O> & { readonly fields?: true },
): ApiTool {
  return read(connection, spec);
}

/**
 * A standard list (decision 0011 S2, S3, S5): `{ items, page }`, with the kit
 * appending `limit` (its declared default and maximum), `cursor` and
 * `fields` to the tool's own filters.
 */
interface StandardListSpec<F extends Schema.Struct.Fields, Row extends Schema.Top> {
  /** Required when the list performs a reviewed read-only POST. */
  readonly review?: string;
  readonly name: string;
  readonly description: string;
  readonly filters: F;
  readonly row: Row;
  readonly limit: {
    readonly default: number;
    readonly max: number;
    readonly description: string;
    readonly values?: readonly number[];
  };
  readonly cursor?: "plain" | "bound";
  /** Immutable deployment policy in a separate continuation namespace. Absent preserves existing MACs. */
  readonly cursorScope?: Readonly<Record<string, unknown>>;
  /** Expose only an exact count supplied by the vendor, never an estimate from observed rows. */
  readonly total?: true;
  readonly page: (
    args: Schema.Struct<F>["Type"] & { readonly limit: number },
    cursor: string | undefined,
  ) => Effect.Effect<Page<Row["Type"]>, HttpFailure, CallServices>;
}

/** One standard page, with a cursor that passes through or is tied to this call. */
export function list<F extends Schema.Struct.Fields, Row extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: StandardListSpec<F, Row>,
): ApiTool;
export function list(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: StandardListSpec<Schema.Struct.Fields, Schema.Top>,
): ApiTool {
  if (spec.cursor !== undefined && spec.cursor !== "plain" && spec.cursor !== "bound")
    throw new Error('A list cursor must be "plain" or "bound".');
  const { default: size, max } = spec.limit;
  if (spec.total !== undefined && spec.total !== true)
    throw new Error(`${spec.name} total must opt in with true for a vendor-stated exact count.`);
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(max) || size < 1 || max < size)
    throw new Error(`${spec.name} limit needs positive whole default and max values, with default <= max.`);
  const values = spec.limit.values === undefined ? undefined : [...spec.limit.values];
  if (
    values &&
    (!values.length ||
      new Set(values).size !== values.length ||
      !values.includes(size) ||
      values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > max))
  )
    throw new Error(
      `${spec.name} limit values must be unique positive whole sizes within max and include the default.`,
    );
  const limit = Integer.check(Schema.isBetween({ minimum: 1, maximum: max }));
  const allowedLimit = values
    ? limit.check(
        Schema.makeFilter((value: number) => values.includes(value), {
          expected: `one of ${values.join(", ")}`,
          toJsonSchema: () => ({ enum: [...values] }),
        }),
      )
    : limit;
  for (const name of ["limit", "cursor", "fields"]) {
    if (name in spec.filters) throw new Error(`${spec.name} filters cannot declare ${name}; the kit supplies it.`);
  }
  const contract = fieldsContract("item", struct(spec.row, "the row"));
  const input = Schema.Struct({
    ...spec.filters,
    limit: Schema.optionalKey(
      allowedLimit.annotate({
        description: spec.limit.description,
        default: size,
      }),
    ),
    cursor: Schema.optionalKey(Cursor),
    fields: Schema.optionalKey(contract.input),
  });
  return build(
    connection,
    {
      name: spec.name,
      description: spec.description,
      input,
      // `fields` narrows each item, so items render sparse; the envelope keeps items and page required.
      output: Schema.Unknown,
      check: withFields(contract, undefined),
      run: (args: Readonly<Record<string, unknown>> & { readonly fields?: readonly string[] }) =>
        Effect.gen(function* () {
          // A cursor stays valid when only the projection changes between pages.
          const { fields, cursor: supplied, ...rest } = args;
          const scope =
            spec.cursorScope === undefined
              ? rest
              : {
                  arguments: Object.fromEntries(Object.entries(rest).filter(([key]) => key !== "limit")),
                  deploymentPolicy: spec.cursorScope,
                };
          const bound = spec.cursor === "bound";
          const cursor =
            typeof supplied === "string" && bound ? yield* boundCursor.decode(spec.name, scope, supplied) : supplied;
          const result = yield* spec.page(
            { ...rest, limit: typeof rest["limit"] === "number" ? rest["limit"] : size },
            cursor as string | undefined,
          );
          const items = selectFields(result.rows, fields);
          const total = spec.total ? result.page.total : undefined;
          if (total !== undefined && (!Number.isSafeInteger(total) || total < 0))
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError("connector_call_failed", "The vendor returned an invalid exact total.", {
                  retryable: false,
                }),
              }),
            );
          const count = total === undefined ? {} : { total };
          if (!result.page.hasMore) return { items, page: { hasMore: false, ...count } };
          if (result.page.nextCursor === null)
            return yield* Effect.fail(
              new Refusal({
                error: new ConnectorCallError(
                  "connector_call_failed",
                  "The vendor reported another page without a next cursor.",
                  { retryable: false },
                ),
              }),
            );
          const nextCursor = bound
            ? yield* boundCursor.encode(spec.name, scope, result.page.nextCursor)
            : result.page.nextCursor;
          return { items, page: { hasMore: true, nextCursor, ...count } };
        }),
    } as unknown as ToolSpec<Input, typeof Schema.Unknown>,
    "read",
    { readOnlyHint: true },
    undefined,
    spec.review,
    sparseItems(
      catalogSchema(
        Schema.Struct({
          items: Schema.Array(spec.row),
          page: spec.total
            ? Schema.Struct({
                ...StandardPage.fields,
                total: Schema.optionalKey(Integer.check(Schema.isGreaterThanOrEqualTo(0))),
              })
            : StandardPage,
        }),
        "output",
      ),
    ),
  );
}

/** What a `fields` selection may return: the declared shape with no property required, at any depth. */
function sparse(schema: JsonSchema): JsonSchema {
  // Walk schema positions deliberately: drop each `required` keyword, keep property names (a
  // property may be called "required") and literal data (enum, const, default, examples) as is.
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const map = (value: unknown) =>
    object(value) ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walk(child)])) : value;
  const walk = (node: unknown): unknown => {
    if (!object(node)) return node;
    return Object.fromEntries(
      Object.entries(node).flatMap(([key, value]): Array<[string, unknown]> => {
        if (key === "required") return [];
        if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key))
          return [[key, map(value)]];
        if (["anyOf", "oneOf", "allOf", "prefixItems"].includes(key))
          return [[key, Array.isArray(value) ? value.map(walk) : value]];
        if (["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames"].includes(key))
          return [[key, Array.isArray(value) ? value.map(walk) : walk(value)]];
        return [[key, value]];
      }),
    );
  };
  return walk(schema) as JsonSchema;
}

/** A standard list's output with each item sparse. */
function sparseItems(schema: JsonSchema): JsonSchema {
  const root = schema as { properties: { items: { items: JsonSchema } } };
  return {
    ...schema,
    properties: {
      ...root.properties,
      items: { ...root.properties.items, items: sparse(root.properties.items.items) },
    },
  } as JsonSchema;
}

/** An idempotency key the vendor honors, sent on a write's one request. */
interface Idempotency<A> {
  /** The header the vendor reads it from, such as `Idempotency-Key`. */
  readonly header: string;
  /** The key from validated arguments, such as an `idempotencyKey` argument; undefined sends none. */
  readonly key: (args: A) => string | undefined;
}

/** A write: approval-gated, dispatched once, and its failures reported by the write-outcome rule. */
export function write<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O> & {
    readonly destructive: boolean;
    /** Reviewed repeatability of the operation; independent of an optional transport key. */
    readonly idempotent?: boolean;
    readonly idempotency?: Idempotency<I["Type"]>;
  },
): ApiTool {
  return build(
    connection,
    spec,
    "write",
    {
      readOnlyHint: false,
      destructiveHint: spec.destructive,
      ...(spec.idempotent === undefined ? {} : { idempotentHint: spec.idempotent }),
    },
    spec.idempotency,
  );
}

/**
 * A key the transport may send: not blank, and only characters an HTTP
 * header carries. The REST layer refuses the same keys before dispatch.
 */
function unsendableKey(key: string): boolean {
  return key.trim() === "" || !/^[\t\x20-\x7e\x80-\xff]*$/.test(key);
}

function build<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O>,
  verdict: "read" | "write",
  annotations: ApiTool["annotations"],
  idempotency?: Idempotency<I["Type"]>,
  review?: string,
  /** A rendered output schema that replaces the Schema's, for sparse `fields` results. */
  rendered?: JsonSchema,
): ApiTool {
  // One key protects one request: a tool with several write steps cannot share it.
  const declared = Object.entries(spec.writeSteps ?? { write: "once" });
  if (idempotency && (declared.length !== 1 || declared[0]?.[1] !== "once" || !idempotency.header.trim())) {
    throw new Error("An idempotency key needs a header name and a tool with one write step sent once.");
  }
  if (idempotency) {
    try {
      new Headers([[idempotency.header, "key"]]);
    } catch {
      throw new Error("An idempotency key needs a valid HTTP header name.");
    }
  }
  // Snapshot the declaration now; mutations and retries cannot add step names or increase bounds.
  const steps = Object.entries(spec.writeSteps ?? { write: "once" }).map(([name, declaration]) => {
    if (
      !name ||
      (declaration !== "once" &&
        (!Number.isSafeInteger(declaration.maxItems) ||
          declaration.maxItems < 1 ||
          typeof declaration.items !== "function" ||
          typeof declaration.request !== "function"))
    ) {
      throw new Error("Write steps need nonempty names and a positive whole maxItems bound.");
    }
    return [name, declaration === "once" ? declaration : { ...declaration }] as const;
  });
  const capacity = (args: I["Type"]) => {
    const identities = new Set<string>();
    return new Map(
      steps.map(([name, declaration]) => {
        if (declaration === "once")
          return [name, new Map<string | undefined, WriteRequest | undefined>([[undefined, undefined]])] as const;
        const items = [...declaration.items(args)];
        if (
          items.length > declaration.maxItems ||
          items.some((item) => typeof item !== "string" || item.length === 0) ||
          new Set(items).size !== items.length
        ) {
          throw new Error("Write item identities must be unique nonempty strings within the declared maxItems bound.");
        }
        const requests = items.map((item) => {
          // Copy identifying content: a retained mutable object cannot change its request later.
          const request = structuredClone(declaration.request(item, args));
          const key = writeRequestKey(request);
          if (identities.has(key)) throw new Error("Write item aliases must not identify identical request content.");
          identities.add(key);
          return [item, request] as const;
        });
        return [name, new Map<string | undefined, WriteRequest | undefined>(requests)] as const;
      }),
    );
  };
  const decode = Schema.decodeUnknownEffect(spec.input, { onExcessProperty: "error" });
  const tool: ApiTool = {
    name: spec.name,
    description: spec.description,
    inputSchema: catalogSchema(spec.input, "input"),
    outputSchema: rendered ?? catalogSchema(spec.output, "output"),
    annotations,
    handler: (args, ctx) => runEdge(program(args, ctx), { signal: ctx.signal }),
  };
  const program = (args: unknown, ctx: ApiHandlerContext, served = false) =>
    Effect.suspend(() => {
      // The builder's verdict only stands in for a call no invocation dispatched.
      const lease = fromConnectorContext(ctx, verdict);
      const classification = Context.get(lease.services, Classification);
      const dispatches = Context.get(lease.services, Dispatches);
      const map = { classification, dispatches, withholds: connection.safety.withholdsErrors, signal: ctx.signal };
      return Effect.try({
        try: () => {
          if (verdict === "write" || classification === "write") refuseWithheldValues(args, spec.name);
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
        ),
        // Its message can quote the argument; as a defect, api() withholds it.
        Effect.flatMap(() => decode(args).pipe(Effect.orDie)),
        Effect.map((decoded) => (spec.inputOrder === "original" ? originalOrder(decoded, args) : decoded)),
        Effect.flatMap((decoded) => {
          if (!spec.check) return Effect.succeed(decoded);
          const check = spec.check;
          return Effect.try({
            try: () => {
              const problems = new ArgumentProblems();
              check(decoded, problems);
              const refusal = problems.refusal("Invalid arguments", tool.inputSchema);
              if (refusal) throw refusal;
              return decoded;
            },
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
            ),
          );
        }),
        Effect.flatMap((decoded) =>
          Effect.gen(function* () {
            const key = idempotency?.key(decoded);
            if (key !== undefined && unsendableKey(key)) {
              return yield* Effect.fail(
                new RequestRefused({
                  message: "The idempotency key is blank or holds a character an HTTP header cannot carry.",
                }),
              );
            }
            // Recorded before anything leaves: a deadline that interrupts
            // the call still returns the key for reconciliation.
            if (key !== undefined) yield* (yield* Recovery).record({ idempotencyKey: key });
            return yield* Effect.suspend(() => spec.run(decoded)).pipe(
              Effect.provideService(ReadTool, verdict === "read" ? (review ? { review } : {}) : undefined),
              Effect.provideService(WriteCapacity, capacity(decoded)),
              Effect.provideService(
                IdempotencyKey,
                key === undefined ? undefined : { header: idempotency!.header, key },
              ),
            );
          }),
        ),
        // A native served call shares its invocation's cancellation. The
        // invocation settles that interruption from the raw ledger before
        // any completed handler verdict exists, just as at the Promise edge.
        Effect.mapError((failure) =>
          served && ctx.signal?.aborted ? ctx.signal.reason : toConnectorCallError(failure, connection.errors, map),
        ),
        Effect.catchDefect((defect) => Effect.die(withheldDefect(defect, map))),
        Effect.provideContext(lease.services),
        // The call's finalizer: every capability kept from it refuses after this.
        Effect.ensuring(Effect.sync(lease.close)),
        Effect.onError((cause) =>
          Effect.sync(() => {
            if (
              !served &&
              ctx.signal?.aborted === true &&
              causeError(cause, ctx.signal) === ctx.signal.reason &&
              map.classification === "write"
            )
              recordUnauthorized(connection.errors, map);
          }),
        ),
      );
    });
  registerToolEntry(tool, (args, ctx) => program(args, ctx, inLogicalCall(ctx)));
  if (idempotency) keyed.add(tool);
  return tool;
}
