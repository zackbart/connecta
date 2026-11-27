import type { Html } from "@effect/ui/html";
import {
  activityDetail,
  activityOutcomeBadge,
  activityOutcomeClass,
  activityReason,
  actorLabel,
  actorStableId,
  type UiActivityEvent,
} from "../../view.js";
import { Icon } from "./icons.js";
import { ActorChip, ConnectorMark } from "./marks.js";

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  search: "Search",
  describe: "Describe",
  result: "Result page",
  skill: "Skill read",
  program: "Program",
  authorize: "Authorize",
};

function shortTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function grouped(events: ReadonlyArray<UiActivityEvent>): Array<[string, UiActivityEvent[]]> {
  const groups = new Map<string, UiActivityEvent[]>();
  events.forEach((event, index) => {
    const key = event.requestId ? `request:${event.requestId}` : `ungrouped:${index}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  });
  return [...groups];
}

const Detail = <M>(h: Html.H<M>, label: string, value: string, mono = false) =>
  value ? h.div.key(label).children(h.dt.children(label), h.dd.class(mono && "mono").children(value)) : null;

const CallRow = <M>(
  h: Html.H<M>,
  key: string,
  event: UiActivityEvent,
  first: boolean,
  title: string,
  showConnector: boolean,
) => {
  const operation = event.kind === "operation";
  const outcome = activityOutcomeClass(event.outcome);
  const badge = activityOutcomeBadge(event.outcome);
  const reason = activityReason(event);
  const stable = event.actor?.kind === "access_token" ? null : actorStableId(event.actor);
  const client = [event.clientName, event.clientVersion].filter(Boolean).join(" ");
  return h.details
    .key(key)
    .class("activity-item", outcome, operation && "operation")
    .children(
      h.summary.class("activity-row").children(
        h.span
          .class("activity-status", outcome)
          .attr("title", badge.label)
          .children(h.span.class("visually-hidden").children(badge.label)),
        h.time
          .class("activity-time")
          .attr("datetime", event.occurredAt)
          .children(first ? shortTime(event.occurredAt) : null),
        h.span.class("activity-actor").children(first ? ActorChip(h, event.actor) : null),
        h.span
          .class("activity-tool")
          .children(
            showConnector && !operation ? ConnectorMark(h, event.connectorId, title, "sm") : null,
            h.span
              .class("activity-address")
              .children(operation ? `Connecta · ${OPERATION_LABELS[event.toolName] ?? "Operation"}` : event.address),
            event.classification === "write" ? h.span.class("activity-write").children("write") : null,
            reason && outcome !== "success" ? h.span.class("activity-reason").children(reason) : null,
          ),
        h.span.class("activity-metric", "activity-duration").children(formatDuration(event.durationMs)),
        h.span.class("activity-metric", "activity-size").children(formatBytes(event.resultBytes)),
        h.span.class("activity-chevron").attr("aria-hidden", "true"),
      ),
      h.dl
        .class("activity-detail")
        .children(
          Detail(h, "Result", reason ? `${badge.label} · ${reason}` : badge.label),
          Detail(h, "Via", activityDetail({ ...event, friction: "", errorCode: "" })),
          Detail(h, "Kind", event.classification ?? ""),
          Detail(h, "Duration", Number.isFinite(event.durationMs) ? `${event.durationMs} ms` : ""),
          Detail(h, "Size", Number.isFinite(event.resultBytes) ? `${event.resultBytes} bytes` : ""),
          Detail(h, "Caller", actorLabel(event.actor)),
          Detail(h, "Caller ID", stable ?? "", true),
          Detail(h, "Request", event.requestId ?? "", true),
          Detail(h, "Client", client),
          Detail(h, "Connecta", event.packageVersion ?? ""),
        ),
    );
};

const CatalogRow = <M>(h: Html.H<M>, key: string, event: UiActivityEvent, title: string, showConnector: boolean) => {
  const drift = event.drift!;
  return h.div
    .key(key)
    .class("activity-item", "catalog")
    .children(
      h.div.class("activity-row").children(
        h.span
          .class("activity-status", "catalog")
          .attr("title", "Catalog change")
          .children(h.span.class("visually-hidden").children("Catalog change")),
        h.time.class("activity-time").attr("datetime", event.occurredAt).children(shortTime(event.occurredAt)),
        h.span.class("activity-actor").children(
          h.span.class("actor-chip", "other").children(
            h.span
              .class("actor-unknown")
              .attr("aria-hidden", "true")
              .children(Icon(h, "refresh", 11)),
            h.span.class("actor-chip-text").children("Refresh"),
          ),
        ),
        h.span
          .class("activity-tool")
          .children(
            showConnector ? ConnectorMark(h, event.connectorId, title, "sm") : null,
            h.span.class("activity-catalog").children(showConnector ? `${title} catalog changed` : "Catalog changed"),
          ),
        h.span
          .class("activity-metric", "activity-drift")
          .attr("title", "Added, removed, changed")
          .children(
            h.span
              .class("visually-hidden")
              .children(`${drift.addedTools} added, ${drift.removedTools} removed, ${drift.changedTools} changed`),
            h.span
              .attr("aria-hidden", "true")
              .children(
                h.span.class("added").children(`+${drift.addedTools}`),
                " ",
                h.span.class("removed").children(`−${drift.removedTools}`),
                " ",
                h.span.class("changed").children(`~${drift.changedTools}`),
              ),
          ),
        h.span.class("activity-chevron", "none").attr("aria-hidden", "true"),
      ),
    );
};

export const ActivityList = <M>(
  h: Html.H<M>,
  options: {
    readonly events: ReadonlyArray<UiActivityEvent>;
    readonly busy: boolean;
    readonly titles: ReadonlyMap<string, string>;
    readonly showConnector: boolean;
  },
) =>
  h.div
    .attr("id", "activityList")
    .class("activity-list")
    .attr("aria-busy", options.busy ? "true" : "false")
    .children(
      grouped(options.events).map(([groupKey, group]) =>
        h.section
          .key(groupKey)
          .class("request-group", group.length > 1 && "multi")
          .attr("aria-label", group[0]?.requestId ? `Request ${group[0].requestId}` : "Ungrouped call")
          .children(
            group.map((event, index) => {
              const title = options.titles.get(event.connectorId) ?? event.connectorId;
              const key = event.id ?? `${event.occurredAt}-${event.address}-${index}`;
              return event.kind === "catalog_drift" && event.drift
                ? CatalogRow(h, key, event, title, options.showConnector)
                : CallRow(h, key, event, index === 0, title, options.showConnector);
            }),
          ),
      ),
    );
