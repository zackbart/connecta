import type { View } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import type { AccessChip } from "../../endpoints.js";
import type { Notice } from "../../view.js";
import { Icon } from "./icons.js";

export const NoticeLine = <M>(h: Html.H<M>, id: string, notice: Notice | null) =>
  h.p
    .attr("id", id)
    .class("notice", notice?.tone === "error" && "error-notice")
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
    .class("card", ...options.className.split(" "))
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
