import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.js";
import { ShellControls } from "./shell.js";
import { Button, Input } from "./primitives.js";
import { useEffect, useSyncExternalStore, useState } from "react";
import {
  activityAllowed,
  activityReadable,
  canonicalOperatorPath,
  checkingCopy,
  contractRecovering,
  displayRole,
  gateCopy,
  noAccessCopy,
  pageDescription,
  PAGE_META,
  OPERATOR_PAGES,
  operatorRole,
  type OperatorPage,
  type OperatorState,
} from "../view.js";
import { auth, productDescription, productName, titleSuffix } from "./config.js";
import { ConnectorsPage } from "./connectors.js";
import { SettingsPage } from "./config-page.js";
import { EndpointsPage } from "./endpoints.js";
import { TokensPage } from "./tokens.js";
import { ActivityPage } from "./activity.js";
import { ConnectorDetailPage } from "./connector-detail.js";
import { MemberPage } from "./member.js";
import { ContractState } from "./contract-state.js";
import { NoticeLine, PageLink, StateBlock } from "./parts.js";
import {
  boot,
  closeForRecovery,
  focusHandled,
  forgetBearer,
  getState,
  retryLoad,
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

/**
 * Pages an identity may actually open. Hidden is the honest state for the
 * rest, and for every page while the contract has not said who this is.
 */
function visiblePages(state: OperatorState): OperatorPage[] {
  const role = displayRole(state);
  // A member has one page until UI-3: their own endpoints.
  if (role === "member") return ["endpoints"];
  if (role !== "maintainer") return [];
  // Before `/ui/data` answers, or when it cannot, the tab's last answer keeps
  // the nav's shape; the contract still has to allow Activity.
  const activity = state.data ? activityReadable(state) : navHint().activity && activityAllowed(state);
  return OPERATOR_PAGES.filter((page) => {
    if (page === "tokens") return state.data?.accessTokenManagement === "available";
    if (page === "activity") return activity;
    return true;
  });
}

function DeploymentName({ state }: { state: OperatorState }) {
  const name = state.contract?.role === "maintainer" ? state.contract.config?.server.name : undefined;
  return name ? (
    <span className="deployment-name">
      <span aria-hidden="true">/</span>
      {name}
    </span>
  ) : null;
}

function OperatorNav() {
  const state = useOperatorState();

  return (
    <div className="mast-actions">
      <DeploymentName state={state} />
      <nav className="page-nav" aria-label="Operator pages">
        {(state.session === "ready" ? visiblePages(state) : []).map((page) => (
          <PageLink
            key={page}
            page={page}
            className="navlink"
            current={state.page === page || (page === "connections" && state.page === "connector")}
          >
            {PAGE_META[page].label}
          </PageLink>
        ))}
      </nav>
      <div hidden={state.session !== "ready"} className="session-actions" aria-label="Session actions">
        <ShellControls state={state} pages={state.session === "ready" ? visiblePages(state) : []} />
        {auth.kind === "clerk" || auth.kind === "cloudflare-access" ? (
          <Button variant="quiet" className="session-action" onClick={signOut}>
            Sign out
          </Button>
        ) : (
          <Button variant="quiet" className="session-action" onClick={forgetBearer}>
            Change token
          </Button>
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
            <button className="btn primary" type="button" onClick={() => void retryLoad()}>
              Retry
            </button>
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

/**
 * Signed in as someone who is neither a maintainer nor a pool member. Calm,
 * not an error: there is nothing to retry, only someone to ask.
 */
function NoAccess() {
  return (
    <section id="noAccess" className="gate lead">
      <h1 id="gateHeading" tabIndex={-1}>
        No access
      </h1>
      <div className="lead-copy">
        <p>{noAccessCopy(auth.kind, productName)}</p>
        <div className="actions">
          {auth.kind === "clerk" || auth.kind === "cloudflare-access" ? (
            <Button onClick={signOut}>Sign out</Button>
          ) : (
            <Button onClick={forgetBearer}>Change token</Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** Signed in, role not yet known: the page's name and its loading or error state. */
function RolePending({ state }: { state: OperatorState }) {
  return (
    <section id="rolePending" className="lead">
      <h1 id={`${state.page}Heading`} tabIndex={-1}>
        {PAGE_META[state.page].label}
      </h1>
      <div className="lead-copy">
        <p>{pageDescription(state.page, productDescription)}</p>
        <ContractState state={state} />
      </div>
    </section>
  );
}

/**
 * One recovery affordance for every maintainer page that stays mounted while
 * its contract is missing. The page below is inert and dimmed: it shows what
 * was last loaded, and nothing maintainer-only is sent until a contract
 * confirms the role again.
 */
function RecoveryBanner({ state }: { state: OperatorState }) {
  const failed = state.contractPhase === "error" || state.loadFailure !== null;
  return (
    <section id="recoveryBanner" className="recovery-banner" role="alert" aria-labelledby="recoveryTitle">
      <div>
        <p id="recoveryTitle" className="state-title">
          {failed ? "Configuration couldn't be loaded" : "Reloading configuration…"}
        </p>
        <p className="meta">This page shows what was last loaded and can't change until the configuration reloads.</p>
      </div>
      <Button id="recoveryRetry" onClick={() => void retryLoad()}>
        Retry
      </Button>
    </section>
  );
}

function CurrentPage({ state }: { state: OperatorState }) {
  const role = displayRole(state);
  // Every other page is built from maintainer facts a member never receives.
  if (role === "member") return <MemberPage state={state} />;
  if (role !== "maintainer") return <RolePending state={state} />;
  if (state.page === "settings") return <SettingsPage state={state} />;
  if (state.page === "connector") return <ConnectorDetailPage state={state} />;
  if (state.page === "connections") return <ConnectorsPage state={state} />;
  if (state.page === "endpoints") return <EndpointsPage state={state} />;
  if (state.page === "tokens") return <TokensPage state={state} />;
  if (state.page === "activity") return <ActivityPage state={state} />;
  return <EndpointsPage state={state} />;
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
    if (
      state.page === "tokens" &&
      operatorRole(state) === "maintainer" &&
      state.data?.accessTokenManagement === "available" &&
      state.tokenPhase === "idle"
    ) {
      void loadAccessTokens();
    }
    if (
      (state.page === "activity" || state.page === "connector") &&
      activityReadable(state) &&
      state.activityPhase === "idle"
    ) {
      void loadActivity(true);
    }
  });

  // Focus what is actually on screen. While gated the page views are not
  // rendered at all, so a request for a page heading lands on the gate's own h1
  // — the only visible heading — rather than dropping focus to <body>.
  const recovering = ready && contractRecovering(state);
  // Recovery starts: page-owned overlays close (see useCloseOnRecovery), and
  // focus moves to the one control that can bring the page back.
  useEffect(() => {
    if (!recovering) return;
    closeForRecovery();
    document.getElementById("recoveryRetry")?.focus();
  }, [recovering]);
  useEffect(() => {
    if (!state.pendingFocus && !state.focusIfLost) return;
    if (state.pendingFocus) {
      const target = document.getElementById(state.pendingFocus);
      // A heading on the stale page waits until the page is live again.
      if (target?.closest("[inert]")) return;
      target?.focus();
    } else if (state.focusIfLost) {
      // Only when the control that had focus is gone or disabled; otherwise the
      // notice's live region speaks and the operator stays where they are.
      const active = document.activeElement;
      const lost =
        !active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled === true;
      if (lost) document.getElementById(state.focusIfLost)?.focus();
    }
    focusHandled();
  }, [state.pendingFocus, state.focusIfLost, recovering]);

  // The banner is a sibling, so the page under it stays mounted: unmounting
  // it would cancel the very reads recovery is waiting on.
  return ready ? (
    <>
      {recovering ? <RecoveryBanner state={state} /> : null}
      <div id="app" inert={recovering} className={recovering ? "stale" : undefined}>
        <CurrentPage state={state} />
      </div>
    </>
  ) : state.session === "denied" ? (
    <NoAccess />
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
const routes = [
  "/",
  "/connectors",
  "/connectors/$id",
  "/tools",
  "/access",
  "/config",
  "/settings",
  "/tokens",
  "/activity",
].map((path) => createRoute({ getParentRoute: () => rootRoute, path, component: OperatorApp }));
const router = createRouter({ routeTree: rootRoute.addChildren(routes), defaultPendingMinMs: 0 });
configureNavigation((href) => {
  void router.navigate({ to: href });
});
function resolveLocation() {
  const location = router.state.location;
  const path = canonicalOperatorPath(location.pathname);
  const hash =
    path.startsWith("/connectors/") && ["config", "auth", "diagnostics"].includes(location.hash)
      ? "connection"
      : location.hash;
  if (path !== location.pathname || hash !== location.hash) {
    void router.navigate({ to: path, search: location.search, hash, replace: true });
  }
  routeChanged(path);
}
router.subscribe("onResolved", resolveLocation);
mount(
  "operatorContent",
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
void boot();
