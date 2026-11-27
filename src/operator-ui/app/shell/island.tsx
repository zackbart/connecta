import { Mount, Router } from "@effect/ui";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import { createRoot } from "react-dom/client";
import { installIslandHost } from "../bridge.js";
import { runNow, starterIn } from "../run.js";
import { ControlsIsland, PageIsland } from "../pages.js";
import { OperatorController } from "../services/controller.js";
import { ConnectorHealth } from "../services/health.js";
import type { IslandRequest } from "./island-request.js";

export class IslandRequests extends Context.Service<
  IslandRequests,
  { readonly offer: (request: IslandRequest) => void; readonly requests: Stream.Stream<IslandRequest> }
>()("connecta/operator-ui/IslandRequests") {
  static readonly layer = Layer.effect(
    IslandRequests,
    Effect.map(Queue.unbounded<IslandRequest>(), (queue) =>
      IslandRequests.of({
        offer: (request) => void Queue.offerUnsafe(queue, request),
        requests: Stream.fromQueue(queue),
      }),
    ),
  );
}

export const islandRequests = Stream.unwrap(IslandRequests.useSync((islands) => islands.requests));

const installHost = Effect.gen(function* () {
  const controller = yield* OperatorController;
  const islands = yield* IslandRequests;
  const router = yield* Router.Router;
  const start = starterIn(yield* Effect.context<never>());
  installIslandHost({
    controller,
    run: (effect) => void start(effect),
    request: islands.offer,
    navigate: (href, replace) => void runNow(router.navigate(href, { replace })),
  });
});

const ISLANDS = { page: PageIsland, controls: ControlsIsland } as const;

export const HostIsland = Mount.makeStream(
  "HostIsland",
  { args: { island: Schema.Literals(["page", "controls"]) } },
  (node: HTMLElement, { island }) =>
    Stream.callback<never, never, OperatorController | ConnectorHealth | IslandRequests | Router.Router>(() =>
      Effect.gen(function* () {
        yield* installHost;
        const View = ISLANDS[island];
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const root = createRoot(node);
            root.render(<View />);
            return root;
          }),
          (root) => Effect.sync(() => root.unmount()),
        );
      }),
    ),
);
