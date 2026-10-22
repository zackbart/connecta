import { originalCallIdentity } from "../provider-call-facts.js";
import { Effect } from "effect";
import { ActiveCall, Operation, contextView, type CallServices } from "./call.js";
import type { Connector } from "../types.js";
type CallTool = Connector["callTool"];
type Entry = (
  name: string,
  args: Parameters<CallTool>[1],
  options: Parameters<CallTool>[3],
) => Effect.Effect<unknown, unknown, CallServices | ActiveCall | Operation>;
const entries = new WeakMap<object, { readonly own: CallTool; readonly run: Entry }>();
export function registerCallEntry(connector: Connector, core: CallTool): void {
  entries.set(connector, {
    own: connector.callTool,
    run: (name, args, options) =>
      Effect.gen(function* () {
        const lease = yield* ActiveCall;
        const operation = yield* Operation;
        if (!operation) return yield* Effect.die(new Error("An api call needs its operation services."));
        const services = yield* Effect.context<CallServices | ActiveCall | Operation>();
        const view = contextView({ ...lease, services }, operation);
        return yield* Effect.tryPromise({
          try: () => Promise.resolve(core(name, args, view, options)),
          catch: (error) => error,
        });
      }),
  });
}
export function callEntry(connector: Connector, own: CallTool): Entry | undefined {
  const entry = entries.get(originalCallIdentity(connector));
  return entry?.own === own ? entry.run : undefined;
}
