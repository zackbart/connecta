import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema } from "effect";

const CopyButtonMessage = UiSchema.TaggedEnum({
  ClickedCopy: {},
  SucceededCopyText: {},
  FailedCopyText: {},
  CompletedWaitBeforeReset: {},
});

export class CopyText extends Command.Service<CopyText>()("operator/CopyText", {
  args: { value: Schema.String },
  success: CopyButtonMessage,
}) {
  static readonly layer = this.toLayer(({ value }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(value)).pipe(
      Effect.match({
        onSuccess: () => CopyButtonMessage.SucceededCopyText(),
        onFailure: () => CopyButtonMessage.FailedCopyText(),
      }),
    ),
  );
}

export class WaitBeforeReset extends Command.Service<WaitBeforeReset>()("operator/WaitBeforeReset", {
  args: {},
  success: CopyButtonMessage,
  mode: "switch",
}) {
  static readonly layer = this.toLayer(() =>
    Effect.as(Effect.sleep("1600 millis"), CopyButtonMessage.CompletedWaitBeforeReset()),
  );
}

const CopyButtonNoDeps = Html.component({
  name: "CopyButton",
  props: Schema.Struct({
    value: Schema.String,
    label: Schema.String,
    className: Schema.String,
    ariaLabel: Schema.String,
  }),
  model: Schema.Struct({ status: Schema.Literals(["idle", "copied", "failed"]) }),
  message: CopyButtonMessage,
  restore: false,
}).make({
  init: () => ({ status: "idle" as const }),
  update: {
    ClickedCopy: ($) => $.run(CopyText.make({ value: $.props.value })),
    SucceededCopyText: ($) => $.evolve({ status: "copied" }).run(WaitBeforeReset.make()),
    FailedCopyText: ($) => $.evolve({ status: "failed" }).run(WaitBeforeReset.make()),
    CompletedWaitBeforeReset: ($) => $.evolve({ status: "idle" }),
  },
  view: (h, { status }) =>
    h.button
      .class(...h.props.className.split(" "))
      .attr("type", "button")
      .attr("aria-label", status === "idle" ? h.props.ariaLabel : undefined)
      .on("click", CopyButtonMessage.ClickedCopy())
      .children(status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : h.props.label),
});

export const CopyButton = CopyButtonNoDeps.pipe(Component.provide([CopyText.layer, WaitBeforeReset.layer]));
