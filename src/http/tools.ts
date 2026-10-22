// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
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
import {
  Classification,
  Dispatches,
  IdempotencyKey,
  Recovery,
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
  /** What the program returns; its type is checked against the projection statically. */
  readonly output: O;
  /** Default: one implicit `write` step. Declare every step before serving, including reads served as writes. */
  readonly writeSteps?: WriteSteps<I["Type"]>;
  readonly run: (args: I["Type"]) => Effect.Effect<O["Type"], HttpFailure, CallServices>;
}

const inputs = new WeakMap<ApiTool, Input>();

/** The input Schema a kit tool decodes with, for the catalog/decoder agreement check. */
export function kitInput(tool: ApiTool): Input | undefined {
  return inputs.get(tool);
}

/** A read: admitted to call_tool and programs. */
export function read<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O>,
): ApiTool {
  return build(connection, spec, "read", { readOnlyHint: true });
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
): ApiTool {
  // One key protects one request: a tool with several write steps cannot share it.
  const declared = Object.entries(spec.writeSteps ?? { write: "once" });
  if (idempotency && (declared.length !== 1 || declared[0]?.[1] !== "once" || !idempotency.header.trim())) {
    throw new Error("An idempotency key needs a header name and a tool with one write step sent once.");
  }
  // Snapshot the declaration now; mutations and retries cannot add step names or increase bounds.
  const steps = Object.entries(spec.writeSteps ?? { write: "once" }).map(([name, declaration]) => {
    if (
      !name ||
      (declaration !== "once" && (!Number.isSafeInteger(declaration.maxItems) || declaration.maxItems < 1))
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
  const decode = Schema.decodeUnknownEffect(spec.input);
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
                Effect.provideService(WriteCapacity, capacity(decoded)),
                Effect.provideService(
                  IdempotencyKey,
                  key === undefined ? undefined : { header: idempotency!.header, key },
                ),
              );
            }),
          ),
          Effect.mapError((failure) => toConnectorCallError(failure, connection.errors, map)),
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
