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

const writeCommand = (request: IslandRequest) =>
  IslandRequest.match(request, {
    StartOAuth: ({ connector, mode, prepared }) => StartOAuth.make({ connector, mode, prepared }),
    DisconnectOAuth: ({ connector }) => DisconnectOAuth.make({ connector }),
    SaveCredential: ({ connector, candidate, verify }) => SaveCredential.make({ connector, candidate, verify }),
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

const RecoveryBanner = <M>(h: Html.H<M>, failed: boolean, retry: M) =>
  h.section
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
      Button(h, { onPress: retry })
        .attr("id", "recoveryRetry")
        .class("btn", "default", "sm")
        .children(ShellIcon(h, "refresh", 14), "Retry"),
    );

export const operatorContentProps = Effect.all({ route: Router.currentRoute(OperatorRoute), view: currentView });

const OperatorContentNoDeps = Html.component({
  name: "OperatorContent",
  props: Schema.Struct({ route: OperatorRoute, view: OperatorView }),
  model: Schema.Struct({ route: OperatorRoute, view: OperatorView, recovering: Schema.Boolean }),
  message: ContentMessage,
  restore: false,
}).make({
  init: ($) =>
    $.set({ route: $.props.route, view: $.props.view, recovering: $.props.view.recovering }).run(
      BootOperator.make(),
      CanonicalizeLocation.make(),
    ),
  update: {
    ChangedRoute: ($, { route }) =>
      $.evolve({ route }).run(ReportRoute.make({ path: routePath(route) }), CanonicalizeLocation.make()),
    ChangedOperatorView: ($, { view }) => {
      const entering = view.recovering && !$.model.recovering;
      const islandSpendsFocus = view.session === "ready" || (view.session === "loading" && view.sessionPresumed);
      return $.evolve({ view, recovering: view.recovering }).run(
        ...(entering ? [CloseForRecovery.make(), FocusRecoveryRetry.make()] : []),
        ...(!islandSpendsFocus && view.focusRequested ? [FocusPendingTarget.make()] : []),
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
            .children(PageIslandHost(h))
        : view.session === "denied"
          ? NoAccess(h, {})
          : view.session === "loading" && view.sessionPresumed
            ? PageIslandHost(h)
            : Gate(h, { props: { view: model.view } }),
    );
  },
});

export const OperatorContent = OperatorContentNoDeps.pipe(Component.provide([...commandLayers, ...shellCommandLayers]));
