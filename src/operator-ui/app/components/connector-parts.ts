import { Subscription, UiSchema, type View } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Schema, Stream } from "effect";
import type { OperatorConnectorOverlay, OperatorTool } from "../../contract.js";
import type { ConnectorHealth } from "../../health.js";
import { connectorVerdict, formatDate, type ConnectorVerdict } from "../../view.js";
import { Badge, PageLink, Pill, pillStatus } from "./parts.js";
import { Skeleton } from "./skeletons.js";

export function verdictFor(id: string, live: OperatorConnectorOverlay, health: ConnectorHealth): ConnectorVerdict {
  return connectorVerdict(live, Object.hasOwn(health.signals, id) ? health.signals[id] : undefined);
}

const connectorHref = (id: string, tab?: string) => `/connectors/${encodeURIComponent(id)}${tab ? `#${tab}` : ""}`;

export const ConnectorLink = <M>(h: Html.H<M>, id: string, name: string, follow: (href: string) => M) =>
  PageLink(h, connectorHref(id), follow).attr("title", name).attr("aria-label", name).children(name);

export const AuthScopeBadge = <M>(h: Html.H<M>, scope: string) =>
  Badge(h, scope === "personal" ? "Per person" : "Shared");

export interface StoredTools {
  readonly count: number | undefined;
  readonly parked: boolean;
}

export function storedTools(
  live: Pick<OperatorConnectorOverlay, "observedAt" | "storedToolCount" | "problem">,
): StoredTools | undefined {
  return live.observedAt === undefined
    ? undefined
    : { count: live.storedToolCount, parked: live.problem === "connector_timeout" };
}

export function sinceLabel(iso: string, now = Date.now()): string {
  const at = new Date(iso).valueOf();
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
}

const toolCount = <M>(h: Html.H<M>, count: number) => [
  h.span.class("num").children(String(count)),
  count === 1 ? " tool" : " tools",
];

export const ToolSplit = <M>(
  h: Html.H<M>,
  tools: ReadonlyArray<Pick<OperatorTool, "classification">>,
  stored?: StoredTools,
) => {
  const write = tools.filter((tool) => tool.classification === "write").length;
  const read = tools.length - write;
  const readWidth = tools.length ? (read / tools.length) * 100 : 0;
  if (!tools.length && stored)
    return h.div
      .class("tool-split", "awaiting")
      .children(
        h.span
          .class("tool-split-total")
          .children(
            stored.count
              ? toolCount(h, stored.count)
              : stored.parked
                ? h.span.class("meta").children("Tools unknown")
                : Skeleton(h, "sm"),
          ),
        h.span.class(stored.parked ? "tool-split-track" : "skeleton skeleton-bar").attr("aria-hidden", "true"),
      );
  if (!tools.length) return h.div.class("tool-split").children(h.span.class("tool-split-total").children("No tools"));
  return h.div.class("tool-split").children(
    h.span.class("tool-split-total").children(toolCount(h, tools.length)),
    h.span.class("tool-split-counts").children(`${read} read · ${write} write`),
    h
      .el("svg")
      .attrs({ class: "tool-split-bar", viewBox: "0 0 100 6", preserveAspectRatio: "none", "aria-hidden": "true" })
      .children(
        h.el("rect").attrs({ class: "track", width: "100", height: "6" }),
        read ? h.el("rect").attrs({ class: "read", width: String(readWidth), height: "6" }) : null,
        write
          ? h.el("rect").attrs({ class: "write", x: String(readWidth), width: String(100 - readWidth), height: "6" })
          : null,
      ),
  );
};

const StoredStatusMessage = UiSchema.TaggedEnum({ Ticked: {} });

export const StoredStatus = Html.component({
  name: "StoredStatus",
  props: Schema.Struct({ observedAt: Schema.Number, parked: Schema.Boolean }),
  model: Schema.Number,
  message: StoredStatusMessage,
  restore: false,
}).make({
  init: () => 0,
  update: { Ticked: ($) => $.model + 1 },
  subscriptions: ({ props }) =>
    props.parked
      ? [
          Subscription.make(
            "tick",
            Stream.map(Stream.tick("15 seconds"), () => StoredStatusMessage.Ticked()),
          ),
        ]
      : [],
  view: (h) => {
    const at = new Date(h.props.observedAt).toISOString();
    const age = sinceLabel(at, Date.now()).toLowerCase();
    return h.props.parked
      ? h.span
          .class("meta", "stored-status")
          .attr("title", `Stored status, checked ${age}. Refresh to check again. Stored status from ${formatDate(at)}`)
          .children(`Stored status, checked ${age}. Refresh to check again.`)
      : h.span
          .class("meta", "stored-status", "checking")
          .attr("title", `Stored status from ${formatDate(at)}, checking live`)
          .children(h.span.class("spinner").attr("aria-hidden", "true"), "Checking…");
  },
});

export const ProblemAction = <M>(
  h: Html.H<M>,
  options: {
    readonly id: string;
    readonly name: string;
    readonly action: string;
    readonly follow: (href: string) => M;
  },
) =>
  PageLink(h, connectorHref(options.id, "connection"), options.follow)
    .class("btn", "sm", "problem-action")
    .attr("aria-label", `${options.action} ${options.name}`)
    .children(options.action);

export const ConnectorStatusDot = <M>(
  h: Html.H<M>,
  options: {
    readonly id: string;
    readonly name: string;
    readonly live: OperatorConnectorOverlay;
    readonly health: ConnectorHealth;
    readonly follow: (href: string) => M;
  },
) => {
  const verdict = verdictFor(options.id, options.live, options.health);
  return verdict.action
    ? PageLink(h, connectorHref(options.id, "connection"), options.follow)
        .class("status-dot-link")
        .attr("title", verdict.label)
        .attr("aria-label", `${verdict.action} ${options.name}`)
        .children(h.span.class("dot", verdict.tone).attr("aria-hidden", "true"))
    : null;
};

export const VerdictPill = <M>(h: Html.H<M>, verdict: ConnectorVerdict) =>
  Pill(h, pillStatus(verdict.tone), verdict.label);

export const ConnectorCardSkeleton = <M>(
  h: Html.H<M>,
  options: {
    readonly key: string;
    readonly title?: View.Input<M>;
    readonly id?: string;
    readonly description?: string;
  },
) =>
  h.li
    .key(options.key)
    .class("connector-card", "pending")
    .attr("aria-busy", "true")
    .children(
      h.div
        .class("connector-card-top")
        .children(
          h.div
            .class("connector-card-name")
            .children(
              h.h3.children(options.title ?? Skeleton(h, "lg")),
              h.span
                .class("connector-card-sub")
                .children(
                  options.id ? h.code.attr("title", options.id).children(options.id) : Skeleton(h, "sm"),
                  Skeleton(h, "xs", "skeleton-badge"),
                ),
            ),
          Skeleton(h, "sm", "skeleton-pill"),
        ),
      options.description !== undefined ? h.p.class("connector-card-description").children(options.description) : null,
      h.div
        .class("tool-split")
        .children(
          h.span.class("tool-split-total").children(Skeleton(h, "sm")),
          h.span.class("skeleton", "skeleton-bar").attr("aria-hidden", "true"),
        ),
      h.div
        .class("connector-card-foot")
        .children(
          h.span
            .class("connector-card-last")
            .children(h.span.class("meta").children("Last call"), " ", Skeleton(h, "xs")),
        ),
    );

export const ConnectorsSkeleton = <M>(h: Html.H<M>) =>
  h.section
    .class("section")
    .attr("aria-busy", "true")
    .children(
      h.p.class("visually-hidden").attr("role", "status").children("Loading configuration…"),
      h.div
        .class("connector-toolbar")
        .attr("aria-hidden", "true")
        .children(Skeleton(h, "lg", "skeleton-control"), Skeleton(h, "lg", "skeleton-control")),
      h.ul
        .class("connector-grid")
        .attr("aria-hidden", "true")
        .children(Array.from({ length: 6 }, (_, index) => ConnectorCardSkeleton(h, { key: String(index) }))),
    );
