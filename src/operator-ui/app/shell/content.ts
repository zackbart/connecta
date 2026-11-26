import { Component, Head, Router, Subscription, UiSchema } from "@effect/ui";
import { Html, HtmlSubscription } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { activityReadable, contractRecovering, operatorRole, PAGE_META, type OperatorState } from "../../view.js";
import { titleSuffix } from "../config.js";
import {
  BootOperator,
  CloseForRecovery,
  commandLayers,
  ConfirmTokenAction,
  DisconnectOAuth,
  FocusPendingTarget,
  FocusRecoveryRetry,
  LoadPageCollections,
  RecheckOnReturn,
  RemoveCredential,
  ReportRoute,
  RetryLoad,
  CanonicalizeLocation,
  RotateAgentToken,
  SaveCredential,
  shellCommandLayers,
  StartOAuth,
  TestCredential,
} from "./commands.js";
import { Gate, NoAccess } from "./gate.js";
import { ShellIcon } from "./icons.js";
import { HostIsland, islandRequests } from "./island.js";
import { IslandRequest } from "./island-request.js";
import { currentView, OperatorView, viewChanges } from "./operator-view.js";
import { OperatorRoute, routePath } from "./routes.js";

const ContentMessage = UiSchema.TaggedEnum({
  ChangedRoute: { route: OperatorRoute },
  ChangedOperatorView: { view: OperatorView },
  FocusedWindow: {},
  ChangedVisibility: {},
  ChangedHash: {},
  ClickedRecoveryRetry: {},
  RequestedPageWrite: { request: IslandRequest },
});

const recoveringOf = (state: OperatorState) => state.session === "ready" && contractRecovering(state);

const collectionsWanted = (state: OperatorState) =>
  state.session === "ready" &&
  ((state.page === "tokens" &&
    operatorRole(state) === "maintainer" &&
    state.data?.accessTokenManagement === "available" &&
    state.tokenPhase === "idle") ||
    ((state.page === "activity" || state.page === "connector") &&
      activityReadable(state) &&
      state.activityPhase === "idle"));

const writeCommand = (request: IslandRequest) =>
  IslandRequest.match(request, {
    StartOAuth: ({ connector, mode, prepared }) => StartOAuth.make({ connector, mode, prepared }),
    DisconnectOAuth: ({ connector }) => DisconnectOAuth.make({ connector }),
    SaveCredential: ({ connector, body, verify }) => SaveCredential.make({ connector, body, verify }),
    RemoveCredential: ({ connector }) => RemoveCredential.make({ connector }),
    TestCredential: ({ connector }) => TestCredential.make({ connector }),
    RotateAgentToken: ({ name }) => RotateAgentToken.make({ name }),
    ConfirmTokenAction: () => ConfirmTokenAction.make(),
  });

const PageIslandHost = <M>(h: Html.H<M>) =>
  h.div
    .key("page")
    .class("island")
    .onMount(HostIsland({ island: "page" }));

const RecoveryBanner = <M>(h: Html.H<M>, state: OperatorState, retry: M) => {
  const failed = state.contractPhase === "error" || state.loadFailure !== null;
  return h.section
    .key("recoveryBanner")
    .attr("id", "recoveryBanner")
    .class("recovery-banner")
    .attr("role", "alert")
    .attr("aria-labelledby", "recoveryTitle")
    .children(
      h.span.class("recovery-mark").attr("aria-hidden", "true").children(ShellIcon(h, "alert")),
      h.div.children(
        h.p
          .attr("id", "recoveryTitle")
          .class("state-title")
          .children(failed ? "Couldn't load configuration" : "Reloading configuration…"),
        h.p.class("meta").children("Showing what last loaded."),
      ),
      h.button
        .attr("id", "recoveryRetry")
        .class("btn", "default", "sm")
        .on("click", retry)
        .children(ShellIcon(h, "refresh", 14), "Retry"),
    );
};

export const operatorContentProps = Effect.all({ route: Router.currentRoute(OperatorRoute), view: currentView });

const OperatorContentNoDeps = Html.component({
  name: "OperatorContent",
  props: Schema.Struct({ route: OperatorRoute, view: OperatorView }),
  model: Schema.Struct({ route: OperatorRoute, view: OperatorView, recovering: Schema.Boolean }),
  message: ContentMessage,
  restore: false,
}).make({
  init: ($) =>
    $.set({ route: $.props.route, view: $.props.view, recovering: recoveringOf($.props.view.state) }).run(
      BootOperator.make(),
      CanonicalizeLocation.make(),
    ),
  update: {
    ChangedRoute: ($, { route }) =>
      $.evolve({ route }).run(ReportRoute.make({ path: routePath(route) }), CanonicalizeLocation.make()),
    ChangedOperatorView: ($, { view }) => {
      const { state } = view;
      const recovering = recoveringOf(state);
      const entering = recovering && !$.model.recovering;
      return $.evolve({ view, recovering }).run(
        ...(entering ? [CloseForRecovery.make(), FocusRecoveryRetry.make()] : []),
        ...(state.pendingFocus !== null || state.focusIfLost !== null ? [FocusPendingTarget.make()] : []),
        ...(collectionsWanted(state) ? [LoadPageCollections.make()] : []),
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
      Stream.map(viewChanges, (view) => ContentMessage.ChangedOperatorView({ view })),
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
    const { state } = model.view;
    const member = state.session === "ready" && state.role === "member";
    return [Head.title(`${member ? "Your connections" : PAGE_META[state.page].label} · ${titleSuffix}`)];
  },
  view: (h, model) => {
    const { state } = model.view;
    const ready = state.session === "ready";
    return h.div.class("operator-content").children(
      ready && model.recovering ? RecoveryBanner(h, state, ContentMessage.ClickedRecoveryRetry()) : null,
      ready
        ? h.div
            .key("app")
            .attr("id", "app")
            .attr("inert", model.recovering ? "" : undefined)
            .class(model.recovering && "stale")
            .children(PageIslandHost(h))
        : state.session === "denied"
          ? NoAccess(h, {})
          : state.session === "loading" && model.view.sessionPresumed
            ? PageIslandHost(h)
            : Gate(h, { props: { view: model.view } }),
    );
  },
});

export const OperatorContent = OperatorContentNoDeps.pipe(Component.provide([...commandLayers, ...shellCommandLayers]));
