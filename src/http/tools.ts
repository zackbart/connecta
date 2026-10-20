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
// argument validation, sent-secret redaction, withheld handler text.

import { Context, Effect, Schema } from "effect";
import type { ApiTool } from "../connectors/api-connector.js";
import { runEdge } from "../runtime/run.js";
import { departedVerdict, toConnectorCallError, type HttpFailure } from "./errors.js";
import { catalogSchema } from "./json-schema.js";
import { Classification, Dispatches, WriteCapacity, fromConnectorContext, type CallServices } from "./services.js";
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

/** A write: approval-gated, dispatched once, and its failures reported by the write-outcome rule. */
export function write<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O> & { readonly destructive: boolean },
): ApiTool {
  return build(
    connection,
    spec,
    "write",
    spec.destructive ? { readOnlyHint: false, destructiveHint: true } : { readOnlyHint: false },
  );
}

function build<I extends Input, O extends Schema.Top>(
  connection: Pick<Connection<unknown>, "errors" | "safety">,
  spec: ToolSpec<I, O>,
  verdict: "read" | "write",
  annotations: ApiTool["annotations"],
): ApiTool {
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
  const capacity = (args: I["Type"]) =>
    new Map(
      steps.map(([name, declaration]) => {
        if (declaration === "once") return [name, new Set<string | undefined>([undefined])] as const;
        const items = [...declaration.items(args)];
        if (
          items.length > declaration.maxItems ||
          items.some((item) => typeof item !== "string" || item.length === 0) ||
          new Set(items).size !== items.length
        ) {
          throw new Error("Write item identities must be unique nonempty strings within the declared maxItems bound.");
        }
        return [name, new Set<string | undefined>(items)] as const;
      }),
    );
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
            Effect.suspend(() => spec.run(decoded)).pipe(Effect.provideService(WriteCapacity, capacity(decoded))),
          ),
          Effect.mapError((failure) => toConnectorCallError(failure, connection.errors, map)),
          Effect.provideContext(lease.services),
          // The call's finalizer: every capability kept from it refuses after this.
          Effect.ensuring(Effect.sync(lease.close)),
        ),
        { signal: ctx.signal },
      ).catch((error: unknown) => {
        // Cancelled after the vendor answered the write 401: that answer fixed
        // the outcome and its handoff, and the caller's departure does not unsay it.
        if (ctx.signal?.aborted === true && error === ctx.signal.reason) {
          throw departedVerdict(connection.errors, map) ?? error;
        }
        throw error;
      });
    },
  };
  inputs.set(tool, spec.input);
  return tool;
}
