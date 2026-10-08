import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.js";
import { ShellControls } from "./shell.js";
import { Button, Input } from "./primitives.js";
import { useEffect, useSyncExternalStore, useState } from "react";
import {
  checkingCopy,
  gateCopy,
  pageDescription,
  PAGE_META,
  OPERATOR_PAGES,
  type OperatorPage,
  type OperatorState,
} from "../view.js";
import { auth, productDescription, titleSuffix } from "./config.js";
import { ConnectorsPage } from "./connectors.js";
import { ConfigPage } from "./config-page.js";
import { AccessPage } from "./access.js";
import { ToolsPage } from "./tools.js";
import { OverviewPage } from "./overview.js";
import { TokensPage } from "./tokens.js";
import { ActivityPage } from "./activity.js";
import { ConnectorDetailPage } from "./connector-detail.js";
import { NoticeLine, PageLink, StateBlock } from "./parts.js";
import {
  boot,
  focusHandled,
  forgetBearer,
  getState,
  loadOperatorContract,
  loadActivity,
  loadAccessTokens,
  signIn,
  signInWithBearer,
  signOut,
  navHint,
  subscribe,
  configureNavigation,
  routeChanged,
} from "./store.js";

/**
 * The shell: two roots over one store. Branding, the sign-in loader, and every
 * operator-configured URL stay server-rendered in `src/ui.ts`, where they were
 * gated; this bundle owns only what changes — the page nav and the page.
 */

function useOperatorState(): OperatorState {
  return useSyncExternalStore(subscribe, getState);
}

/** Pages an identity may actually open. Hidden is the honest state for the rest. */
function visiblePages(state: OperatorState): OperatorPage[] {
  const hint = state.data ? null : navHint();
  return OPERATOR_PAGES.filter((page) => {
    if (page === "activity" && state.contract) return state.contract.you.permissions.activity;
    if (page === "tokens") return state.data?.accessTokenManagement === "available";
    if (page === "activity") return hint ? hint.activity : Boolean(state.data?.activityEnabled);
    return true;
  });
}

function OperatorNav() {
  const state = useOperatorState();

  return (
    <div className="mast-actions">
      <ShellControls pages={state.session === "ready" ? visiblePages(state) : []} />
      <nav className="page-nav" aria-label="Operator pages">
        {(state.session === "ready" ? visiblePages(state) : []).map((page) => (
          <PageLink key={page} page={page} className="navlink" current={state.page === page}>
            {PAGE_META[page].label}
          </PageLink>
        ))}
      </nav>
      <div hidden={state.session !== "ready"} className="session-actions" aria-label="Session actions">
        {auth.kind === "clerk" || auth.kind === "cloudflare-access" ? (
          <button className="navlink" type="button" onClick={signOut}>
            Sign out
          </button>
        ) : (
          <button className="navlink" type="button" onClick={forgetBearer}>
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
    <section id="gate" className="gate lead" aria-busy={loading ? "true" : "false"}>
      <h1 id="gateHeading" tabIndex={-1}>
        {PAGE_META[state.page].label}
      </h1>
      <div className="lead-copy">
        <p>{pageDescription(state.page, productDescription)}</p>
        {/* While the session is checked, the same block the signed-in page
              shows while it loads, so the words and the shape do not change
              when the check passes. */}
        {loading ? (
          <StateBlock id="gateCopy">{checkingCopy()}</StateBlock>
        ) : (
          <p id="gateCopy" className="meta">
            {gateCopy(auth.kind, signedIn)}
          </p>
        )}
        {loading ? null : auth.kind === "clerk" ? (
          <div id="clerkGate" className="actions">
            {signedIn ? (
              <button className="btn" type="button" onClick={signOut}>
                Sign out
              </button>
            ) : (
              <button id="signin" className="btn primary" type="button" onClick={signIn}>
                Team sign in
              </button>
            )}
          </div>
        ) : auth.kind === "cloudflare-access" ? (
          <div className="actions">
            <button className="btn" type="button" onClick={signOut}>
              Sign out of Cloudflare Access
            </button>
          </div>
        ) : (
          <form
            id="tokenGate"
            className="row gate-form"
            onSubmit={(event) => {
              event.preventDefault();
              const value = token.trim();
              if (!value) return;
              setToken("");
              signInWithBearer(value);
            }}
          >
            <Input
              id="token"
              type="password"
              placeholder="Bearer token"
              autoComplete="off"
              aria-label="Bearer token"
              value={token}
              onInput={(event) => setToken(event.currentTarget.value)}
            />
            <Button id="save" variant="primary" type="submit">
              Open operator pages
            </Button>
          </form>
        )}
        <NoticeLine id="err" notice={state.gate} className="" />
      </div>
    </section>
  );
}

function CurrentPage({ state }: { state: OperatorState }) {
  if (state.page === "config") return <ConfigPage state={state} />;
  if (state.page === "access") return <AccessPage state={state} />;
  if (state.page === "tools") return <ToolsPage state={state} />;
  if (state.page === "connector") return <ConnectorDetailPage state={state} />;
  if (state.page === "connections") return <ConnectorsPage state={state} />;
  if (state.page === "overview") return <OverviewPage state={state} />;
  if (state.page === "tokens") return <TokensPage state={state} />;
  if (state.page === "activity") return <ActivityPage state={state} />;
  return <OverviewPage state={state} />;
}

function OperatorApp() {
  const state = useOperatorState();
  const ready = state.session === "ready";

  useEffect(() => {
    document.title = `${PAGE_META[state.page].label} — ${titleSuffix}`;
  }, [state.page]);

  // Deferred loads: a page fetches its own collection the first time an
  // identity opens it, and again after an identity change resets it to idle.
  useEffect(() => {
    if (!ready) return;
    if (state.data && state.contractPhase === "idle") void loadOperatorContract();
    if (
      (state.page === "tokens" || (state.page === "access" && state.contract?.you.permissions.accessTokenManagement)) &&
      state.data?.accessTokenManagement === "available" &&
      state.tokenPhase === "idle"
    ) {
      void loadAccessTokens();
    }
    if (
      (state.page === "activity" || state.page === "connector") &&
      state.data?.activityEnabled &&
      state.contract?.you.permissions.activity &&
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
        !active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled === true;
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

function mount(id: string, view: ReactNode): void {
  const host = document.getElementById(id);
  if (!host) return;
  // The shell's own copy is a no-JS fallback, not markup to diff against.
  host.textContent = "";
  createRoot(host).render(view);
}

mount("operatorNav", <OperatorNav />);
const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: OperatorApp });
const routes = ["/", "/connectors", "/connectors/$id", "/tools", "/access", "/config", "/tokens", "/activity"].map(
  (path) => createRoute({ getParentRoute: () => rootRoute, path, component: OperatorApp }),
);
const router = createRouter({ routeTree: rootRoute.addChildren(routes), defaultPendingMinMs: 0 });
configureNavigation((href) => {
  void router.navigate({ to: href });
});
router.subscribe("onResolved", () => routeChanged(router.state.location.pathname));
mount(
  "operatorContent",
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
void boot();
