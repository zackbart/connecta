import { Command, Component, UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Effect, Schema } from "effect";
import { Icon } from "./icons.js";

export const CopyButtonMessage = UiSchema.TaggedEnum({
  ClickedCopy: {},
  SucceededCopyText: {},
  FailedCopyText: {},
  CompletedWaitBeforeReset: {},
});
export type CopyButtonMessage = typeof CopyButtonMessage.Type;

export const copyToClipboard = (value: string) =>
  Effect.tryPromise(() => navigator.clipboard.writeText(value)).pipe(
    Effect.match({
      onSuccess: () => CopyButtonMessage.SucceededCopyText(),
      onFailure: () => CopyButtonMessage.FailedCopyText(),
    }),
  );

export class CopyText extends Command.Service<CopyText>()("operator/CopyText", {
  args: { value: Schema.String },
  success: CopyButtonMessage,
}) {
  static readonly layer = this.toLayer(({ value }) => copyToClipboard(value));
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

export const CopyLabels = {
  label: Schema.String,
  className: Schema.String,
  ariaLabel: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.Boolean),
  id: Schema.optional(Schema.String),
};

export const CopyStatus = Schema.Struct({ status: Schema.Literals(["idle", "copied", "failed"]) });
type CopyStatus = typeof CopyStatus.Type;

export const CopyButtonView = (
  h: Html.H<CopyButtonMessage>,
  props: {
    readonly label: string;
    readonly className: string;
    readonly ariaLabel?: string | undefined;
    readonly icon?: boolean | undefined;
    readonly id?: string | undefined;
  },
  { status }: CopyStatus,
) => {
  const text = status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : props.label;
  return h.button
    .class(...props.className.split(" "), props.icon === true && "quiet", props.icon === true && "icon")
    .attr("type", "button")
    .attr("id", props.id)
    .attr("title", props.icon === true ? text : undefined)
    .attr("aria-label", status === "idle" ? props.ariaLabel : undefined)
    .on("click", CopyButtonMessage.ClickedCopy())
    .children(
      props.icon === true
        ? [Icon(h, status === "copied" ? "check" : "copy", 15), h.span.class("visually-hidden").children(text)]
        : text,
    );
};

const CopyButtonNoDeps = Html.component({
  name: "CopyButton",
  props: Schema.Struct({ value: Schema.String, ...CopyLabels }),
  model: CopyStatus,
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
  view: (h, model) => CopyButtonView(h, h.props, model),
});

export const CopyButton = CopyButtonNoDeps.pipe(Component.provide([CopyText.layer, WaitBeforeReset.layer]));
