// Internal prototype for decision 0010 (B.4). Unreachable from src/index.ts.
//
// Tool builders. A tool is a name, a description, an input Schema, an output
// Schema, and a program; the builder renders both Schemas as catalog JSON
// Schema, fixes the classification from which builder was called (never from
// an HTTP method), and runs the program at the Promise edge with the call's
// services. Failures leave through the one mapping in src/http/errors.ts.
//
// The result is an ordinary `ApiTool`, so a kit tool sits in `api()` beside
// hand-written ones and keeps every guarantee `api()` already gives:
// argument validation, sent-secret redaction, withheld handler text.

import { Context, Effect, Schema } from "effect";
import type { ApiTool } from "../connectors/api-connector.js";
import { runEdge } from "../runtime/run.js";
import type { Reply } from "./client.js";
import { StatusFailure, UnreadableBody, toConnectorCallError, type HttpFailure, type VendorErrors } from "./errors.js";
import { catalogSchema } from "./json-schema.js";
import { Classification, Dispatches, fromConnectorContext, type CallServices } from "./services.js";

/** An input Schema the kit can render as catalog JSON Schema and decode without services. */
type Input = Schema.Top & { readonly DecodingServices: never };

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
  readonly run: (args: I["Type"]) => Effect.Effect<O["Type"], HttpFailure, CallServices>;
}

/** A read. Admitted to call_tool and programs; nothing about it is inferred. */
export function read<I extends Input, O extends Schema.Top>(errors: VendorErrors, spec: ToolSpec<I, O>): ApiTool {
  const decode = Schema.decodeUnknownEffect(spec.input);
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: catalogSchema(spec.input, "input"),
    outputSchema: catalogSchema(spec.output, "output"),
    annotations: { readOnlyHint: true },
    handler: (args, ctx) => {
      const services = fromConnectorContext(ctx, "read");
      return runEdge(
        decode(args).pipe(
          // Its message can quote the argument; as a defect, api() withholds it.
          Effect.orDie,
          Effect.flatMap((decoded) => spec.run(decoded)),
          // The served classification and the dispatch count decide the
          // write-outcome rule, never the builder or the HTTP method.
          Effect.mapError((failure) =>
            toConnectorCallError(failure, errors, {
              classification: Context.get(services, Classification),
              dispatched: Context.get(services, Dispatches).count > 0,
              signal: ctx.signal,
            }),
          ),
          Effect.provideContext(services),
        ),
        { signal: ctx.signal },
      );
    },
  };
}

/**
 * The JSON body of a 2xx answer. Any other status fails StatusFailure with
 * its body parsed when it is JSON, for the vendor's status table to read; a
 * successful body that is not JSON fails UnreadableBody. An empty body is
 * `undefined`, as guarded-fetch's `json()` has always read it.
 */
export function json(reply: Reply): Effect.Effect<unknown, HttpFailure> {
  const parsed = parse(reply.text);
  if (reply.status < 200 || reply.status > 299) {
    return Effect.fail(new StatusFailure({ status: reply.status, headers: reply.headers, body: parsed?.value }));
  }
  return parsed ? Effect.succeed(parsed.value) : Effect.fail(new UnreadableBody());
}

function parse(text: string | undefined): { value: unknown } | undefined {
  if (text === undefined) return undefined;
  if (text.trim() === "") return { value: undefined };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return undefined;
  }
}
