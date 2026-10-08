import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  activityDetail,
  activityOutcomeBadge,
  activityOutcomeClass,
  activitySummary,
  actorLabel,
  actorStableId,
  filterActivity,
  formatDate,
  pageDescription,
  type OperatorState,
  type UiActivityEvent,
} from "../view.js";
import { productDescription } from "./config.js";
import { Badge, LoadFailure, NoticeLine, StateBlock, Unavailable } from "./parts.js";
import { loadActivity, retryCollection, setActivitySearch } from "./store.js";

function ActivityRow({ event }: { event: UiActivityEvent }) {
  const outcome = activityOutcomeClass(event.outcome);
  const badge = activityOutcomeBadge(event.outcome);
  const stableId = actorStableId(event.actor);
  return (
    <article className={`activity-item ${outcome}`}>
      <div className="activity-stamp">
        <span className={`dot ${outcome}`} aria-hidden="true" />
        <div>
          <time className="activity-time" dateTime={event.occurredAt}>
            {formatDate(event.occurredAt)}
          </time>
          <div className="activity-actor">{actorLabel(event.actor)}</div>
          {stableId ? (
            <div className="activity-actor-id mono">{stableId}</div>
          ) : null}
        </div>
      </div>
      <div>
        <div className="activity-address">{event.address}</div>
        <div className="activity-detail">{activityDetail(event)}</div>
      </div>
      <div className="activity-result">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <div className="activity-detail">{event.durationMs} ms</div>
        {event.classification ? <Badge>{event.classification}</Badge> : null}
        {Number.isFinite(event.resultBytes) ? <span className="meta">{event.resultBytes} bytes</span> : null}
      </div>
    </article>
  );
}

/** Missing IDs are separate calls, never an invented multi-call request. */
function grouped(events: UiActivityEvent[]): Map<string, UiActivityEvent[]> {
  const groups = new Map<string, UiActivityEvent[]>();
  events.forEach((event, index) => {
    const key = event.requestId ? `request:${event.requestId}` : `ungrouped:${index}`;
    const group = groups.get(key) ?? [];
    group.push(event); groups.set(key, group);
  });
  return groups;
}

export function ActivityPage({ state, connectorId }: { state: OperatorState; connectorId?: string }) {
  const location = useLocation();
  const go = useNavigate();
  const params = new URLSearchParams(location.searchStr);
  const query = params.get("q") ?? "";
  const connector = connectorId ?? params.get("connector") ?? "";
  const outcome = params.get("outcome") ?? "";
  const source = params.get("source") ?? "";
  const updateFilter = (key: string, value: string) => {
    const search = { ...location.search, [key]: value || undefined };
    void go({ to: location.pathname, search, hash: location.hash });
  };
  const data = state.data;
  const enabled = Boolean(data?.activityEnabled) && state.contract?.you.permissions.activity === true;
  const loading = state.activityPhase === "loading";
  const visible = filterActivity(state.activityEvents.filter(e => (!connector || e.connectorId === connector) && (!outcome || e.outcome === outcome) && (!source || e.source === source)), query);
  const summary = activitySummary(state.activityEvents);
  const failed = state.activityPhase === "error";
  return (
    <section id="activityView">
      {connectorId ? null : <div className="lead">
        <h1 id="activityHeading" tabIndex={-1}>
          Activity
        </h1>
        <div className="lead-copy">
          <p>{pageDescription("activity", productDescription)}</p>
        </div>
      </div>}
      {!data ? (
        // Whether Activity is open to this identity is in /ui/data, which
        // has not answered yet — or could not.
        state.loadFailure ? (
          <LoadFailure state={state} />
        ) : (
          <StateBlock>Loading activity…</StateBlock>
        )
      ) : !enabled ? (
        <Unavailable>
          Activity history is not available to this session. Its reader and access rules are configured in deployment code.
        </Unavailable>
      ) : (
        <div id="activityAvailable" className="collection">
          {/* Nothing loaded and the load failed: the block below has the one
              Retry, and a search over nothing has nothing to find. */}
          {failed && state.activityEvents.length === 0 ? null : (
          <div className="row">
            <input
              id="activitySearch"
              type="search"
              placeholder="Search user, tool, or outcome…"
              aria-label="Search loaded activity"
              value={query}
              onInput={(event) => { setActivitySearch(event.currentTarget.value); updateFilter("q", event.currentTarget.value); }}
            />
            {connectorId ? null : <label className="select-label">Connector<select aria-label="Activity connector" value={connector} onChange={e => updateFilter("connector", e.target.value)}><option value="">All connectors</option>{(state.contract?.config.connectors ?? data.connectors).map(c => <option key={c.id} value={c.id}>{c.title ?? c.id}</option>)}</select></label>}
            <label className="select-label">Outcome<select aria-label="Activity outcome" value={outcome} onChange={e => updateFilter("outcome", e.target.value)}><option value="">All outcomes</option>{["success", "error", "timeout", "cancelled", "paused", "approved"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="select-label">Source<select aria-label="Activity source" value={source} onChange={e => updateFilter("source", e.target.value)}><option value="">All sources</option>{["call_tool", "call_destructive_tool", "execute_code", "batch_call"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
            <button
              id="refreshActivity"
              className="btn"
              type="button"
              disabled={loading}
              onClick={() => void loadActivity(true)}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          )}
          <p id="activitySummary" className="meta" aria-live="polite">
            {summary}
          </p>
          {state.activityEvents.length === 0 ? (
            loading ? (
              <StateBlock>Loading activity…</StateBlock>
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
              <StateBlock>
                {query.trim()
                  ? "No loaded activity matches this search."
                  : "No connector tool calls recorded yet."}
              </StateBlock>
            )
          ) : visible.length === 0 ? (
            <StateBlock>No loaded activity matches this search.</StateBlock>
          ) : (
            <div
              id="activityList"
              className="activity-list"
              aria-busy={loading ? "true" : "false"}
            >
              {[...grouped(visible)].map(([key, events]) => <section key={key} className="request-group" aria-label={events[0]?.requestId ? `Request ${events[0].requestId}` : "Ungrouped call"}>
                <div className="request-head"><span>{events[0]?.requestId ? "Request" : "Call without request ID"}</span>{events[0]?.requestId ? <code>{events[0].requestId}</code> : null}<span className="meta">{events.length} {events.length === 1 ? "call" : "calls"}</span></div>
                {events.map((event, index) => <ActivityRow key={event.id ?? `${event.occurredAt}-${event.address}-${index}`} event={event} />)}
              </section>)}
            </div>
          )}
          {/* Older pages failing is a line under the list, not a wiped list. */}
          {state.activityEvents.length > 0 ? (
            <NoticeLine id="activityNotice" notice={state.activityNotice} />
          ) : null}
          {state.activityCursor ? (
            <button
              id="moreActivity"
              className="btn activity-more"
              type="button"
              disabled={loading}
              onClick={() => void loadActivity(false)}
            >
              {loading ? "Loading…" : "Load older"}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
