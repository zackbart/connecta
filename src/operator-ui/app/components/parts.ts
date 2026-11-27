import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import type { AccessChip } from "../../endpoints.js";
import { fixPrompt, type FixPromptKind } from "../../fix-prompts.js";
import type { Notice, Tone } from "../../view.js";
import { CopyButton } from "./copy-button.js";
import { TakeRequestedFocus } from "./focus.js";
import { Icon } from "./icons.js";

export const NoticeLine = <M>(h: Html.H<M>, id: string, notice: Notice | null, className?: string) =>
  h.p
    .attr("id", id)
    .class("notice", className, notice?.tone === "error" && "error-notice")
    .attr("role", notice?.tone === "error" ? "alert" : "status")
    .attr("aria-live", "polite")
    .attr("tabindex", "-1")
    .children(notice ? notice.message : "");

export interface StateBlockOptions<M> {
  readonly title?: string;
  readonly copy?: string | null;
  readonly tone?: "neutral" | "error";
  readonly busy?: boolean;
  readonly id?: string;
  readonly action?: { readonly label: string; readonly message: M; readonly id?: string };
}

export const StateBlock = <M>(h: Html.H<M>, options: StateBlockOptions<M>) => {
  const error = options.tone === "error";
  const { action } = options;
  return h.div
    .class("state-block", error ? "error" : options.busy && "busy")
    .attr("role", error ? "alert" : "status")
    .attr("id", options.id)
    .children(
      error
        ? h.span.class("state-mark").children(Icon(h, "alert", 20))
        : options.busy
          ? h.span.class("spinner").attr("aria-hidden", "true")
          : null,
      options.title ? h.p.class("state-title").children(options.title) : null,
      options.copy ? h.p.class("state-copy").children(options.copy) : null,
      action
        ? h.button
            .class("btn")
            .attr("type", "button")
            .attr("id", action.id)
            .on("click", action.message)
            .children(action.label)
        : null,
    );
};

export type PillStatus = "healthy" | "attention" | "error" | "neutral" | "info";

export const pillStatus = (tone: Tone): PillStatus =>
  tone === "ok"
    ? "healthy"
    : tone === "warn"
      ? "attention"
      : tone === "danger"
        ? "error"
        : tone === "accent"
          ? "info"
          : "neutral";

const PILL_TONE: Record<PillStatus, string | false> = {
  healthy: "ok",
  attention: "warn",
  error: "danger",
  neutral: false,
  info: "accent",
};

export const Pill = <M>(h: Html.H<M>, status: PillStatus, label: string | ReadonlyArray<string>) =>
  h.span
    .class("badge", "pill", PILL_TONE[status])
    .attr("title", typeof label === "string" ? label : undefined)
    .children(h.span.class("pill-dot").attr("aria-hidden", "true"), h.span.class("pill-label").children(label));

export const MemberMark = <M>(h: Html.H<M>, chip: Pick<AccessChip, "kind" | "initials" | "hue">, muted = false) =>
  chip.kind === "agent"
    ? h.span
        .class("agent-mark", muted && "muted")
        .attr("aria-hidden", "true")
        .children(Icon(h, "agent", 12))
    : h.span.class("avatar", `hue-${chip.hue}`).attr("aria-hidden", "true").children(chip.initials);

export const Card = <M, C extends View.Children<M>>(
  h: Html.H<M>,
  options: {
    readonly className: string;
    readonly label?: string;
    readonly title?: string;
    readonly titleId?: string;
    readonly children: C;
  },
) =>
  h.section
    .class("card", ...options.className.split(" ").filter(Boolean))
    .attr("aria-label", options.label)
    .children(
      options.title
        ? h.div
            .class("card-head")
            .children(h.div.class("card-heading").children(h.h2.attr("id", options.titleId).children(options.title)))
        : null,
      h.div.class("card-body").children(options.children),
    );

interface LinkClick {
  readonly button: number;
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

const followed =
  <M>(message: M) =>
  (click: LinkClick): M | undefined =>
    click.button !== 0 || click.meta || click.ctrl || click.shift || click.alt ? undefined : message;

export const PageLink = <M>(h: Html.H<M>, href: string, follow: (href: string) => M) =>
  h.a.attr("href", href).on("click", followed(follow(href)), { preventDefault: true });

export const Badge = <M>(h: Html.H<M>, label: string, tone: Tone = "neutral") =>
  h.span
    .class("badge", "tag", tone !== "neutral" && tone)
    .attr("title", label)
    .children(label);

export const Callout = <M>(h: Html.H<M>, tone: "problem" | "notice", copy: string) =>
  h.div.class("msg", "callout", tone === "notice" && "warn").children(Icon(h, "alert"), h.p.children(copy));

export const SummaryRow = <M>(
  h: Html.H<M>,
  className: string,
  items: ReadonlyArray<{ readonly label: string; readonly value: View.Input<M> }>,
) =>
  h.dl
    .class("summary-row", className)
    .children(
      items.map((item) => h.div.key(item.label).children(h.dt.children(item.label), h.dd.children(item.value))),
    );

export const FixPrompt = <M>(
  h: Html.H<M>,
  options: {
    readonly kind: FixPromptKind;
    readonly connectorId: string;
    readonly name?: string;
    readonly key?: string;
  },
) =>
  h.div
    .class("fix-prompt")
    .attr("data-fix-prompt", options.kind)
    .children(
      CopyButton(h, {
        key: options.key ?? `${options.kind}:${options.connectorId}`,
        props: {
          value: fixPrompt(options.kind, options.connectorId),
          label: "Copy fix prompt",
          className: "btn sm copy-btn",
          ariaLabel: `Copy fix prompt for ${options.name ?? options.connectorId}`,
        },
      }),
      h.details
        .class("fix-prompt-preview")
        .children(
          h.summary.class("disclosure").children("Preview prompt"),
          h.p.class("meta").children("For a coding agent. No error details or secrets."),
          h.pre.class("fix-prompt-text").children(fixPrompt(options.kind, options.connectorId)),
        ),
    );

export const NoticeWithFix = <M>(h: Html.H<M>, id: string, notice: Notice | null) => [
  NoticeLine(h, id, notice, "meta"),
  notice?.tone === "error" && notice.fix
    ? FixPrompt(h, { kind: notice.fix.kind, connectorId: notice.fix.connectorId, key: `notice:${id}` })
    : null,
];

export const ConfirmAction = <M>(h: Html.H<M>, label: string) =>
  h.button.class("btn", "danger").attr("type", "button").children(label);

export const ConfirmBar = <M, R>(
  h: Html.H<M>,
  options: { readonly id: string; readonly question: string; readonly confirm: View.Content<M, R>; readonly cancel: M },
) =>
  h.div
    .class("confirm")
    .attr("role", "group")
    .attr("aria-labelledby", `confirm-question-${options.id}`)
    .on("keydown", ({ key }) => (key === "Escape" ? options.cancel : undefined), { preventDefault: true })
    .children(
      h.p.attr("id", `confirm-question-${options.id}`).children(options.question),
      h.div
        .class("actions")
        .children(
          options.confirm,
          h.button
            .attr("id", `confirm-cancel-${options.id}`)
            .class("btn", "quiet")
            .attr("type", "button")
            .on("click", options.cancel)
            .onMount(TakeRequestedFocus())
            .children("Cancel"),
        ),
    );

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly count?: number;
}

export const SegmentedControl = <M, T extends string>(
  h: Html.H<M>,
  options: {
    readonly label: string;
    readonly value: T;
    readonly options: ReadonlyArray<SegmentOption<T>>;
    readonly select: (value: T) => M;
  },
) =>
  h.div
    .class("segmented")
    .attr("role", "group")
    .attr("aria-label", options.label)
    .children(
      options.options.map((option) =>
        h.button
          .key(option.value)
          .attr("type", "button")
          .attr("aria-pressed", option.value === options.value ? "true" : "false")
          .on("click", options.select(option.value))
          .children(
            option.label,
            option.count === undefined ? null : h.span.class("segment-count").children(String(option.count)),
          ),
      ),
    );
