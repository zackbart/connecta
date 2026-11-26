import { Component, Mount, Subscription, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { PAGE_META, type OperatorPage } from "../../view.js";
import { auth, productName } from "../config.js";
import { AccountMenu } from "./account-menu.js";
import { ForgetBearer, NavigateToPage, SignOut, shellCommandLayers, commandLayers } from "./commands.js";
import { HostIsland } from "./island.js";
import { OperatorView, viewChanges, visiblePages } from "./operator-view.js";

const KeepCurrentInView = Mount.makeStream(
  "KeepCurrentInView",
  { args: { page: Schema.String, session: Schema.String } },
  (row: HTMLElement, _args, changes) =>
    Stream.mapEffect(changes, () =>
      Effect.sync(() => {
        const link = row.querySelector('[aria-current="page"]');
        if (!link || row.scrollWidth <= row.clientWidth) return;
        const bounds = row.getBoundingClientRect();
        const current = link.getBoundingClientRect();
        const inset = parseFloat(getComputedStyle(row).paddingLeft) || 0;
        if (current.left < bounds.left + inset) row.scrollLeft += current.left - bounds.left - inset;
        else if (current.right > bounds.right - inset) row.scrollLeft += current.right - bounds.right + inset;
      }),
    ).pipe(Stream.drain),
);

const NavMessage = UiSchema.TaggedEnum({
  ChangedOperatorView: { view: OperatorView },
  ClickedPageLink: { page: Schema.String },
  RequestedSessionActionAccount: {},
});

const sessionAction = () => (auth.kind === "clerk" || auth.kind === "cloudflare-access" ? "signOut" : "changeToken");

const howSignedIn = () =>
  auth.kind === "clerk" ? "team sign-in" : auth.kind === "cloudflare-access" ? "Cloudflare Access" : "a bearer token";

const Account = <M>(h: Html.H<M>, view: OperatorView, role: "maintainer" | "member", onAction: M) =>
  AccountMenu(h, {
    key: role,
    props: {
      account: view.account,
      role: `${role === "member" ? "Member" : "Maintainer"}, signed in with ${howSignedIn()}`,
      action: sessionAction(),
    },
    onEmit: { RequestedSessionAction: () => onAction },
  });

const OperatorNavNoDeps = Html.component({
  name: "OperatorNav",
  props: Schema.Struct({ view: OperatorView }),
  model: Schema.Struct({ view: OperatorView }),
  message: NavMessage,
  restore: false,
}).make({
  init: ($) => ({ view: $.props.view }),
  update: {
    ChangedOperatorView: ($, { view }) => $.evolve({ view }),
    ClickedPageLink: ($, { page }) => $.run(NavigateToPage.make({ page, href: PAGE_META[page as OperatorPage].path })),
    RequestedSessionActionAccount: ($) => $.run(sessionAction() === "signOut" ? SignOut.make() : ForgetBearer.make()),
  },
  subscriptions: () => [
    Subscription.make(
      "operatorView",
      Stream.map(viewChanges, (view) => NavMessage.ChangedOperatorView({ view })),
    ),
  ],
  view: (h, { view }) => {
    const { state } = view;
    const action = NavMessage.RequestedSessionActionAccount();
    if (state.session === "ready" && state.role === "member") {
      return h.div.class("mast-actions").children(
        h.div
          .class("session-actions", "member-session")
          .attr("aria-label", "Session actions")
          .children(Account(h, view, "member", action)),
      );
    }
    const name = state.contract?.role === "maintainer" ? state.contract.config?.server.name : undefined;
    const redundant = name?.trim().toLowerCase() === productName.trim().toLowerCase();
    const ready = state.session === "ready";
    return h.div.class("mast-actions").children(
      name && !redundant ? h.span.class("deployment-name").attr("title", name).children(name) : null,
      h.nav
        .class("page-nav")
        .attr("aria-label", "Operator pages")
        .onMount(KeepCurrentInView({ page: state.page, session: state.session }))
        .children(
          (ready ? visiblePages(state, view.navHint) : []).map((page) =>
            h.a
              .key(page)
              .class("navlink")
              .attr("href", PAGE_META[page].path)
              .attr(
                "aria-current",
                state.page === page || (page === "connections" && state.page === "connector") ? "page" : undefined,
              )
              .on(
                "click",
                (click) =>
                  click.button !== 0 || click.meta || click.ctrl || click.shift || click.alt
                    ? undefined
                    : NavMessage.ClickedPageLink({ page }),
                { preventDefault: true },
              )
              .children(PAGE_META[page].label),
          ),
        ),
      h.div
        .class("session-actions")
        .attr("hidden", ready ? undefined : "")
        .attr("aria-label", "Session actions")
        .children(
          ready
            ? h.div
                .key("controls")
                .class("island")
                .onMount(HostIsland({ island: "controls" }))
            : null,
          Account(h, view, "maintainer", action),
        ),
    );
  },
});

export const OperatorNav = OperatorNavNoDeps.pipe(Component.provide([...commandLayers, ...shellCommandLayers]));
