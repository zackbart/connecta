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
      </div>
    </article>
  );
}

export function ActivityPage({ state }: { state: OperatorState }) {
  const data = state.data;
  const enabled = Boolean(data?.activityEnabled);
  const loading = state.activityPhase === "loading";
  const visible = filterActivity(state.activityEvents, state.activitySearch);
  const summary = activitySummary(state.activityEvents);
  const failed = state.activityPhase === "error";
  return (
    <section id="activityView">
      <div className="lead">
        <h1 id="activityHeading" tabIndex={-1}>
          Activity
        </h1>
        <div className="lead-copy">
          <p>{pageDescription("activity", productDescription)}</p>
        </div>
      </div>
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
          Activity history is not configured. Add an{" "}
          <span className="mono">activity.store</span> with a list reader to
          enable this page.
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
              value={state.activitySearch}
              onInput={(event) => setActivitySearch(event.currentTarget.value)}
            />
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
                {state.activitySearch.trim()
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
              {visible.map((event, index) => (
                <ActivityRow
                  key={`${event.occurredAt}-${event.address}-${index}`}
                  event={event}
                />
              ))}
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
