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
    <article class={`activity-item ${outcome}`}>
      <div class="activity-stamp">
        <span class={`dot ${outcome}`} aria-hidden="true" />
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
      <div class="activity-result">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <div class="activity-detail">{event.durationMs} ms</div>
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
      <div class="lead">
        <h1 id="activityHeading" tabIndex={-1}>
          Activity
        </h1>
        <div class="lead-copy">
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
          <span class="mono">activity.store</span> with a list reader to
          enable this page.
        </Unavailable>
      ) : (
        <div id="activityAvailable" class="collection">
          {/* Nothing loaded and the load failed: the block below has the one
              Retry, and a search over nothing has nothing to find. */}
          {failed && state.activityEvents.length === 0 ? null : (
          <div class="row">
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
              class="btn"
              type="button"
              disabled={loading}
              onClick={() => void loadActivity(true)}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
          )}
          <p id="activitySummary" class="meta" aria-live="polite">
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
              class="activity-list"
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
              class="btn activity-more"
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
