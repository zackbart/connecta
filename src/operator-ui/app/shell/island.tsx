import { Mount, Router } from "@effect/ui";
import { Context, Effect, Layer, Predicate, Queue, Schema, Stream } from "effect";
import { createRoot } from "react-dom/client";
import type { ConnectorSummary } from "../../config-summary.js";
import { installIslandHost, locationChanged, useOperatorState } from "../bridge.js";
import { ActivityPage } from "../activity.js";
import { BadgeRow, StatTiles } from "../config-tiles.js";
import { Card } from "../primitives.js";
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

let hosts = 0;

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
    location: () => router.location(),
  });
  yield* Stream.runForEach(router.changes, () => Effect.sync(locationChanged)).pipe(Effect.forkScoped);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      if (hosts++ > 0) return;
      window.addEventListener("popstate", locationChanged);
      window.addEventListener("hashchange", locationChanged);
    }),
    () =>
      Effect.sync(() => {
        if (--hosts > 0) return;
        window.removeEventListener("popstate", locationChanged);
        window.removeEventListener("hashchange", locationChanged);
      }),
  );
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

function ConnectorActivity({ connector }: { connector: string }) {
  return <ActivityPage state={useOperatorState()} connectorId={connector} />;
}

export const HostConnectorActivity = Mount.makeStream(
  "HostConnectorActivity",
  { args: { connector: Schema.String } },
  (node: HTMLElement, _args, changes) =>
    Stream.callback<never, never, OperatorController | ConnectorHealth | IslandRequests | Router.Router>(() =>
      Effect.gen(function* () {
        yield* installHost;
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => createRoot(node)),
          (root) => Effect.sync(() => root.unmount()),
        );
        yield* Stream.runForEach(changes, ({ connector }) =>
          Effect.sync(() => root.render(<ConnectorActivity connector={connector} />)),
        ).pipe(Effect.forkScoped);
      }),
    ),
);

function ConnectorConfigCard({ summary, name }: { summary: ConnectorSummary; name: string }) {
  return (
    <Card aria-label="Connector configuration" title="Configuration" className="connector-config">
      <BadgeRow badges={summary.badges} label={`${name} setup`} />
      {summary.auth.length ? <BadgeRow badges={summary.auth} label={`${name} auth`} /> : null}
      <StatTiles tiles={summary.tiles} compact label={`${name} settings`} />
    </Card>
  );
}

const SummaryArg = Schema.declare<ConnectorSummary>((input): input is ConnectorSummary => Predicate.isObject(input));

export const HostConnectorConfig = Mount.makeStream(
  "HostConnectorConfig",
  { args: { summary: SummaryArg, name: Schema.String } },
  (node: HTMLElement, _args, changes) =>
    Stream.callback<never>(() =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() => createRoot(node)),
          (root) => Effect.sync(() => root.unmount()),
        );
        yield* Stream.runForEach(changes, ({ summary, name }) =>
          Effect.sync(() => root.render(<ConnectorConfigCard summary={summary} name={name} />)),
        ).pipe(Effect.forkScoped);
      }),
    ),
);
