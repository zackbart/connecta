import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { UiArtifactRow, UiArtifactView } from "../model.js";
import { formatDate, type OperatorState } from "../view.js";
import { NoticeLine } from "./parts.js";
import { loadArtifacts, setArtifactArchived, setArtifactQuery } from "./store.js";

/**
 * The artifact library and viewer. Everything on these pages is trusted
 * markup built from facts the API returns — titles, versions, dates, labels —
 * and none of it is page content: an artifact's own HTML runs only inside the
 * sandboxed frame, which gets it by postMessage and can reach nothing here.
 */

function ArtifactRow({ row }: { row: UiArtifactRow }) {
  return (
    <article class="artifact-row">
      <div>
        <a class="artifact-title" href={`/artifacts/${row.id}`}>
          {row.title}
        </a>
        <div class="artifact-meta">
          <span class="mono">{row.id}</span> · version {row.viewVersion} · updated{" "}
          <time dateTime={row.updatedAt}>{formatDate(row.updatedAt)}</time> by {row.updatedBy.label}
        </div>
      </div>
      <div class="artifact-badges">
        <span class="badge">{row.kind === "markdown" ? "Markdown" : "HTML"}</span>
        {row.archived ? <span class="badge warn">Archived</span> : null}
      </div>
    </article>
  );
}

export function ArtifactsPage({ state }: { state: OperatorState }) {
  const loading = state.artifactPhase === "loading";
  return (
    <section id="artifactsView">
      <div class="lead">
        <h1 id="artifactsHeading" tabIndex={-1}>
          Artifacts
        </h1>
        <div class="lead-copy">
          <p>Pages agents published for the team. Each one keeps every version.</p>
          <form
            class="row"
            onSubmit={(event) => {
              event.preventDefault();
              void loadArtifacts(true);
            }}
          >
            <input
              id="artifactSearch"
              type="search"
              placeholder="Search titles…"
              aria-label="Search artifact titles"
              value={state.artifactQuery}
              onInput={(event) => setArtifactQuery(event.currentTarget.value)}
            />
            <button id="searchArtifacts" class="btn" type="submit" disabled={loading}>
              Search
            </button>
            <label class="artifact-meta">
              <input
                id="showArchived"
                type="checkbox"
                checked={state.artifactArchived}
                onChange={(event) => setArtifactArchived(event.currentTarget.checked)}
              />{" "}
              Show archived
            </label>
          </form>
          <NoticeLine id="artifactNotice" notice={state.artifactNotice} />
          <div id="artifactList" class="activity-list" aria-busy={loading ? "true" : "false"}>
            {loading && state.artifactRows.length === 0 ? (
              <div class="activity-empty">Loading artifacts…</div>
            ) : state.artifactRows.length === 0 ? (
              <div class="activity-empty">
                {state.artifactPhase === "error"
                  ? "No artifacts to show."
                  : state.artifactQuery.trim()
                    ? "No artifact title matches this search."
                    : "No artifacts yet. Ask an agent to publish one."}
              </div>
            ) : (
              state.artifactRows.map((row) => <ArtifactRow key={row.id} row={row} />)
            )}
          </div>
          {state.artifactCursor ? (
            <button
              id="moreArtifacts"
              class="btn activity-more"
              type="button"
              disabled={loading}
              onClick={() => void loadArtifacts(false)}
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/**
 * The sandboxed frame and its one-message handshake. The frame loads a fixed,
 * data-free bootstrap, says it is ready, and gets exactly one document back —
 * sent only to this frame's own window, and only once. Nothing it sends later
 * is read.
 */
function ArtifactFrame({ view }: { view: UiArtifactView }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== element.contentWindow || event.origin !== "null") return;
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== "ready") return;
      window.removeEventListener("message", onMessage);
      // The only network navigation an opaque sandbox can still make is its
      // own frame. Tighten the parent's frame policy after the fixed bootstrap
      // loads and before any untrusted page script receives its document.
      // CSP policies only accumulate, so removing this element later cannot
      // reopen navigation during this shell's lifetime.
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = "frame-src 'none'";
      document.head.append(policy);
      element.contentWindow?.postMessage({ type: "document", html: view.document }, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [view.document]);
  return (
    <iframe
      ref={frame}
      id="artifactFrame"
      class="artifact-frame"
      title={view.title}
      sandbox="allow-scripts"
      referrerpolicy="no-referrer"
      src="/artifacts/_frame"
    />
  );
}

export function ArtifactPage({ state }: { state: OperatorState }) {
  const view = state.artifactView;
  const [copied, setCopied] = useState(false);
  return (
    <section id="artifactView">
      <div class="artifact-head">
        <h1 id="artifactHeading" tabIndex={-1}>
          {view?.title ?? "Artifact"}
        </h1>
        {view ? (
          <div class="artifact-meta" id="artifactMeta">
            {view.snapshot ? "Snapshot of " : ""}version {view.view.version}
            {view.snapshot && view.view.version !== view.latestViewVersion
              ? ` (latest is ${view.latestViewVersion})`
              : ""}{" "}
            · updated <time dateTime={view.view.at}>{formatDate(view.view.at)}</time> by{" "}
            {view.view.by.label} ·{" "}
            <a href="/artifacts">All artifacts</a>
            {view.snapshot ? (
              <>
                {" "}· <a href={view.url}>Current version</a>
              </>
            ) : (
              <>
                {" "}·{" "}
                <button
                  id="copySnapshot"
                  class="navlink"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(view.snapshotUrl).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? "Snapshot link copied" : "Copy snapshot link"}
                </button>
              </>
            )}
          </div>
        ) : null}
        {view?.archived ? (
          <div id="archivedBanner" class="artifact-banner" role="status">
            This artifact is archived. It keeps every version, and an agent can restore it.
          </div>
        ) : null}
        <NoticeLine id="artifactNotice" notice={state.artifactNotice} />
      </div>
      {view ? <ArtifactFrame key={view.snapshotUrl} view={view} /> : null}
    </section>
  );
}
