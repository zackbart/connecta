import { originalCallIdentity } from "../provider-call-facts.js";
import { Effect } from "effect";
import { ActiveCall, Operation, contextView, duringViewEffect, type CallServices } from "./call.js";
import type { ApiTool, ApiHandlerContext } from "../connectors/api-connector.js";
import type { Connector } from "../types.js";
type CallTool = Connector["callTool"];
export type Entry = (
  name: string,
  args: Parameters<CallTool>[1],
  options: Parameters<CallTool>[3],
) => Effect.Effect<unknown, unknown, CallServices | ActiveCall | Operation>;
const entries = new WeakMap<object, { readonly own: CallTool; readonly run: Entry }>();
export type NativeCall = (
  name: string,
  args: Parameters<CallTool>[1],
  ctx: Parameters<CallTool>[2],
  options: Parameters<CallTool>[3],
) => Effect.Effect<unknown, unknown>;
export function registerCallEntry(connector: Connector, core: NativeCall): void {
  entries.set(connector, {
    own: connector.callTool,
    run: (name, args, options) =>
      Effect.gen(function* () {
        const lease = yield* ActiveCall;
        const operation = yield* Operation;
        if (!operation) return yield* Effect.die(new Error("An api call needs its operation services."));
        const services = yield* Effect.context<CallServices | ActiveCall | Operation>();
        const view = contextView({ ...lease, services }, operation);
        return yield* duringViewEffect(view, () => core(name, args, view, options));
      }),
  });
}
export function callEntry(connector: Connector, own: CallTool): Entry | undefined {
  const entry = entries.get(originalCallIdentity(connector));
  return entry?.own === own ? entry.run : undefined;
}

// Native tool programs are registered against their original handler identity.
// Replacing or copying a handler cannot inherit a maintained program's proof.
type ToolProgram = (args: unknown, ctx: ApiHandlerContext) => Effect.Effect<unknown, unknown>;
const tools = new WeakMap<ApiTool, { readonly own: ApiTool["handler"]; readonly run: ToolProgram }>();
export function registerToolEntry(tool: ApiTool, run: ToolProgram): void {
  tools.set(tool, { own: tool.handler, run });
}
export function toolEntry(tool: ApiTool): ToolProgram | undefined {
  const entry = tools.get(tool);
  return entry?.own === tool.handler ? entry.run : undefined;
}
