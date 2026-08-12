import {
  activityDetail,
  activityOutcomeClass,
  activitySummary,
  actorLabel,
  actorStableId,
  filterActivity,
  formatDate,
  type OperatorState,
  type UiActivityEvent,
} from "../view.js";
import { NoticeLine, Unavailable } from "./parts.js";
import { loadActivity, setActivitySearch } from "./store.js";

function ActivityRow({ event }: { event: UiActivityEvent }) {
  const outcome = activityOutcomeClass(event.outcome);
  const stableId = actorStableId(event.actor);
  return (
    <article class={`activity-item ${outcome}`}>
      <div class="activity-stamp">
        <span
          class={outcome === "success" ? "dot ok" : "dot"}
          aria-hidden="true"
        />
        <div>
          <time class="activity-time" dateTime={event.occurredAt}>
            {formatDate(event.occurredAt)}
          </time>
          <div class="activity-actor">{actorLabel(event.actor)}</div>
          {stableId ? (
            <div class="activity-actor-id mono">{stableId}</div>
          ) : null}
        </div>
      </div>
      <div>
        <div class="activity-address">{event.address}</div>
        <div class="activity-detail">{activityDetail(event)}</div>
      </div>
      <div>
        <div class="activity-outcome">{event.outcome}</div>
        <div class="activity-detail">{event.durationMs} ms</div>
      </div>
    </article>
  );
}

export function ActivityPage({ state }: { state: OperatorState }) {
  const enabled = Boolean(state.data?.activityEnabled);
  const loading = state.activityPhase === "loading";
  const visible = filterActivity(state.activityEvents, state.activitySearch);
  return (
    <section id="activityView">
      <div class="lead pgrid">
        <h1 id="activityHeading" class="pcap" tabIndex={-1}>
          Activity
        </h1>
        <div class="pbody">
          <p class="activity-copy" id="activitySummary">
            {activitySummary(state.activityEvents)}
          </p>
          {!enabled ? (
            <Unavailable>
              Activity history is not configured. Add an{" "}
              <span class="mono">activity.store</span> with a list reader to
              enable this page.
            </Unavailable>
          ) : (
            <div id="activityAvailable">
              <div class="row activity-controls">
                <input
                  id="activitySearch"
                  type="search"
                  placeholder="Search user, tool, or outcome…"
                  aria-label="Search loaded activity"
                  value={state.activitySearch}
                  onInput={(event) =>
                    setActivitySearch(event.currentTarget.value)
                  }
                />
                <button
                  id="refreshActivity"
                  class="linklike"
                  type="button"
                  disabled={loading}
                  onClick={() => void loadActivity(true)}
                >
                  {loading ? "Loading…" : "Refresh"}
                </button>
              </div>
              <NoticeLine id="activityNotice" notice={state.activityNotice} />
              <div
                id="activityList"
                class="activity-ledger"
                aria-busy={loading ? "true" : "false"}
              >
                {loading && state.activityEvents.length === 0 ? (
                  <div class="activity-empty">Loading activity…</div>
                ) : state.activityPhase === "error" &&
                  state.activityEvents.length === 0 ? (
                  <p class="activity-empty">
                    <button
                      class="linklike"
                      type="button"
                      onClick={() => void loadActivity(true)}
                    >
                      Try loading activity again
                    </button>
                  </p>
                ) : visible.length === 0 ? (
                  <div class="activity-empty">
                    {state.activitySearch.trim()
                      ? "No loaded activity matches this search."
                      : "No connector tool calls recorded yet."}
                  </div>
                ) : (
                  visible.map((event, index) => (
                    <ActivityRow
                      key={`${event.occurredAt}-${event.address}-${index}`}
                      event={event}
                    />
                  ))
                )}
              </div>
              {state.activityCursor ? (
                <button
                  id="moreActivity"
                  class="linklike activity-more"
                  type="button"
                  disabled={loading}
                  onClick={() => void loadActivity(false)}
                >
                  {loading ? "Loading…" : "Load older"}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
