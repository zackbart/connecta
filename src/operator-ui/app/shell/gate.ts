import { UiSchema } from "@effect/ui";
import { Input } from "@effect/ui-kit";
import { Html } from "@effect/ui/html";
import { Redacted, Schema } from "effect";
import { checkingCopy, gateCopy, noAccessCopy } from "../../view.js";
import { auth, brandMark, productName } from "../config.js";
import { ForgetBearer, RetryLoad, SignIn, SignInWithBearer, SignOut } from "./commands.js";
import { ShellIcon } from "./icons.js";
import { OperatorView } from "./operator-view.js";
import { NoticeLine, StateBlockBusy } from "./parts.js";

const GateMessage = UiSchema.TaggedEnum({
  UpdatedToken: { value: Schema.String },
  SubmittedToken: {},
  ClickedSignIn: {},
  ClickedSignOut: {},
  ClickedRetry: {},
});

const GateMark = <M>(h: Html.H<M>) =>
  brandMark === "connecta"
    ? h.span.class("brand-mark", "gate-mark").attr("aria-hidden", "true")
    : brandMark === "favicon"
      ? h.img.class("brand-mark", "gate-mark").attr("src", "/favicon.svg").attr("alt", "")
      : null;

export const Gate = Html.component({
  name: "Gate",
  props: Schema.Struct({ view: OperatorView }),
  model: Schema.Struct({ token: Schema.String }),
  message: GateMessage,
  restore: false,
}).make({
  init: () => ({ token: "" }),
  update: {
    UpdatedToken: ($, { value }) => $.evolve({ token: value }),
    SubmittedToken: ($) => {
      const value = $.model.token.trim();
      return value ? $.evolve({ token: "" }).run(SignInWithBearer.make({ token: Redacted.make(value) })) : $.model;
    },
    ClickedSignIn: ($) => $.run(SignIn.make()),
    ClickedSignOut: ($) => $.run(SignOut.make()),
    ClickedRetry: ($) => $.run(RetryLoad.make()),
  },
  view: (h, model) => {
    const { state, clerkSignedIn } = h.props.view;
    const signedIn = auth.kind === "clerk" && clerkSignedIn;
    const loading = state.session === "loading";
    return h.section
      .attr("id", "gate")
      .class("gate")
      .attr("aria-busy", loading ? "true" : "false")
      .children(
        GateMark(h),
        h.h1.attr("id", "gateHeading").attr("tabindex", "-1").children("Sign in"),
        h.div.class("gate-card").children(
          loading
            ? StateBlockBusy(h, "gateCopy", checkingCopy())
            : h.p.attr("id", "gateCopy").class("meta").children(gateCopy(auth.kind, signedIn)),
          loading
            ? null
            : auth.kind === "clerk"
              ? h.div
                  .attr("id", "clerkGate")
                  .class("actions")
                  .children(
                    signedIn
                      ? h.button
                          .class("btn")
                          .attr("type", "button")
                          .on("click", GateMessage.ClickedSignOut())
                          .children("Sign out")
                      : h.button
                          .attr("id", "signin")
                          .class("btn", "primary")
                          .attr("type", "button")
                          .on("click", GateMessage.ClickedSignIn())
                          .children("Team sign in"),
                  )
              : auth.kind === "cloudflare-access"
                ? h.div
                    .class("actions")
                    .children(
                      h.button
                        .class("btn", "primary")
                        .attr("type", "button")
                        .on("click", GateMessage.ClickedRetry())
                        .children("Retry"),
                      h.button
                        .class("btn")
                        .attr("type", "button")
                        .on("click", GateMessage.ClickedSignOut())
                        .children("Sign out of Cloudflare Access"),
                    )
                : h.form
                    .attr("id", "tokenGate")
                    .class("row", "gate-form")
                    .on("submit", GateMessage.SubmittedToken(), { preventDefault: "always" })
                    .children(
                      Input(h, {
                        props: { value: model.token },
                        onUpdate: ({ value }) => GateMessage.UpdatedToken({ value }),
                      })
                        .attr("id", "token")
                        .class("input")
                        .attr("type", "password")
                        .attr("placeholder", "Bearer token")
                        .attr("autocomplete", "off")
                        .attr("aria-label", "Bearer token"),
                      h.button
                        .attr("id", "save")
                        .class("btn", "primary")
                        .attr("type", "submit")
                        .children("Open operator pages"),
                    ),
          NoticeLine(h, "err", state.gate),
        ),
      );
  },
});

const NoAccessMessage = UiSchema.TaggedEnum({ ClickedSignOut: {}, ClickedChangeToken: {} });

export const NoAccess = Html.component({
  name: "NoAccess",
  model: Schema.Null,
  message: NoAccessMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    ClickedSignOut: ($) => $.run(SignOut.make()),
    ClickedChangeToken: ($) => $.run(ForgetBearer.make()),
  },
  view: (h) =>
    h.section
      .attr("id", "noAccess")
      .class("gate")
      .children(
        h.span
          .class("gate-mark", "locked")
          .attr("aria-hidden", "true")
          .children(ShellIcon(h, "lock", 22)),
        h.h1.attr("id", "gateHeading").attr("tabindex", "-1").children("No access"),
        h.div
          .class("gate-card")
          .children(
            h.p.class("meta").children(noAccessCopy(auth.kind, productName)),
            h.div
              .class("actions")
              .children(
                auth.kind === "clerk" || auth.kind === "cloudflare-access"
                  ? h.button
                      .class("btn", "default")
                      .attr("type", "button")
                      .on("click", NoAccessMessage.ClickedSignOut())
                      .children("Sign out")
                  : h.button
                      .class("btn", "default")
                      .attr("type", "button")
                      .on("click", NoAccessMessage.ClickedChangeToken())
                      .children("Change token"),
              ),
          ),
      ),
});
