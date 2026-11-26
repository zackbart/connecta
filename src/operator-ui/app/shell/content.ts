import { Component, Head, Router, Subscription, UiSchema } from "@effect/ui";
import { Button } from "@effect/ui-kit";
import { Html, HtmlSubscription } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { PAGE_META } from "../../view.js";
import { titleSuffix } from "../config.js";
import {
  BootOperator,
  CloseForRecovery,
  commandLayers,
  DisconnectOAuth,
  FocusPendingTarget,
  FocusRecoveryRetry,
  LoadPageCollections,
  RecheckOnReturn,
  RemoveCredential,
  ReportRoute,
  RetryLoad,
  CanonicalizeLocation,
  SaveCredential,
  shellCommandLayers,
  StartOAuth,
  TestCredential,
} from "./commands.js";
import { Gate, NoAccess } from "./gate.js";
import { Icon } from "../components/icons.js";
import { HostIsland, islandRequests } from "./island.js";
import { IslandRequest } from "./island-request.js";
import { OverviewData, OverviewPage, overviewProjection } from "../pages/overview.js";
import { PageData, PageView, pageProjection } from "../pages/page-data.js";
import { IssuedTokenDialog } from "../pages/tokens.js";
import { OperatorController } from "../services/controller.js";
import { ConnectorHealth } from "../services/health.js";
import { OperatorView, viewOf } from "./operator-view.js";
import { OperatorRoute, routePath } from "./routes.js";

const ContentMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: OperatorRoute },
  ChangedOperatorView: {
    view: OperatorView,
    overview: Schema.NullOr(OverviewData),
    page: Schema.NullOr(PageData),
  },
  FocusedWindow: {},
  ChangedVisibility: {},
  ChangedHash: {},
  ClickedRecoveryRetry: {},
  RequestedPageWrite: { request: IslandRequest },
});

const writeCommand = (request: IslandRequest) =>
  IslandRequest.match(request, {
    StartOAuth: ({ connector, mode, prepared }) => StartOAuth.make({ connector, mode, prepared }),
    DisconnectOAuth: ({ connector }) => DisconnectOAuth.make({ connector }),
    SaveCredential: ({ connector, candidate, verify }) => SaveCredential.make({ connector, candidate, verify }),
    RemoveCredential: ({ connector }) => RemoveCredential.make({ connector }),
    TestCredential: ({ connector }) => TestCredential.make({ connector }),
  });

const PageIslandHost = <M>(h: Html.H<M>) =>
  h.div
    .key("page")
    .class("island")
    .onMount(HostIsland({ island: "page" }));

const RecoveryBanner = <M>(h: Html.H<M>, failed: boolean, retry: M) =>
  h.section
    .key("recoveryBanner")
    .attr("id", "recoveryBanner")
    .class("recovery-banner")
    .attr("role", "alert")
    .attr("aria-labelledby", "recoveryTitle")
    .children(
      h.span.class("recovery-mark").attr("aria-hidden", "true").children(Icon(h, "alert")),
      h.div.children(
        h.p
          .attr("id", "recoveryTitle")
          .class("state-title")
          .children(failed ? "Couldn't load configuration" : "Reloading configuration…"),
        h.p.class("meta").children("Showing what last loaded."),
      ),
      Button(h, { onPress: retry })
        .attr("id", "recoveryRetry")
        .class("btn", "default", "sm")
        .children(Icon(h, "refresh", 14), "Retry"),
    );

const contentSource = Effect.gen(function* () {
  const controller = yield* OperatorController;
  const health = yield* ConnectorHealth;
  const router = yield* Router.Router;
  const overview = overviewProjection();
  const pages = pageProjection();
  const project = (state = controller.state()) => {
    const view = viewOf(controller, state);
    return {
      view,
      overview: view.content === "overview" ? overview(state, health.steady(state)) : null,
      page: pages(view.content, state, health.steady, router.location(), controller.issuedTokenHandle),
    };
  };
  const moves = Stream.suspend(() =>
    Stream.merge(Stream.fromEventListener(window, "popstate"), Stream.fromEventListener(window, "hashchange")),
  );
  const locations = Stream.map(Stream.merge(router.changes, moves), () => controller.state());
  return { current: project(), changes: Stream.map(Stream.merge(controller.changes, locations), project) };
});

const contentChanges = Stream.unwrap(Effect.map(contentSource, (source) => source.changes));

export const operatorContentProps = Effect.gen(function* () {
  const route = yield* Router.currentRoute(OperatorRoute);
  const { current } = yield* contentSource;
  return { route, ...current };
});

const PageContent = <M>(h: Html.H<M>, view: OperatorView, overview: OverviewData | null, page: PageData | null) =>
  view.content === "overview" && overview
    ? OverviewPage(h, { props: { overview } })
    : (page && PageView(h, page, view.content)) || PageIslandHost(h);

const OperatorContentNoDeps = Html.component({
  name: "OperatorContent",
  props: Schema.Struct({
    route: OperatorRoute,
    view: OperatorView,
    overview: Schema.NullOr(OverviewData),
    page: Schema.NullOr(PageData),
  }),
  model: Schema.Struct({
    route: OperatorRoute,
    view: OperatorView,
    overview: Schema.NullOr(OverviewData),
    page: Schema.NullOr(PageData),
    recovering: Schema.Boolean,
  }),
  message: ContentMessage,
  restore: false,
}).make({
  init: ($) =>
    $.set({
      route: $.props.route,
      view: $.props.view,
      overview: $.props.overview,
      page: $.props.page,
      recovering: $.props.view.recovering,
    }).run(BootOperator.make(), CanonicalizeLocation.make()),
  update: {
    ChangedRoute: ($, { route }) =>
      $.evolve({ route }).run(ReportRoute.make({ path: routePath(route) }), CanonicalizeLocation.make()),
    ChangedOperatorView: ($, { view, overview, page }) => {
      const entering = view.recovering && !$.model.recovering;
      return $.evolve({ view, overview, page, recovering: view.recovering }).run(
        ...(entering ? [CloseForRecovery.make(), FocusRecoveryRetry.make()] : []),
        ...(!view.islandOwnsFocus && view.focusRequested ? [FocusPendingTarget.make()] : []),
        ...(view.collectionsWanted ? [LoadPageCollections.make()] : []),
      );
    },
    FocusedWindow: ($) => $.run(RecheckOnReturn.make()),
    ChangedVisibility: ($) => $.run(RecheckOnReturn.make()),
    ChangedHash: ($) => $.run(CanonicalizeLocation.make()),
    ClickedRecoveryRetry: ($) => $.run(RetryLoad.make()),
    RequestedPageWrite: ($, { request }) => $.run(writeCommand(request)),
  },
  subscriptions: ({ model }) => [
    Router.subscription(OperatorRoute, model.route, (route) => ContentMessage.ChangedRoute({ route })),
    Subscription.make(
      "operatorView",
      Stream.map(contentChanges, ({ view, overview, page }) =>
        ContentMessage.ChangedOperatorView({ view, overview, page }),
      ),
    ),
    Subscription.make(
      "pageWrites",
      Stream.map(islandRequests, (request) => ContentMessage.RequestedPageWrite({ request })),
    ),
    HtmlSubscription.onWindow("focus", ContentMessage.FocusedWindow()),
    Subscription.make(
      "hash",
      Stream.suspend(() =>
        Stream.map(Stream.fromEventListener(window, "hashchange"), () => ContentMessage.ChangedHash()),
      ),
    ),
    Subscription.make(
      "visibility",
      Stream.suspend(() =>
        Stream.map(Stream.fromEventListener(document, "visibilitychange"), () => ContentMessage.ChangedVisibility()),
      ),
    ),
  ],
  head: ({ model }) => {
    const { view } = model;
    const member = view.session === "ready" && view.role === "member";
    return [Head.title(`${member ? "Your connections" : PAGE_META[view.page].label} · ${titleSuffix}`)];
  },
  view: (h, model) => {
    const { view } = model;
    const ready = view.session === "ready";
    return h.div.class("operator-content").children(
      ready && model.recovering ? RecoveryBanner(h, view.recoveryFailed, ContentMessage.ClickedRecoveryRetry()) : null,
      ready
        ? h.div
            .key("app")
            .attr("id", "app")
            .attr("inert", model.recovering ? "" : undefined)
            .class(model.recovering && "stale")
            .children(PageContent(h, view, model.overview, model.page))
        : view.content === "denied"
          ? NoAccess(h, {})
          : view.content === "gate"
            ? Gate(h, { props: { view: model.view } })
            : PageContent(h, view, model.overview, model.page),
      ready && model.page?._tag === "Tokens"
        ? IssuedTokenDialog(h, { props: { issued: model.page.data.issued } })
        : null,
    );
  },
});

export const OperatorContent = OperatorContentNoDeps.pipe(Component.provide([...commandLayers, ...shellCommandLayers]));
