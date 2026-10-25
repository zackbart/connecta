// Request/call Context belongs only to downstream auth, outside metadata/UI.
import { Effect } from "effect";
import { viewServices, viewSignal } from "../runtime/call.js";
import { RequestScope } from "../runtime/request-scope.js";
import { fromSignal } from "../runtime/run.js";
import type { ConnectorContext } from "../types.js";
import { authCall } from "./native.js";

export function authView<A = any>(
  ctx: ConnectorContext,
  work: Function,
  requestOwned = false,
): Effect.Effect<A, unknown> {
  return RequestScope.use((owner) => {
    const signal = viewSignal(ctx, requestOwned);
    if (!owner.open || signal.aborted) return Effect.fail(signal.reason);
    // Settlement facts from all synchronous abort observers precede cleanup,
    // as they did at the Promise boundary. This grants no live authority.
    const abort = Effect.catch(fromSignal(signal), (error) => Effect.andThen(Effect.yieldNow, Effect.fail(error)));
    return Effect.raceFirst(authCall<A>(work, [signal]), abort).pipe(
      Effect.flatMap((value) => {
        const current = viewSignal(ctx, requestOwned);
        return current.aborted ? Effect.fail(current.reason) : Effect.succeed(value);
      }),
    );
  }).pipe(Effect.provideContext(viewServices(ctx)));
}
