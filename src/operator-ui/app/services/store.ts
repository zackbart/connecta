import { Context, Effect, Layer, Queue, Stream } from "effect";
import { initialState, type OperatorState } from "../../view.js";
import { ShellConfig } from "./platform.js";

export interface OperatorStoreShape {
  readonly get: () => OperatorState;
  readonly set: (patch: Partial<OperatorState>) => void;
  readonly replace: (state: OperatorState) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly changes: Stream.Stream<OperatorState>;
}

export class OperatorStore extends Context.Service<OperatorStore, OperatorStoreShape>()(
  "connecta/operator-ui/OperatorStore",
) {
  static readonly layer = Layer.effect(
    OperatorStore,
    ShellConfig.useSync(({ initialPage }) => {
      let state = initialState(initialPage);
      const listeners = new Set<() => void>();
      const publish = () => {
        for (const listener of listeners) listener();
      };
      const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      };
      return OperatorStore.of({
        get: () => state,
        set: (patch) => {
          state = { ...state, ...patch };
          publish();
        },
        replace: (next) => {
          state = next;
          publish();
        },
        subscribe,
        changes: Stream.callback<OperatorState>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              Queue.offerUnsafe(queue, state);
              return subscribe(() => void Queue.offerUnsafe(queue, state));
            }),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      });
    }),
  );
}
