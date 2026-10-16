import type { ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  activityOutcomeClass,
  activityReadable,
  activitySummary,
  contractRecovering,
  filterActivity,
  type OperatorState,
  type UiActivityEvent,
} from "../view.js";
import { LoadFailure, NoticeLine, StateBlock, Unavailable } from "./parts.js";
import { Button, SegmentedControl } from "./primitives.js";
import { Icon } from "./icons.js";
import { ConnectorMark } from "./marks.js";
import { ActivityList } from "./activity-list.js";
import { loadActivity, retryCollection, setActivitySearch } from "./store.js";

type OutcomeFilter = "" | "failed" | "succeeded";

const OUTCOME_OPTIONS = [
  { value: "", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "succeeded", label: "Succeeded" },
] as const satisfies readonly { value: OutcomeFilter; label: string }[];

/** Which recorded outcomes each filter keeps; any other value matches itself, as older links sent it. */
const OUTCOME_CLASSES: Readonly<Record<string, readonly string[]>> = {
  failed: ["error", "timeout"],
  succeeded: ["success", "approved"],
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  call_tool: "Direct",
  call_destructive_tool: "Approved",
  execute_code: "Program",
  batch_call: "Batch",
  catalog_refresh: "Catalog",
};

function failedCall(event: UiActivityEvent): boolean {
  return event.kind !== "catalog_drift" && OUTCOME_CLASSES.failed!.includes(activityOutcomeClass(event.outcome));
}

function outcomeMatches(event: UiActivityEvent, outcome: string): boolean {
  if (!outcome) return true;
  if (event.kind === "catalog_drift") return false;
  const classes = OUTCOME_CLASSES[outcome];
  return classes ? classes.includes(activityOutcomeClass(event.outcome)) : event.outcome === outcome;
}

/** A choice of one, pressed again to clear. Filters what is shown; nothing here is configuration. */
function ChipGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; mark?: ReactNode }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="filter-chip"
          aria-pressed={value === option.value}
          onClick={() => onChange(value === option.value ? "" : option.value)}
        >
          {option.mark}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Loaded calls over time, failures stacked on top in red. Drawn only when the
 * loaded window spans more than a minute, so a handful of calls at one
 * moment is not a chart of one bar.
 */
function CallStrip({ events }: { events: UiActivityEvent[] }) {
  const calls = events
    .filter((event) => event.kind !== "catalog_drift")
    .map((event) => ({ at: Date.parse(event.occurredAt), failed: failedCall(event) }))
    .filter((call) => Number.isFinite(call.at));
  if (calls.length < 2) return null;
  const first = Math.min(...calls.map((call) => call.at));
  const last = Math.max(...calls.map((call) => call.at));
  if (last - first < 60_000) return null;
  const bins = 32;
  const width = (last - first) / bins;
  const counts = Array.from({ length: bins }, () => ({ ok: 0, failed: 0 }));
  for (const call of calls) {
    const bin = counts[Math.min(bins - 1, Math.floor((call.at - first) / width))]!;
    if (call.failed) bin.failed++;
    else bin.ok++;
  }
  const peak = Math.max(...counts.map((bin) => bin.ok + bin.failed));
  const height = 28;
  const scale = (n: number) => (n ? Math.max(2, (n / peak) * height) : 0);
  return (
    <svg
      className="call-strip"
      viewBox={`0 0 ${bins * 6} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${calls.length} calls over the loaded window`}
    >
      {counts.map((bin, index) => {
        const ok = scale(bin.ok + bin.failed) - (bin.failed ? scale(bin.failed) : 0);
        const failed = bin.failed ? scale(bin.failed) : 0;
        const total = bin.ok + bin.failed;
        return (
          <g key={index}>
            <rect className="strip-base" x={index * 6} y={height - 1} width={4} height={1} />
            {total ? (
              <rect className="strip-ok" x={index * 6} y={height - ok - failed} width={4} height={ok} rx={1} />
            ) : null}
            {failed ? (
              <rect className="strip-failed" x={index * 6} y={height - failed} width={4} height={failed} rx={1} />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function Stats({ events }: { events: UiActivityEvent[] }) {
  const calls = events.filter((event) => event.kind !== "catalog_drift");
  const failed = calls.filter(failedCall).length;
  const tools = new Set(calls.map((event) => event.address)).size;
  const changes = events.length - calls.length;
  const stat = (value: number, one: string, many: string, tone?: string) => (
    <div className={tone ? `activity-stat ${tone}` : "activity-stat"}>
      <strong>{value}</strong>
      <span>{value === 1 ? one : many}</span>
    </div>
  );
  return (
    <div className="activity-stats">
      {/* The numbers below are for the eye; this line is what is announced. */}
      <p id="activitySummary" className="visually-hidden" aria-live="polite">
        {activitySummary(events)}
      </p>
      <div className="activity-stat-list" aria-hidden="true">
        {stat(calls.length, "call", "calls")}
        {stat(failed, "failed", "failed", failed ? "danger" : undefined)}
        {stat(tools, "tool", "tools")}
        {changes ? stat(changes, "catalog change", "catalog changes") : null}
      </div>
      <CallStrip events={events} />
    </div>
  );
}

export function ActivityPage({ state, connectorId }: { state: OperatorState; connectorId?: string }) {
  const location = useLocation();
  const go = useNavigate();
  const params = new URLSearchParams(location.searchStr);
  const query = params.get("q") ?? "";
  const connector = connectorId ?? params.get("connector") ?? "";
  const outcome = params.get("outcome") ?? "";
  const source = params.get("source") ?? "";
  const updateFilters = (changes: Record<string, string>) => {
    const search: Record<string, unknown> = { ...location.search };
    for (const [key, value] of Object.entries(changes)) search[key] = value || undefined;
    void go({ to: location.pathname, search, hash: location.hash });
  };
  const data = state.data;
  // While the shell's recovery banner is up, the last loaded history stays on
  // screen, stale, rather than claiming Activity is unavailable.
  const enabled = activityReadable(state) || contractRecovering(state);
  const loading = state.activityPhase === "loading";
  const failed = state.activityPhase === "error";
  const connectors = state.contract?.config?.connectors ?? data?.connectors ?? [];
  const titles = new Map(connectors.map((c) => [c.id, c.title ?? c.id]));
  // A connector's tab is that connector's history; the page is all of it.
  const scoped = connectorId
    ? state.activityEvents.filter((event) => event.connectorId === connectorId)
    : state.activityEvents;
  const visible = filterActivity(
    scoped.filter(
      (event) =>
        (!connector || event.connectorId === connector) &&
        outcomeMatches(event, outcome) &&
        (!source || event.source === source),
    ),
    query,
  );
  const filtered = Boolean(query.trim() || outcome || source || (connector && !connectorId));
  // Chips for what the loaded history holds, plus whatever a link selected.
  const present = (values: string[], selected: string) => [...new Set([...values, ...(selected ? [selected] : [])])];
  const connectorChips = connectorId
    ? []
    : present(
        scoped.map((event) => event.connectorId),
        connector,
      );
  const sourceChips = present(
    scoped.map((event) => event.source),
    source,
  ).filter((value) => SOURCE_LABELS[value] || value === source);
  const refresh = (
    <Button
      id="refreshActivity"
      size="sm"
      className="activity-refresh"
      disabled={loading}
      onClick={() => void loadActivity(true)}
    >
      <Icon name="refresh" size={14} />
      {loading ? "Loading…" : "Refresh"}
    </Button>
  );
  return (
    <section id="activityView">
      {connectorId ? null : (
        <div className="page-heading">
          <div>
            <h1 id="activityHeading" tabIndex={-1}>
              Activity
            </h1>
          </div>
        </div>
      )}
      {!data ? (
        // Whether Activity is open to this identity is in /ui/data, which
        // has not answered yet — or could not.
        state.loadFailure ? (
          <LoadFailure state={state} />
        ) : (
          <StateBlock busy>Loading activity…</StateBlock>
        )
      ) : !enabled ? (
        <Unavailable>Activity isn't available to this session.</Unavailable>
      ) : (
        <div id="activityAvailable" className="collection">
          {scoped.length === 0 ? (
            loading ? (
              <StateBlock busy>Loading activity…</StateBlock>
            ) : failed ? (
              <StateBlock
                id="activityError"
                tone="error"
                title="Activity couldn't be loaded"
                action={{ label: "Retry", onClick: () => void retryCollection() }}
              >
                {state.activityNotice?.message}
              </StateBlock>
            ) : (
              <StateBlock
                title="No calls yet"
                action={{ label: "Refresh", id: "refreshActivity", onClick: () => void loadActivity(true) }}
              />
            )
          ) : (
            <>
              <Stats events={scoped} />
              <div className="activity-toolbar">
                <div className="activity-toolbar-row">
                  <label className="activity-search">
                    <Icon name="search" size={15} />
                    <input
                      id="activitySearch"
                      type="search"
                      placeholder="Search"
                      aria-label="Search loaded activity"
                      value={query}
                      onInput={(event) => {
                        setActivitySearch(event.currentTarget.value);
                        updateFilters({ q: event.currentTarget.value });
                      }}
                    />
                  </label>
                  <SegmentedControl
                    label="Outcome"
                    value={(OUTCOME_OPTIONS.some((o) => o.value === outcome) ? outcome : "") as OutcomeFilter}
                    options={OUTCOME_OPTIONS}
                    onChange={(value) => updateFilters({ outcome: value })}
                  />
                  {refresh}
                </div>
                {connectorChips.length > 1 || connector !== "" || sourceChips.length > 1 ? (
                  <div className="activity-toolbar-row chips">
                    {connectorChips.length > 1 || (connector && !connectorId) ? (
                      <ChipGroup
                        label="Connector"
                        value={connectorId ? "" : connector}
                        options={connectorChips.map((id) => ({
                          value: id,
                          label: titles.get(id) ?? id,
                          mark: <ConnectorMark id={id} title={titles.get(id) ?? id} size="sm" />,
                        }))}
                        onChange={(value) => updateFilters({ connector: value })}
                      />
                    ) : null}
                    {sourceChips.length > 1 || source ? (
                      <ChipGroup
                        label="Source"
                        value={source}
                        options={sourceChips.map((value) => ({ value, label: SOURCE_LABELS[value] ?? value }))}
                        onChange={(value) => updateFilters({ source: value })}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
              {visible.length === 0 ? (
                <StateBlock
                  title="No matches"
                  {...(filtered
                    ? {
                        action: {
                          label: "Clear filters",
                          onClick: () => {
                            setActivitySearch("");
                            updateFilters({
                              q: "",
                              outcome: "",
                              source: "",
                              ...(connectorId ? {} : { connector: "" }),
                            });
                          },
                        },
                      }
                    : {})}
                />
              ) : (
                <ActivityList events={visible} busy={loading} titles={titles} showConnector={!connectorId} />
              )}
            </>
          )}
          {/* Older pages failing is a line under the list, not a wiped list. */}
          {state.activityEvents.length > 0 ? <NoticeLine id="activityNotice" notice={state.activityNotice} /> : null}
          {state.activityCursor ? (
            <Button
              id="moreActivity"
              className="activity-more"
              disabled={loading}
              onClick={() => void loadActivity(false)}
            >
              {loading ? "Loading…" : "Load older"}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
