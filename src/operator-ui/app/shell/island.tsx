import { Router } from "@effect/ui";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";
import { Mount } from "@effect/ui";
import { createRoot } from "react-dom/client";
import { installIslandHost, locationChanged } from "../bridge.js";
import { runNow, starterIn } from "../run.js";
import { ControlsIsland, PageIsland } from "../pages.js";
import { OperatorController } from "../services/controller.js";
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

const ISLANDS = { page: PageIsland, controls: ControlsIsland } as const;

export const HostIsland = Mount.makeStream(
  "HostIsland",
  { args: { island: Schema.Literals(["page", "controls"]) } },
  (node: HTMLElement, { island }) =>
    Stream.callback<never, never, OperatorController | IslandRequests | Router.Router>(() =>
      Effect.gen(function* () {
        const controller = yield* OperatorController;
        const islands = yield* IslandRequests;
        const router = yield* Router.Router;
        const services = yield* Effect.context<never>();
        const start = starterIn(services);
        installIslandHost({
          controller,
          run: (effect) => void start(effect),
          request: islands.offer,
          navigate: (href, replace) => void runNow(router.navigate(href, { replace })),
          location: () => router.location(),
        });
        yield* Stream.runForEach(router.changes, () => Effect.sync(locationChanged)).pipe(Effect.forkScoped);
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            window.addEventListener("popstate", locationChanged);
            window.addEventListener("hashchange", locationChanged);
            const root = createRoot(node);
            const View = ISLANDS[island];
            root.render(<View />);
            return root;
          }),
          (root) =>
            Effect.sync(() => {
              window.removeEventListener("popstate", locationChanged);
              window.removeEventListener("hashchange", locationChanged);
              root.unmount();
            }),
        );
      }),
    ),
);
