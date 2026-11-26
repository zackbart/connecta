import { Mount, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Queue, Schema, Stream } from "effect";
import { ShellIcon } from "./icons.js";

const TrackOutside = Mount.makeStream(
  "TrackOutside",
  { args: { open: Schema.Boolean } },
  (node: HTMLElement, { open: initial }, changes) =>
    Stream.callback<"dismissed">((queue) =>
      Effect.gen(function* () {
        let open = initial;
        yield* Stream.runForEach(changes, (args) => Effect.sync(() => (open = args.open))).pipe(Effect.forkScoped);
        const dismiss = () => void Queue.offerUnsafe(queue, "dismissed");
        const onPointer = (event: PointerEvent) => {
          if (open && !node.contains(event.target as Node)) dismiss();
        };
        const onKey = (event: KeyboardEvent) => {
          if (!open || event.key !== "Escape") return;
          dismiss();
          node.querySelector<HTMLElement>(".account-trigger")?.focus();
        };
        const onFocusOut = (event: FocusEvent) => {
          const next = event.relatedTarget as Node | null;
          if (open && next && !node.contains(next)) dismiss();
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            document.addEventListener("pointerdown", onPointer);
            document.addEventListener("keydown", onKey);
            node.addEventListener("focusout", onFocusOut);
          }),
          () =>
            Effect.sync(() => {
              document.removeEventListener("pointerdown", onPointer);
              document.removeEventListener("keydown", onKey);
              node.removeEventListener("focusout", onFocusOut);
            }),
        );
      }),
    ),
);

const AccountMenuMessage = UiSchema.TaggedEnum({
  ClickedTrigger: {},
  CompletedTrackOutside: {},
  ClickedSessionAction: {},
});

const AccountMenuEvents = UiSchema.TaggedEnum({ RequestedSessionAction: {} });

export const AccountMenu = Html.component({
  name: "AccountMenu",
  props: Schema.Struct({
    account: Schema.NullOr(Schema.String),
    role: Schema.String,
    action: Schema.Literals(["signOut", "changeToken"]),
  }),
  model: Schema.Struct({ open: Schema.Boolean }),
  message: AccountMenuMessage,
  events: AccountMenuEvents,
  restore: false,
}).make({
  init: () => ({ open: false }),
  update: {
    ClickedTrigger: ($) => $.evolve({ open: (open) => !open }),
    CompletedTrackOutside: ($) => $.evolve({ open: false }),
    ClickedSessionAction: ($) => $.emit(AccountMenuEvents.RequestedSessionAction()),
  },
  view: (h, { open }) => {
    const { account, role, action } = h.props;
    const panel = h.id("panel");
    const initial = account?.trim().charAt(0).toUpperCase();
    return h.div
      .class("account-menu")
      .onMount(TrackOutside({ open }).pipe(Mount.map(() => AccountMenuMessage.CompletedTrackOutside())))
      .children(
        h.button
          .attr("type", "button")
          .class("account-trigger")
          .attr("aria-label", "Account")
          .attr("title", "Account")
          .attr("aria-expanded", open ? "true" : "false")
          .attr("aria-controls", panel)
          .on("click", AccountMenuMessage.ClickedTrigger())
          .children(
            h.span
              .class("account-avatar")
              .attr("aria-hidden", "true")
              .children(initial ? initial : ShellIcon(h, "user", 15)),
          ),
        h.div
          .attr("id", panel)
          .class("account-panel")
          .attr("hidden", open ? undefined : "")
          .children(
            h.div
              .class("account-who")
              .children(h.p.class("account-label").children(account ?? "Signed in"), h.p.class("meta").children(role)),
            h.div.class("account-session").children(
              h.button
                .class("btn", "quiet", "session-action")
                .on("click", AccountMenuMessage.ClickedSessionAction())
                .children(
                  ShellIcon(h, action === "signOut" ? "logout" : "key", 15),
                  action === "signOut" ? "Sign out" : "Change token",
                ),
            ),
          ),
      );
  },
});
