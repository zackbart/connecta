import { Context, Effect, Layer } from "effect";
import { steadyHealth, type SteadyHealth } from "../../health.js";
import type { OperatorState } from "../../view.js";
import { OperatorStore } from "./store.js";

export interface ConnectorHealthShape {
  readonly steady: (state: OperatorState) => SteadyHealth;
}

export class ConnectorHealth extends Context.Service<ConnectorHealth, ConnectorHealthShape>()(
  "connecta/operator-ui/ConnectorHealth",
) {
  static readonly layer = Layer.effect(
    ConnectorHealth,
    Effect.gen(function* () {
      const store = yield* OperatorStore;
      const seen = new WeakMap<OperatorState, SteadyHealth>();
      let held: SteadyHealth | null = null;
      const observe = (state: OperatorState): SteadyHealth => {
        held = state.session === "ready" ? steadyHealth(state, held) : null;
        const health = held ?? steadyHealth(state, null);
        seen.set(state, health);
        return health;
      };
      observe(store.get());
      yield* Effect.acquireRelease(
        Effect.sync(() => store.subscribe(() => void observe(store.get()))),
        (unsubscribe) => Effect.sync(unsubscribe),
      );
      return ConnectorHealth.of({ steady: (state) => seen.get(state) ?? steadyHealth(state, held) });
    }),
  );
}
