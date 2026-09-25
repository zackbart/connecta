import { render, type VNode } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
} from "preact/hooks";
import {
  gateCopy,
  isArtifactPage,
  PAGE_META,
  OPERATOR_PAGES,
  type OperatorPage,
  type OperatorState,
} from "../view.js";
import { auth, homeUrl, productDescription, titleSuffix } from "./config.js";
import { ActivityPage } from "./activity.js";
import { ArtifactPage, ArtifactsPage } from "./artifacts.js";
import { ConnectionsPage } from "./connections.js";
import { NoticeLine, PageLink } from "./parts.js";
import {
  boot,
  focusHandled,
  forgetBearer,
  getState,
  loadActivity,
  signIn,
  signInWithBearer,
  signOut,
  subscribe,
} from "./store.js";

/**
 * The shell: two roots over one store. Branding, the sign-in loader, and every
 * operator-configured URL stay server-rendered in `src/ui.ts`, where they were
 * gated; this bundle owns only what changes — the page nav and the page.
 */

function useOperatorState(): OperatorState {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const snapshot = getState();
  // Subscribing in a layout effect, not a passive one: `boot()` starts the first
  // request the moment this tree mounts, and a passive effect would run after
  // its answer had already been stored — leaving the page on "checking your
  // session" forever. The comparison catches the same race for any store change
  // between this render and the subscription.
  useLayoutEffect(() => {
    const unsubscribe = subscribe(() => bump(undefined));
    if (getState() !== snapshot) bump(undefined);
    return unsubscribe;
  }, []);
  return snapshot;
}

/** Pages an identity may actually open. Hidden is the honest state for the rest. */
function visiblePages(state: OperatorState): OperatorPage[] {
  // Artifact pages never read /ui/data, so they cannot know whether Activity
  // is open to this identity; they offer the way back to Connections instead.
  if (isArtifactPage(state.page)) return ["connections", "artifacts"];
  return OPERATOR_PAGES.filter((page) => {
    if (page === "activity") return Boolean(state.data?.activityEnabled);
    if (page === "artifacts") return Boolean(state.data?.artifactsEnabled);
    return true;
  });
}

function OperatorNav() {
  const state = useOperatorState();
  if (state.session !== "ready") return null;
  const onArtifactPage = isArtifactPage(state.page);
  return (
    <div class="mast-actions">
      <nav class="page-nav" aria-label="Operator pages">
        {visiblePages(state).map((page) =>
          // Crossing between artifact pages and the rest is a full navigation:
          // with a dedicated artifact origin, the two live on different hosts.
          page === "artifacts" || (onArtifactPage && page === "connections") ? (
            <a
              key={page}
              class="navlink"
              href={page === "artifacts" ? PAGE_META.artifacts.path : homeUrl}
              {...(state.page === page ? { "aria-current": "page" as const } : {})}
            >
              {PAGE_META[page].label}
            </a>
          ) : (
            <PageLink
              key={page}
              page={page}
              class="navlink"
              current={state.page === page}
            >
              {PAGE_META[page].label}
            </PageLink>
          ),
        )}
      </nav>
      <div class="session-actions" aria-label="Session actions">
        {auth.kind === "clerk" || auth.kind === "cloudflare-access" ? (
          <button class="navlink" type="button" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <button class="navlink" type="button" onClick={forgetBearer}>
            Change token
          </button>
        )}
      </div>
    </div>
  );
}

function Gate({ state }: { state: OperatorState }) {
  const [token, setToken] = useState("");
  const signedIn = auth.kind === "clerk" && Boolean(window.Clerk?.user);
  const loading = state.session === "loading";
  return (
    <section id="gate" class="gate">
      <div>
        <h1 id="gateHeading" tabIndex={-1}>
          {PAGE_META[state.page].label}
        </h1>
        <div class="lead-copy">
          <p>{productDescription}</p>
          <p id="gateCopy" class="meta">
            {loading ? "Checking your session…" : gateCopy(auth.kind, signedIn)}
          </p>
          {loading ? null : auth.kind === "clerk" ? (
            <div id="clerkGate" class="actions">
              {signedIn ? (
                <button class="btn" type="button" onClick={signOut}>
                  Sign out
                </button>
              ) : (
                <button id="signin" class="btn primary" type="button" onClick={signIn}>
                  Team sign in
                </button>
              )}
            </div>
          ) : auth.kind === "cloudflare-access" ? (
            <div class="actions">
              <button class="btn" type="button" onClick={signOut}>
                Sign out of Cloudflare Access
              </button>
            </div>
          ) : (
            <form
              id="tokenGate"
              class="row"
              onSubmit={(event) => {
                event.preventDefault();
                const value = token.trim();
                if (!value) return;
                setToken("");
                signInWithBearer(value);
              }}
            >
              <input
                id="token"
                type="password"
                placeholder="Bearer token"
                autocomplete="off"
                aria-label="Bearer token"
                value={token}
                onInput={(event) => setToken(event.currentTarget.value)}
              />
              <button id="save" class="btn primary" type="submit">
                Open operator pages
              </button>
            </form>
          )}
          <NoticeLine id="err" notice={state.gate} className="" />
        </div>
      </div>
    </section>
  );
}

function CurrentPage({ state }: { state: OperatorState }) {
  if (state.page === "activity") return <ActivityPage state={state} />;
  if (state.page === "artifacts") return <ArtifactsPage state={state} />;
  if (state.page === "artifact") return <ArtifactPage state={state} />;
  return <ConnectionsPage state={state} />;
}

function OperatorApp() {
  const state = useOperatorState();
  const ready = state.session === "ready";

  useEffect(() => {
    const label = state.page === "artifact" && state.artifactView
      ? state.artifactView.title
      : PAGE_META[state.page].label;
    document.title = `${label} — ${titleSuffix}`;
  }, [state.page, state.artifactView]);

  // Deferred loads: a page fetches its own collection the first time an
  // identity opens it, and again after an identity change resets it to idle.
  useEffect(() => {
    if (!ready) return;
    if (
      state.page === "activity" &&
      state.data?.activityEnabled &&
      state.activityPhase === "idle"
    ) {
      void loadActivity(true);
    }
  });

  // Focus what is actually on screen. While gated the page views are not
  // rendered at all, so a request for a page heading lands on the gate's own h1
  // — the only visible heading — rather than dropping focus to <body>.
  useEffect(() => {
    if (!state.pendingFocus) return;
    document.getElementById(state.pendingFocus)?.focus();
    focusHandled();
  }, [state.pendingFocus]);

  return ready ? (
    <div id="app">
      <CurrentPage state={state} />
    </div>
  ) : (
    <Gate state={state} />
  );
}

function mount(id: string, view: VNode): void {
  const host = document.getElementById(id);
  if (!host) return;
  // The shell's own copy is a no-JS fallback, not markup to diff against.
  host.textContent = "";
  render(view, host);
}

mount("operatorNav", <OperatorNav />);
mount("operatorContent", <OperatorApp />);
void boot();
