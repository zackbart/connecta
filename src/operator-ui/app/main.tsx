import { render, type VNode } from "preact";
import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useState,
} from "preact/hooks";
import {
  checkingCopy,
  gateCopy,
  isArtifactPage,
  pageDescription,
  PAGE_META,
  OPERATOR_PAGES,
  type OperatorPage,
  type OperatorState,
} from "../view.js";
import { auth, homeUrl, productDescription, titleSuffix } from "./config.js";
import { TokensPage } from "./tokens.js";
import { ActivityPage } from "./activity.js";
import { ArtifactPage, ArtifactsPage } from "./artifacts.js";
import { ConnectionsPage } from "./connections.js";
import { NoticeLine, PageLink, StateBlock } from "./parts.js";
import {
  boot,
  focusHandled,
  forgetBearer,
  getState,
  loadActivity,
  loadAccessTokens,
  signIn,
  signInWithBearer,
  signOut,
  navHint,
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
  // Artifact pages never read /ui/data, and a failing /ui/data has not
  // answered. The pages that did read it leave a hint for this tab (see
  // `navHint`), so the nav keeps its shape; with no hint — a dedicated
  // artifact origin, a first visit — only what this page can vouch for shows.
  const hint = state.data ? null : navHint();
  return OPERATOR_PAGES.filter((page) => {
    if (page === "tokens") return state.data?.accessTokenManagement === "available";
    if (page === "activity") return hint ? hint.activity : Boolean(state.data?.activityEnabled);
    if (page === "artifacts") {
      return isArtifactPage(state.page) || (hint ? hint.artifacts : Boolean(state.data?.artifactsEnabled));
    }
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
          page === "artifacts" || onArtifactPage ? (
            <a
              key={page}
              class="navlink"
              href={
                page === "artifacts"
                  ? PAGE_META.artifacts.path
                  : new URL(PAGE_META[page].path, new URL(homeUrl, window.location.href)).href
              }
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

/**
 * The page before the session is known, laid out as the page it guards: the
 * same heading, the same description, the same column. Signing in swaps the
 * form for the content without moving anything above it.
 */
function Gate({ state }: { state: OperatorState }) {
  const [token, setToken] = useState("");
  const signedIn = auth.kind === "clerk" && Boolean(window.Clerk?.user);
  const loading = state.session === "loading";
  return (
    <section id="gate" class="gate lead" aria-busy={loading ? "true" : "false"}>
        <h1 id="gateHeading" tabIndex={-1}>
          {PAGE_META[state.page].label}
        </h1>
        <div class="lead-copy">
          <p>{pageDescription(state.page, productDescription)}</p>
          {/* While the session is checked, the same block the signed-in page
              shows while it loads, so the words and the shape do not change
              when the check passes. */}
          {loading ? (
            <StateBlock id="gateCopy">{checkingCopy(state.page)}</StateBlock>
          ) : (
            <p id="gateCopy" class="meta">
              {gateCopy(auth.kind, signedIn)}
            </p>
          )}
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
              class="row gate-form"
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
    </section>
  );
}

function CurrentPage({ state }: { state: OperatorState }) {
  if (state.page === "tokens") return <TokensPage state={state} />;
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
    if (state.page === "tokens" && state.data?.accessTokenManagement === "available" && state.tokenPhase === "idle") {
      void loadAccessTokens();
    }
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
    if (!state.pendingFocus && !state.focusIfLost) return;
    if (state.pendingFocus) {
      document.getElementById(state.pendingFocus)?.focus();
    } else if (state.focusIfLost) {
      // Only when the control that had focus is gone or disabled; otherwise the
      // notice's live region speaks and the operator stays where they are.
      const active = document.activeElement;
      const lost =
        !active ||
        active === document.body ||
        !active.isConnected ||
        (active as HTMLButtonElement).disabled === true;
      if (lost) document.getElementById(state.focusIfLost)?.focus();
    }
    focusHandled();
  }, [state.pendingFocus, state.focusIfLost]);

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
