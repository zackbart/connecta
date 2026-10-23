// Provider kit (decision 0010, B.4). Unreachable from src/index.ts.
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
import type { ApiTool } from "../connectors/api-connector.js";
import { runEdge } from "../runtime/run.js";
import { recordUnauthorized, RequestRefused, toConnectorCallError, type HttpFailure } from "./errors.js";
import { catalogSchema } from "./json-schema.js";
import { boundCursor, PageInfo, type Page } from "./paging.js";
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
  readonly run: (args: I["Type"]) => Effect.Effect<O["Type"], HttpFailure, CallServices>;
}

const inputs = new WeakMap<ApiTool, Input>();

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

/** The input Schema a kit tool decodes with, for the catalog/decoder agreement check. */
export function kitInput(tool: ApiTool): Input | undefined {
  return inputs.get(tool);
}

/** A read: admitted to call_tool and programs. */
export function read<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O> & { readonly review?: string },
): ApiTool {
  if (spec.review !== undefined && !spec.review.trim()) throw new Error("A read review must be nonempty.");
  return build(connection, spec, "read", { readOnlyHint: true }, undefined, spec.review);
}

/** Fetch one entity with the same read contract as a list. */
export function get<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O>,
): ApiTool {
  return read(connection, spec);
}

/** One page, with a cursor that either passes through or is tied to this call. */
export function list<I extends Input, Row extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: Omit<ToolSpec<I, never>, "output" | "run"> & {
    readonly key: string;
    readonly row: Row;
    readonly cursor?: "plain" | "bound";
    readonly page: (
      args: I["Type"],
      cursor: string | undefined,
    ) => Effect.Effect<Page<Row["Type"]>, HttpFailure, CallServices>;
  },
): ApiTool {
  if (!spec.key || spec.key === "page") throw new Error("A list needs a row key distinct from page.");
  if (spec.cursor !== undefined && spec.cursor !== "plain" && spec.cursor !== "bound")
    throw new Error('A list cursor must be "plain" or "bound".');
  return read(connection, {
    ...spec,
    output: Schema.Struct({ [spec.key]: Schema.Array(spec.row), page: PageInfo }),
    run: (args) =>
      Effect.gen(function* () {
        const fields = args as Readonly<Record<string, unknown>>;
        const supplied = typeof fields.cursor === "string" ? fields.cursor : undefined;
        const cursor =
          supplied !== undefined && spec.cursor === "bound"
            ? yield* boundCursor.decode(spec.name, fields, supplied)
            : supplied;
        const result = yield* spec.page(args, cursor);
        const nextCursor =
          result.page.nextCursor !== null && spec.cursor === "bound"
            ? yield* boundCursor.encode(spec.name, fields, result.page.nextCursor)
            : result.page.nextCursor;
        return { [spec.key]: result.rows, page: { ...result.page, nextCursor } };
      }),
  });
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
  spec: ToolSpec<I, O> & { readonly destructive: boolean; readonly idempotency?: Idempotency<I["Type"]> },
): ApiTool {
  return build(
    connection,
    spec,
    "write",
    spec.destructive ? { readOnlyHint: false, destructiveHint: true } : { readOnlyHint: false },
    spec.idempotency,
  );
}

/** Money, mail, and refunds are always destructive and never idempotent hints. */
export function action<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O>,
): ApiTool {
  return build(connection, spec, "write", { readOnlyHint: false, destructiveHint: true, idempotentHint: false });
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
    outputSchema: catalogSchema(spec.output, "output"),
    annotations,
    handler: (args, ctx) => {
      // The builder's verdict only stands in for a call no invocation dispatched.
      const lease = fromConnectorContext(ctx, verdict);
      const classification = Context.get(lease.services, Classification);
      const dispatches = Context.get(lease.services, Dispatches);
      const map = { classification, dispatches, withholds: connection.safety.withholdsErrors, signal: ctx.signal };
      return runEdge(
        decode(args).pipe(
          // Its message can quote the argument; as a defect, api() withholds it.
          Effect.orDie,
          Effect.map((decoded) => (spec.inputOrder === "original" ? originalOrder(decoded, args) : decoded)),
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
          Effect.mapError((failure) => toConnectorCallError(failure, connection.errors, map)),
          Effect.catchDefect((defect) => {
            try {
              if (!dispatches.some(({ operation }) => operation && map.withholds(operation))) return Effect.die(defect);
            } catch {
              // A broken visibility hook cannot authorize exposing a defect's text.
            }
            // Cover the program and every hook, including those in error mapping.
            // api() preserves ConnectorCallError messages, so shed that identity.
            return Effect.die(new Error("A provider hook withholding vendor text failed."));
          }),
          Effect.provideContext(lease.services),
          // The call's finalizer: every capability kept from it refuses after this.
          Effect.ensuring(Effect.sync(lease.close)),
        ),
        { signal: ctx.signal },
      ).catch((error: unknown) => {
        // The caller left before any failure was mapped: a write's 401 still
        // records its vendor verdict, from which the core decides (Q8).
        if (ctx.signal?.aborted === true && error === ctx.signal.reason && map.classification === "write")
          recordUnauthorized(connection.errors, map);
        throw error;
      });
    },
  };
  inputs.set(tool, spec.input);
  return tool;
}
