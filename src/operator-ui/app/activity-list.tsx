import {
  activityDetail,
  activityOutcomeBadge,
  activityOutcomeClass,
  activityReason,
  actorLabel,
  actorStableId,
  type UiActivityEvent,
} from "../view.js";
import { ActorChip, ConnectorMark } from "./marks.js";
import { Icon } from "./icons.js";

/**
 * Loaded activity as rows, grouped by request: one status dot, when, who,
 * which connector and tool, and duration and size in a right-hand column.
 * A row opens in place for the rest of what was recorded. The Activity page
 * and a connector's Activity tab draw this same list.
 */

/** Month, day and minute, the same on every machine for one time zone. */
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

/** Missing IDs are separate calls, never an invented multi-call request. */
function grouped(events: UiActivityEvent[]): [string, UiActivityEvent[]][] {
  const groups = new Map<string, UiActivityEvent[]>();
  events.forEach((event, index) => {
    const key = event.requestId ? `request:${event.requestId}` : `ungrouped:${index}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  });
  return [...groups];
}

function Detail({ label, children, mono }: { label: string; children: string; mono?: boolean }) {
  return children ? (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{children}</dd>
    </div>
  ) : null;
}

function CallRow({
  event,
  first,
  title,
  showConnector,
}: {
  event: UiActivityEvent;
  first: boolean;
  title: string;
  showConnector: boolean;
}) {
  const outcome = activityOutcomeClass(event.outcome);
  const badge = activityOutcomeBadge(event.outcome);
  const reason = activityReason(event);
  // An agent's name is its identity; only a person's label needs the id behind it.
  const stable = event.actor?.kind === "access_token" ? null : actorStableId(event.actor);
  const client = [event.clientName, event.clientVersion].filter(Boolean).join(" ");
  return (
    <details className={`activity-item ${outcome}`}>
      <summary className="activity-row">
        <span className={`activity-status ${outcome}`} title={badge.label}>
          <span className="visually-hidden">{badge.label}</span>
        </span>
        <time className="activity-time" dateTime={event.occurredAt}>
          {first ? shortTime(event.occurredAt) : null}
        </time>
        <span className="activity-actor">{first ? <ActorChip actor={event.actor} /> : null}</span>
        <span className="activity-tool">
          {showConnector ? <ConnectorMark id={event.connectorId} title={title} size="sm" /> : null}
          <span className="activity-address">{event.address}</span>
          {event.classification === "write" ? <span className="activity-write">write</span> : null}
          {reason && outcome !== "success" ? <span className="activity-reason">{reason}</span> : null}
        </span>
        <span className="activity-metric activity-duration">{formatDuration(event.durationMs)}</span>
        <span className="activity-metric activity-size">{formatBytes(event.resultBytes)}</span>
        <span className="activity-chevron" aria-hidden="true" />
      </summary>
      <dl className="activity-detail">
        <Detail label="Result">{reason ? `${badge.label} · ${reason}` : badge.label}</Detail>
        <Detail label="Via">{activityDetail({ ...event, friction: "", errorCode: "" })}</Detail>
        <Detail label="Kind">{event.classification ?? ""}</Detail>
        <Detail label="Duration">{Number.isFinite(event.durationMs) ? `${event.durationMs} ms` : ""}</Detail>
        <Detail label="Size">{Number.isFinite(event.resultBytes) ? `${event.resultBytes} bytes` : ""}</Detail>
        <Detail label="Caller">{actorLabel(event.actor)}</Detail>
        <Detail label="Caller ID" mono>
          {stable ?? ""}
        </Detail>
        <Detail label="Request" mono>
          {event.requestId ?? ""}
        </Detail>
        <Detail label="Client">{client}</Detail>
        <Detail label="Connecta">{event.packageVersion ?? ""}</Detail>
      </dl>
    </details>
  );
}

function CatalogRow({
  event,
  title,
  showConnector,
}: {
  event: UiActivityEvent;
  title: string;
  showConnector: boolean;
}) {
  const drift = event.drift!;
  return (
    <div className="activity-item catalog">
      <div className="activity-row">
        <span className="activity-status catalog" title="Catalog change">
          <span className="visually-hidden">Catalog change</span>
        </span>
        <time className="activity-time" dateTime={event.occurredAt}>
          {shortTime(event.occurredAt)}
        </time>
        <span className="activity-actor">
          <span className="actor-chip other">
            <span className="actor-unknown" aria-hidden="true">
              <Icon name="refresh" size={11} />
            </span>
            <span className="actor-chip-text">Refresh</span>
          </span>
        </span>
        <span className="activity-tool">
          {showConnector ? <ConnectorMark id={event.connectorId} title={title} size="sm" /> : null}
          <span className="activity-catalog">{showConnector ? `${title} catalog changed` : "Catalog changed"}</span>
        </span>
        <span className="activity-metric activity-drift" title="Added, removed, changed">
          <span className="visually-hidden">
            {drift.addedTools} added, {drift.removedTools} removed, {drift.changedTools} changed
          </span>
          <span aria-hidden="true">
            <span className="added">+{drift.addedTools}</span> <span className="removed">−{drift.removedTools}</span>{" "}
            <span className="changed">~{drift.changedTools}</span>
          </span>
        </span>
        <span className="activity-chevron none" aria-hidden="true" />
      </div>
    </div>
  );
}

export function ActivityList({
  events,
  busy,
  titles,
  showConnector = true,
}: {
  events: UiActivityEvent[];
  busy: boolean;
  /** Connector titles by id; an unknown id shows as itself. */
  titles: ReadonlyMap<string, string>;
  showConnector?: boolean;
}) {
  return (
    <div id="activityList" className="activity-list" aria-busy={busy ? "true" : "false"}>
      {grouped(events).map(([key, group]) => (
        <section
          key={key}
          className={group.length > 1 ? "request-group multi" : "request-group"}
          aria-label={group[0]?.requestId ? `Request ${group[0].requestId}` : "Ungrouped call"}
        >
          {group.map((event, index) => {
            const title = titles.get(event.connectorId) ?? event.connectorId;
            const key = event.id ?? `${event.occurredAt}-${event.address}-${index}`;
            return event.kind === "catalog_drift" && event.drift ? (
              <CatalogRow key={key} event={event} title={title} showConnector={showConnector} />
            ) : (
              <CallRow key={key} event={event} first={index === 0} title={title} showConnector={showConnector} />
            );
          })}
        </section>
      ))}
    </div>
  );
}
