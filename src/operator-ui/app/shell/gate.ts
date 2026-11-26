import { Mount, UiSchema } from "@effect/ui";
import { Button } from "@effect/ui-kit";
import { Html } from "@effect/ui/html";
import { Effect, Schema, Stream } from "effect";
import { checkingCopy, gateCopy, noAccessCopy } from "../../view.js";
import { auth, brandMark, productName } from "../config.js";
import { starterIn } from "../run.js";
import { OperatorController } from "../services/controller.js";
import { ForgetBearer, RetryLoad, SignIn, SignOut } from "./commands.js";
import { ShellIcon } from "./icons.js";
import { OperatorView } from "./operator-view.js";
import { NoticeLine, StateBlockBusy } from "./parts.js";

const SubmitBearer = Mount.makeStream("SubmitBearer", { args: {} }, (form: HTMLFormElement) =>
  Stream.callback<never, never, OperatorController>(() =>
    Effect.gen(function* () {
      const controller = yield* OperatorController;
      const start = starterIn(yield* Effect.context<never>());
      const onSubmit = (event: SubmitEvent) => {
        event.preventDefault();
        const field = form.elements.namedItem("token");
        if (!(field instanceof HTMLInputElement)) return;
        const value = field.value.trim();
        if (!value) return;
        field.value = "";
        start(controller.signInWithBearer(value));
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => form.addEventListener("submit", onSubmit)),
        () => Effect.sync(() => form.removeEventListener("submit", onSubmit)),
      );
    }),
  ),
);

export const GateMessage = UiSchema.TaggedEnum({
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
  model: Schema.Null,
  message: GateMessage,
  restore: false,
}).make({
  init: () => null,
  update: {
    ClickedSignIn: ($) => $.run(SignIn.make()),
    ClickedSignOut: ($) => $.run(SignOut.make()),
    ClickedRetry: ($) => $.run(RetryLoad.make()),
  },
  view: (h) => {
    const { session, gate, clerkSignedIn } = h.props.view;
    const signedIn = auth.kind === "clerk" && clerkSignedIn;
    const loading = session === "loading";
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
                      ? Button(h, { onPress: GateMessage.ClickedSignOut() }).class("btn").children("Sign out")
                      : Button(h, { onPress: GateMessage.ClickedSignIn() })
                          .attr("id", "signin")
                          .class("btn", "primary")
                          .children("Team sign in"),
                  )
              : auth.kind === "cloudflare-access"
                ? h.div
                    .class("actions")
                    .children(
                      Button(h, { onPress: GateMessage.ClickedRetry() }).class("btn", "primary").children("Retry"),
                      Button(h, { onPress: GateMessage.ClickedSignOut() })
                        .class("btn")
                        .children("Sign out of Cloudflare Access"),
                    )
                : h.form
                    .attr("id", "tokenGate")
                    .class("row", "gate-form")
                    .onMount(SubmitBearer())
                    .children(
                      h.input
                        .attr("id", "token")
                        .class("input")
                        .attr("type", "password")
                        .attr("placeholder", "Bearer token")
                        .attr("autocomplete", "off")
                        .attr("aria-label", "Bearer token"),
                      Button(h, { props: { type: "submit" } })
                        .attr("id", "save")
                        .class("btn", "primary")
                        .children("Open operator pages"),
                    ),
          NoticeLine(h, "err", gate),
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
                  ? Button(h, { onPress: NoAccessMessage.ClickedSignOut() })
                      .class("btn", "default")
                      .children("Sign out")
                  : Button(h, { onPress: NoAccessMessage.ClickedChangeToken() })
                      .class("btn", "default")
                      .children("Change token"),
              ),
          ),
      ),
});
