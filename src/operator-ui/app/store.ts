import { queryClient } from "./query.js";
import { isCancelledError } from "@tanstack/react-query";
import type {
  UiArtifactRow,
  UiArtifactView,
  UiConnector,
  UiData,
} from "../model.js";
import {
  actionFailedNotice,
  artifactViewRequest,
  collectionFailureCopy,
  credentialTestNotice,
  failure,
  info,
  initialState,
  oauthDoneNotice,
  pageForPath,
  refusedNotice,
  resetIdentity,
  safeHttpHref,
  withPage,
  type ConnectorLoadFailure,
  type Notice,
  type OperatorPage,
  type OperatorState,
  type PendingConfirm,
  type RequestFailureFacts,
  type RequestFailureKind,
  type RowAction,
  type UiActivityEvent,
  type UiAccessToken,
} from "../view.js";
import { auth, initialPage, productName, TOKEN_KEY } from "./config.js";

/**
 * One store, one identity. Components read this state and dispatch these
 * actions; nothing else in the app touches `fetch`, `localStorage`, or Clerk.
 * Keeping every request in one file is what makes the two rules checkable:
 * every operator request carries the current session's token, and every
 * response is dropped unless the identity that asked for it is still the one
 * on screen.
 */

// The server already resolved this request's path to a page and wrote it into
// the shell; starting from its answer keeps the two routers agreeing on load.
let state = initialState(initialPage as OperatorPage);
const listeners = new Set<() => void>();

export function getState(): OperatorState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(patch: Partial<OperatorState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/**
 * Captures the identity that asked, and reports whether it is still the one
 * waiting. Every await in this file sits behind one of these.
 */
function fence(): () => boolean {
  const generation = state.generation;
  return () => generation === state.generation;
}

function sessionToken(): Promise<string | null | undefined> {
  if (auth.kind === "cloudflare-access") return Promise.resolve(undefined);
  return auth.kind === "clerk"
    ? Promise.resolve(window.Clerk?.session?.getToken() ?? null)
    : Promise.resolve(localStorage.getItem(TOKEN_KEY));
}

function requestHeaders(
  token: string | null | undefined,
  body = false,
): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
}

/* Nav hint ----------------------------------------------------------------- */

/**
 * Artifact pages never read `/ui/data`, so on their own they cannot know
 * whether Activity is open to this identity. The pages that do read it leave
 * the answer here, in this tab only, and every identity change wipes it — so
 * the nav reads the same on every page instead of losing a link on two of
 * them. A dedicated artifact origin has its own storage and no hint, and
 * keeps the old behavior: it offers only what it can vouch for.
 */
const NAV_HINT_KEY = "connecta:nav";

function rememberNav(data: UiData): void {
  try {
    sessionStorage.setItem(
      NAV_HINT_KEY,
      JSON.stringify({ activity: data.activityEnabled, artifacts: Boolean(data.artifactsEnabled) }),
    );
  } catch {
    // No storage, no hint: the artifact pages fall back to what they know.
  }
}

function forgetNav(): void {
  try {
    sessionStorage.removeItem(NAV_HINT_KEY);
  } catch {
    // Nothing was stored.
  }
}

/**
 * What the pages that read `/ui/data` last said about Activity and Artifacts.
 * Also what the nav falls back to while `/ui/data` is failing, so a 500 does
 * not take two links away with it.
 */
export function navHint(): { activity: boolean; artifacts: boolean } {
  try {
    const hint = JSON.parse(sessionStorage.getItem(NAV_HINT_KEY) ?? "null") as
      | { activity?: unknown; artifacts?: unknown }
      | null;
    return { activity: hint?.activity === true, artifacts: hint?.artifacts === true };
  } catch {
    return { activity: false, artifacts: false };
  }
}

function gate(notice: Notice | null = null): void {
  queryClient.clear();
  forgetNav();
  awaitingAuthorization.clear();
  state = resetIdentity(state, notice);
  for (const listener of listeners) listener();
}

interface OperatorResponse {
  token?: string;
  accessToken?: UiAccessToken;
  accessTokens?: UiAccessToken[];
  ok?: boolean;
  state?: string;
  problem?: string;
  authorizationUrl?: string;
  reused?: boolean;
  events?: UiActivityEvent[];
  nextCursor?: string;
}

/**
 * Why an operator request did not land, as facts: a kind, a status, and a
 * `problem` the route chose from a closed set. The route's `error` text is
 * not kept — a credential route's can echo validation detail or a vault's
 * failure, and a downstream's can quote the secret it rejected — so nothing
 * downstream of here can put it on the page by accident.
 */
class RequestFailure extends Error implements RequestFailureFacts {
  readonly kind: RequestFailureKind;
  readonly status: number | undefined;
  readonly problem: unknown;
  constructor(kind: RequestFailureKind, status?: number, problem?: unknown) {
    super(`Operator request failed: ${kind}`);
    this.kind = kind;
    this.status = status;
    this.problem = problem;
  }
}

function factsOf(error: unknown): RequestFailureFacts {
  return error instanceof RequestFailure ? error : { kind: "refused" };
}

async function operatorRequest(
  path: string,
  method: "DELETE" | "GET" | "POST" | "PUT",
  current: () => boolean,
  body?: object,
): Promise<OperatorResponse | null> {
  let token;
  try {
    token = await sessionToken();
  } catch {
    throw new RequestFailure("session");
  }
  if (!current()) throw new RequestFailure("session");
  if (!token && auth.kind !== "cloudflare-access") throw new RequestFailure("session");
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: requestHeaders(token, Boolean(body)),
      credentials: "same-origin",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new RequestFailure("network");
  }
  if (res.status === 204) return null;
  let payload: OperatorResponse = {};
  try {
    payload = (await res.json()) as OperatorResponse;
  } catch {
    // The status code below still decides what the page says.
  }
  // A 403 on a mutation is a permission this identity lacks, not a session
  // that ended: it stays beside the control rather than signing anyone out.
  if (res.status === 401) throw new RequestFailure("session", 401);
  if (res.status === 403) throw new RequestFailure("forbidden", 403);
  if (!res.ok) throw new RequestFailure("refused", res.status, payload.problem);
  return payload;
}

/**
 * `/ui/data` could not be read, and not because of the session. The page
 * stays signed in with its chrome and says so; a 500 or a dropped connection
 * is no reason to ask for a token again.
 */
function unreachable(loadFailure: "server" | "network"): void {
  set({ session: "ready", gate: null, refreshing: false, loadFailure });
}

let dataRevision = 0;

/** Fetch `/ui/data`. The only route that decides gated versus signed in. */
async function loadData(): Promise<void> {
  const identityCurrent = fence();
  const revision = ++dataRevision;
  const current = () => identityCurrent() && revision === dataRevision;
  set(state.session === "ready" ? { refreshing: true, loadFailure: null } : { loadFailure: null });
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (!current()) return;
    return gate(failure("Your sign-in session couldn't be read. Sign in again."));
  }
  if (!current()) return;
  if (!token && auth.kind !== "cloudflare-access") return gate(null);
  let res: Response;
  try {
    res = await fetch("/ui/data", {
      headers: requestHeaders(token),
      credentials: "same-origin",
    });
  } catch {
    if (!current()) return;
    return unreachable("network");
  }
  if (!current()) return;
  if (res.status === 401 || res.status === 403) {
    if (auth.kind === "clerk") {
      return gate(
        failure(
          res.status === 403
            ? `This Clerk account can't open ${productName}'s operator pages.`
            : "Your Clerk session wasn't accepted. Sign out, then sign in again.",
        ),
      );
    }
    if (auth.kind === "cloudflare-access") {
      return gate(
        failure("Cloudflare Access let this browser in, but this identity isn't an operator here."),
      );
    }
    localStorage.removeItem(TOKEN_KEY);
    return gate(failure("That token wasn't accepted. Paste a valid operator token."));
  }
  if (!res.ok) return unreachable("server");
  let data: UiData;
  try {
    data = (await res.json()) as UiData;
  } catch {
    if (!current()) return;
    return unreachable("server");
  }
  if (!current()) return;
  if (!data || !Array.isArray(data.connectors)) return unreachable("server");
  set({ data, session: "ready", gate: null, refreshing: false, loadFailure: null });
  rememberNav(data);
  void loadConnectorDetails(data, current, token);
}

/**
 * Every mutation in the same shape: mark the control busy, send exactly one
 * request, then land on a notice — success or failure, never neither. `reload`
 * refreshes the connector before landing, including after a failure, because a
 * partially applied reset must not leave stale tools and actions on screen.
 */
async function mutate(options: {
  request: (current: () => boolean) => Promise<OperatorResponse | null>;
  busy: Partial<OperatorState>;
  done: (payload: OperatorResponse | null) => Partial<OperatorState>;
  failed: (facts: RequestFailureFacts) => Partial<OperatorState>;
  /** The identity changed mid-request: nothing lands, but this still runs. */
  abandoned?: () => void;
  reload?: string | undefined;
}): Promise<void> {
  const current = fence();
  if (options.reload) detailRevisions.set(options.reload, (detailRevisions.get(options.reload) ?? 0) + 1);
  set(options.busy);
  try {
    const payload = await options.request(current);
    if (!current()) return options.abandoned?.();
    set(options.done(payload));
    if (options.reload) void refreshConnector(options.reload);
  } catch (error) {
    if (!current()) return options.abandoned?.();
    set(options.failed(factsOf(error)));
    if (options.reload) void refreshConnector(options.reload);
  }
}

export function focusHandled(): void {
  if (state.pendingFocus !== null || state.focusIfLost !== null) {
    set({ pendingFocus: null, focusIfLost: null });
  }
}

function setPage(page: OperatorPage, focus = false): void {
  state = withPage(state, page);
  if (focus) {
    state = {
      ...state,
      pendingFocus:
        state.session === "ready" ? `${page}Heading` : "gateHeading",
    };
  }
  for (const listener of listeners) listener();
}

let routerNavigate: ((href: string) => void) | undefined;
export function configureNavigation(navigate: (href: string) => void): void { routerNavigate = navigate; }
export function routeChanged(path: string): void {
  const page = pageForPath(path);
  if (state.page !== page) setPage(page, true);
}
export function navigate(page: OperatorPage, href: string): void {
  if (routerNavigate) routerNavigate(href);
  else history.pushState({ operatorPage: page }, "", href);
  setPage(page, true);
}

export function setConnectorFilter(connectorFilter: string): void {
  set({ connectorFilter });
}

export function setActivitySearch(activitySearch: string): void {
  set({ activitySearch });
}

/* Bearer sign-in ---------------------------------------------------------- */

export function signInWithBearer(value: string): void {
  gate(null);
  localStorage.setItem(TOKEN_KEY, value);
  void loadCurrent().then(() => {
    if (state.session === "ready") set({ pendingFocus: `${state.page}Heading` });
  });
}

export function forgetBearer(): void {
  localStorage.removeItem(TOKEN_KEY);
  gate(null);
  set({ pendingFocus: "token" });
}

/* In-page confirmation ------------------------------------------------------ */

/**
 * Ask before a row action that takes something away. The question renders in
 * the row, under the control that asked it, so nothing jumps and the browser's
 * modal — which named the connector by its id — is gone.
 */
export function askConfirm(connectorId: string, action: PendingConfirm["action"]): void {
  set({ confirming: { connectorId, action }, pendingFocus: `confirm-cancel-${connectorId}` });
}

export function cancelConfirm(returnFocusTo: string): void {
  set({ confirming: null, pendingFocus: returnFocusTo });
}

/* Downstream OAuth -------------------------------------------------------- */

export type OAuthStartMode = "continue" | "restart";

/**
 * The one place an OAuth start's mode meets the wire. `continue` reuses a
 * fresh pending authorization instead of resetting it, and on a connector
 * that is already healthy changes nothing; `restart` is the forced reset, and
 * is what the route assumes when no mode is sent.
 */
function oauthStartPath(connector: string, mode: OAuthStartMode): string {
  return `/ui/oauth/${encodeURIComponent(connector)}?mode=${mode}`;
}

/**
 * Connectors this tab sent off to authorize. Coming back to the tab re-reads
 * their status — and only their status: a status read never starts
 * authorization, so nothing here can open another consent screen.
 */
const awaitingAuthorization = new Set<string>();

/**
 * A blank tab, opened while the click that asked for it is still on the
 * stack — after an await, a browser treats the same call as a popup nobody
 * asked for. It says what it is waiting for, and is sent to the provider once
 * the route answers.
 */
function openBlankTab(): Window | null {
  let tab: Window | null = null;
  try {
    tab = window.open("", "_blank");
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    tab.document.title = "Opening authorization…";
    tab.document.body.textContent = "Opening the authorization page…";
  } catch {
    // A tab that cannot be written to still navigates.
  }
  return tab;
}

function oauthNoticePatch(connector: string, notice: Notice): Partial<OperatorState> {
  return {
    oauthBusy: null,
    oauthNotice: notice,
    oauthNoticeFor: connector,
    focusIfLost: `oauthNotice-${connector}`,
  };
}

/**
 * Start authorization in a new tab. `continue` for a connector that needs it,
 * `restart` for an explicit reconnect of a healthy one. If the browser refuses
 * the tab, the route is still asked, and the row offers the link it returned.
 */
export function startOAuth(connector: string, mode: OAuthStartMode): Promise<void> {
  const tab = openBlankTab();
  return mutate({
    request: (current) => operatorRequest(oauthStartPath(connector, mode), "POST", current),
    busy: {
      oauthBusy: connector,
      oauthNotice: null,
      oauthNoticeFor: connector,
      oauthBlocked: null,
      confirming: null,
    },
    done: (payload) => {
      const url = safeHttpHref(payload?.authorizationUrl);
      if (!url) {
        tab?.close();
        // Already connected: `continue` on a healthy connector changes nothing.
        if (payload?.state === "ok") {
          return oauthNoticePatch(connector, oauthDoneNotice("oauth_reconnect", payload));
        }
        return oauthNoticePatch(connector, refusedNotice("oauth_reconnect", connector));
      }
      if (tab) {
        // The provider's page gets no handle back to this one.
        tab.opener = null;
        tab.location.replace(url);
      }
      awaitingAuthorization.add(connector);
      return {
        ...(state.data
          ? {
              data: {
                ...state.data,
                connectors: state.data.connectors.map((c) =>
                  c.id === connector
                    ? { ...c, status: "auth_required" as const, tools: [], toolCount: 0, authorizationUrl: url }
                    : c,
                ),
              },
            }
          : {}),
        ...oauthNoticePatch(connector, oauthDoneNotice("oauth_reconnect", payload, Boolean(tab))),
        oauthBlocked: tab ? null : connector,
      };
    },
    // Signed out or switched mid-request: the tab it opened goes too, rather
    // than sitting on "Opening…" with nothing left to send it anywhere.
    abandoned: () => tab?.close(),
    // The route's words never reach this notice (see `refusedNotice`).
    failed: (facts) => {
      tab?.close();
      return oauthNoticePatch(
        connector,
        actionFailedNotice("oauth_reconnect", connector, facts, productName),
      );
    },
    reload: connector,
  });
}

export function disconnectOAuth(connector: string): Promise<void> {
  return mutate({
    request: (current) =>
      operatorRequest(`/ui/oauth/${encodeURIComponent(connector)}`, "DELETE", current),
    busy: {
      oauthBusy: connector,
      oauthNotice: null,
      oauthNoticeFor: connector,
      oauthBlocked: null,
      confirming: null,
    },
    done: (payload) => ({
      ...(state.data
        ? {
            data: {
              ...state.data,
              connectors: state.data.connectors.map((c) => {
                if (c.id !== connector) return c;
                const { authorizationUrl: _old, registrationPath: _path, ...rest } = c;
                return { ...rest, status: "auth_required" as const, tools: [], toolCount: 0 };
              }),
            },
          }
        : {}),
      ...oauthNoticePatch(connector, oauthDoneNotice("oauth_disconnect", payload)),
    }),
    failed: (facts) =>
      oauthNoticePatch(
        connector,
        actionFailedNotice("oauth_disconnect", connector, facts, productName),
      ),
    reload: connector,
  });
}

/* Credentials ------------------------------------------------------------- */

export function editCredential(connector: string | null): void {
  set({ credentialEditing: connector, credentialNotice: null, credentialNoticeFor: null });
}

/** A form the operator has not finished. Nothing is sent, and the page says why. */
export function refuseCredential(connector: string, copy: string): void {
  set({ credentialNotice: failure(copy), credentialNoticeFor: connector });
}

function credentialMutation(
  connector: string,
  action: RowAction,
  request: (current: () => boolean) => Promise<OperatorResponse | null>,
  done: (payload: OperatorResponse | null) => Partial<OperatorState> & { credentialNotice: Notice },
  reload = true,
): Promise<void> {
  const land = (patch: Partial<OperatorState>) => ({
    credentialBusy: null,
    credentialNoticeFor: connector,
    focusIfLost: `credentialNotice-${connector}`,
    ...patch,
  });
  return mutate({
    request,
    busy: {
      credentialBusy: connector,
      credentialNotice: null,
      credentialNoticeFor: connector,
      confirming: null,
    },
    done: (payload) => land(done(payload)),
    failed: (facts) =>
      land({ credentialNotice: actionFailedNotice(action, connector, facts, productName) }),
    reload: reload ? connector : undefined,
  });
}

export function saveCredential(
  connector: string,
  body: { value: string } | { values: Record<string, string> },
): Promise<void> {
  return credentialMutation(
    connector,
    "credential_save",
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}`,
        "PUT",
        current,
        body,
      ),
    () => ({ credentialEditing: null, credentialNotice: info("Credential saved.") }),
  );
}

export function removeCredential(connector: string): Promise<void> {
  return credentialMutation(
    connector,
    "credential_remove",
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}`,
        "DELETE",
        current,
      ),
    () => ({ credentialNotice: info("Credential removed.") }),
  );
}

export function testCredential(connector: string): Promise<void> {
  return credentialMutation(
    connector,
    "credential_test",
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}/test`,
        "POST",
        current,
      ),
    (payload) => ({ credentialNotice: credentialTestNotice(connector, payload) }),
    false,
  );
}

/* Activity ---------------------------------------------------------------- */

let activityRevision = 0;
export async function loadActivity(reset: boolean): Promise<void> {
  if (!state.data?.activityEnabled) return;
  const identityCurrent = fence();
  const revision = ++activityRevision;
  const current = () => identityCurrent() && revision === activityRevision;
  set({
    activityPhase: "loading",
    activityNotice: null,
    ...(reset ? { activityEvents: [], activityCursor: null } : {}),
  });
  const params = new URLSearchParams({ limit: "50" });
  if (!reset && state.activityCursor) {
    params.set("cursor", state.activityCursor);
  }
  try {
    const payload = await operatorRequest(
      `/ui/activity?${params}`,
      "GET",
      current,
    );
    if (!current()) return;
    if (!payload || !Array.isArray(payload.events)) throw new RequestFailure("refused");
    set({
      activityPhase: "ready",
      activityEvents: [
        ...(reset ? [] : state.activityEvents),
        ...(payload?.events ?? []),
      ],
      activityCursor: payload?.nextCursor ?? null,
    });
  } catch (error) {
    if (!current()) return;
    set({
      activityPhase: "error",
      activityNotice: failure(collectionFailureCopy("activity", factsOf(error), productName)),
    });
  }
}

/* Artifacts --------------------------------------------------------------- */

/**
 * An artifact API read with the session's token. Artifact pages never read
 * `/ui/data` — a dedicated artifact origin does not serve it — so this is
 * where they learn whether the session is accepted. Only a status decides
 * what the page says; no refusal's text reaches it.
 */
async function artifactRead(
  path: string,
  current: () => boolean,
  collection: "artifacts" | "artifact",
): Promise<Response | undefined> {
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (current()) gate(failure("Your sign-in session couldn't be read. Sign in again."));
    return undefined;
  }
  if (!current()) return undefined;
  if (!token && auth.kind !== "cloudflare-access") {
    gate(null);
    return undefined;
  }
  let res: Response;
  try {
    res = await fetch(path, { headers: requestHeaders(token), credentials: "same-origin" });
  } catch {
    // Not the session's fault: stay signed in, say so, and offer a retry.
    if (current()) {
      set({
        session: "ready",
        gate: null,
        artifactPhase: "error",
        artifactNotice: failure(collectionFailureCopy(collection, { kind: "network" }, productName)),
      });
    }
    return undefined;
  }
  if (!current()) return undefined;
  if (res.status === 401) {
    if (auth.kind !== "clerk" && auth.kind !== "cloudflare-access") {
      localStorage.removeItem(TOKEN_KEY);
      gate(failure("That token wasn't accepted. Paste a valid operator token."));
    } else {
      gate(failure("Your session wasn't accepted. Sign out, then sign in again."));
    }
    return undefined;
  }
  if (res.status === 403) {
    gate(failure("This deployment doesn't open artifact pages to this identity."));
    return undefined;
  }
  return res;
}

let artifactRevision = 0;
export async function loadArtifacts(reset: boolean): Promise<void> {
  const identityCurrent = fence();
  const revision = ++artifactRevision;
  const current = () => identityCurrent() && revision === artifactRevision;
  set({
    artifactPhase: "loading",
    artifactNotice: null,
    ...(reset ? { artifactRows: [], artifactCursor: null } : {}),
  });
  const params = new URLSearchParams();
  if (state.artifactQuery.trim()) params.set("q", state.artifactQuery.trim());
  if (state.artifactArchived) params.set("archived", "1");
  if (!reset && state.artifactCursor) params.set("cursor", state.artifactCursor);
  const query = params.toString();
  const res = await artifactRead(`/artifacts/_api/list${query ? `?${query}` : ""}`, current, "artifacts");
  if (!res || !current()) return;
  if (!res.ok) {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure(
        collectionFailureCopy("artifacts", { kind: "refused", status: res.status }, productName),
      ),
    });
  }
  let payload: { artifacts?: UiArtifactRow[]; nextCursor?: string } | null;
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    payload = null;
  }
  if (!current()) return;
  if (!payload || !Array.isArray(payload.artifacts)) {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure(collectionFailureCopy("artifacts", { kind: "refused" }, productName)),
    });
  }
  set({
    session: "ready",
    gate: null,
    artifactPhase: "ready",
    artifactRows: [...(reset ? [] : state.artifactRows), ...(payload.artifacts ?? [])],
    artifactCursor: payload.nextCursor ?? null,
  });
}

let artifactFrameConfined = false;

/** The frame navigation policy cannot be relaxed within this document. */
export function markArtifactFrameConfined(): void {
  artifactFrameConfined = true;
}

async function loadArtifactView(): Promise<void> {
  if (artifactFrameConfined) {
    // A replacement identity needs a fresh bootstrap and a fresh CSP policy.
    window.location.reload();
    return;
  }
  const current = fence();
  const request = artifactViewRequest(window.location.pathname, window.location.search);
  set({ artifactPhase: "loading", artifactNotice: null });
  if (!request) {
    return set({
      session: "ready",
      artifactPhase: "error",
      artifactNotice: failure("There is no artifact at this address."),
    });
  }
  const res = await artifactRead(request, current, "artifact");
  if (!res || !current()) return;
  if (!res.ok) {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure(
        collectionFailureCopy("artifact", { kind: "refused", status: res.status }, productName),
      ),
    });
  }
  let view: UiArtifactView | null = null;
  try {
    view = (await res.json()) as UiArtifactView;
  } catch {
    view = null;
  }
  if (!current()) return;
  if (!view || typeof view.document !== "string") {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure("The artifact couldn't be read. Retry in a moment."),
    });
  }
  set({ session: "ready", gate: null, artifactPhase: "ready", artifactView: view });
}

export function setArtifactQuery(artifactQuery: string): void {
  set({ artifactQuery });
}

export function setArtifactArchived(artifactArchived: boolean): void {
  set({ artifactArchived });
  void loadArtifacts(true);
}

/** Load what the current page shows, deciding gated or ready on the way. */
function loadCurrent(): Promise<void> {
  if (state.page === "artifacts") return loadArtifacts(true);
  if (state.page === "artifact") return loadArtifactView();
  return loadData();
}

/**
 * The signed-in error state's Retry: the same read, from the top. The block
 * that held the button is about to go, so focus moves to the heading of the
 * region being reloaded instead of dropping to the page.
 */
export function retryLoad(): Promise<void> {
  set({
    pendingFocus: state.page === "connections" ? "connectorLedgerHeading" : `${state.page}Heading`,
  });
  return loadCurrent();
}

/** Retry for a collection page, with focus kept on its heading. */
export function retryCollection(): Promise<void> {
  set({ pendingFocus: `${state.page}Heading` });
  if (state.page === "activity") return loadActivity(true);
  if (state.page === "artifact") return loadArtifactView();
  return loadArtifacts(true);
}

/* Boot -------------------------------------------------------------------- */

export function signIn(): void {
  window.Clerk?.redirectToSignIn({
    signInFallbackRedirectUrl: window.location.href,
    signUpFallbackRedirectUrl: window.location.href,
  });
}

export function signOut(): void {
  if (auth.kind === "cloudflare-access") {
    gate(null);
    window.location.assign("/cdn-cgi/access/logout");
    return;
  }
  const clerk = window.Clerk;
  gate(null);
  void clerk?.signOut({ redirectUrl: window.location.href });
}

/**
 * Coming back to this tab — from the provider's consent screen, usually —
 * re-reads the status of every connector still waiting on authorization.
 * Focus and visibility both fire on a return, so the two coalesce into one
 * pass, and a pass that ran a moment ago is not repeated.
 */
let returnTimer: ReturnType<typeof setTimeout> | undefined;
let lastReturnPass = 0;
const RETURN_DEBOUNCE_MS = 150;
const RETURN_MIN_INTERVAL_MS = 2000;

function onReturn(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (returnTimer !== undefined) return;
  returnTimer = setTimeout(() => {
    returnTimer = undefined;
    const now = Date.now();
    if (now - lastReturnPass < RETURN_MIN_INTERVAL_MS) return;
    lastReturnPass = now;
    recheckAuthorization();
  }, RETURN_DEBOUNCE_MS);
}

function recheckAuthorization(): void {
  if (state.session !== "ready" || !state.data) return;
  for (const connector of state.data.connectors) {
    if (state.oauthBusy === connector.id) continue;
    // Only authorization that happens in another tab can change while this
    // one is away; a credential slot is filled on this page.
    const authorizesElsewhere =
      connector.status === "auth_required" &&
      (connector.oauth === true || Boolean(connector.authorizationUrl));
    if (authorizesElsewhere || awaitingAuthorization.has(connector.id)) {
      void refreshConnector(connector.id, true);
    }
  }
}

export async function boot(): Promise<void> {
  const onPop = () => { if (!routerNavigate) routeChanged(window.location.pathname); };
  window.addEventListener("popstate", onPop);
  window.addEventListener("focus", onReturn);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onReturn);
  }
  // A document restored from the back-forward cache must not restore a secret.
  if (auth.kind === "clerk") {
    const clerk = window.Clerk;
    if (!clerk) {
      return gate(failure("Clerk couldn't load. Check your connection and try again."));
    }
    try {
      await clerk.load({
        ...(auth.signInUrl ? { signInUrl: auth.signInUrl } : {}),
        ...(auth.signUpUrl ? { signUpUrl: auth.signUpUrl } : {}),
        signInFallbackRedirectUrl: window.location.href,
        signUpFallbackRedirectUrl: window.location.href,
        afterSignOutUrl: window.location.href,
      });
      let sessionId = clerk.session?.id ?? null;
      clerk.addListener((resources) => {
        const next = resources.session?.id ?? null;
        if (next === sessionId) return;
        sessionId = next;
        // Clerk has already updated its public session before notifying
        // listeners. Clear synchronously so stale identity-scoped data cannot
        // be repainted while the replacement identity is being fetched.
        gate(null);
        void loadCurrent();
      });
    } catch {
      return gate(failure("Clerk couldn't start. Reload the page to try again."));
    }
  }
  await loadCurrent();
}

/* Connector details --------------------------------------------------------- */

/**
 * One connector's details, classified by whose side failed. A 401 or 403 is
 * the session's; a request that never got an answer is the network's; any
 * other failure is the connector's own, and only that one earns the
 * downstream's copy and fix prompt.
 */
type DetailOutcome =
  | { kind: "detail"; detail: UiConnector }
  | { kind: "local"; failure: ConnectorLoadFailure }
  | { kind: "downstream" };

async function readConnector(id: string, token: string | null | undefined): Promise<DetailOutcome> {
  try {
    return await queryClient.fetchQuery({
      queryKey: ["connector", state.generation, id, detailRevisions.get(id) ?? 0],
      queryFn: () => fetchConnector(id, token),
    });
  } catch (error) {
    // Clearing an identity's cache cancels pending Query promises. The session
    // fence drops this outcome; consume the rejection even on background loads.
    return { kind: "local", failure: isCancelledError(error) ? "session" : "network" };
  }
}

async function fetchConnector(id: string, token: string | null | undefined): Promise<DetailOutcome> {
  let response: Response;
  try {
    response = await fetch(`/ui/connectors/${encodeURIComponent(id)}`, {
      headers: requestHeaders(token),
      credentials: "same-origin",
    });
  } catch {
    return { kind: "local", failure: "network" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "local", failure: "session" };
  }
  if (!response.ok) return { kind: "downstream" };
  try {
    return { kind: "detail", detail: (await response.json()) as UiConnector };
  } catch {
    return { kind: "downstream" };
  }
}

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Land one connector's outcome on screen. */
function applyDetail(id: string, outcome: DetailOutcome): void {
  if (!state.data) return;
  const patch: Partial<OperatorState> = {};
  const connectors = state.data.connectors.map((c) => {
    if (c.id !== id) return c;
    if (outcome.kind === "detail") {
      const { detail } = outcome;
      return detail.status === "auth_required" && c.authorizationUrl && !detail.authorizationUrl
        ? { ...detail, authorizationUrl: c.authorizationUrl }
        : detail;
    }
    const { problem: _problem, ...rest } = c;
    return outcome.kind === "downstream"
      ? { ...rest, status: "error" as const, problem: "connector_unavailable" as const }
      : { ...rest, status: "error" as const };
  });
  patch.connectorFailures =
    outcome.kind === "local"
      ? { ...state.connectorFailures, [id]: outcome.failure }
      : withoutKey(state.connectorFailures, id);
  // Authorization finished elsewhere: this row now says so in its own words.
  if (outcome.kind === "detail" && outcome.detail.status === "ok" && awaitingAuthorization.delete(id)) {
    if (state.oauthNoticeFor === id) {
      patch.oauthNotice = info("Connected.");
      patch.oauthBlocked = null;
    }
  }
  set({ ...patch, data: { ...state.data, connectors } });
}

let detailGeneration = 0;
const detailRevisions = new Map<string, number>();
async function loadConnectorDetails(data: UiData, current: () => boolean, token: string | null | undefined): Promise<void> {
  const generation = ++detailGeneration;
  let next = 0;
  const worker = async () => {
    while (next < data.connectors.length && current() && generation === detailGeneration) {
      const connector = data.connectors[next++]!;
      const revision = (detailRevisions.get(connector.id) ?? 0) + 1;
      detailRevisions.set(connector.id, revision);
      const outcome = await readConnector(connector.id, token);
      if (!current() || generation !== detailGeneration || !state.data) return;
      if (detailRevisions.get(connector.id) !== revision) continue;
      applyDetail(connector.id, outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, data.connectors.length) }, worker));
}

/**
 * Re-read one connector. A `quiet` read — the one a returning tab makes —
 * keeps the row as it is while it waits, and keeps it as it was when the read
 * could not get through: a passive check that fails has nothing new to say.
 */
export async function refreshConnector(id: string, quiet = false): Promise<void> {
  const current = fence();
  const revision = (detailRevisions.get(id) ?? 0) + 1;
  detailRevisions.set(id, revision);
  if (!quiet && state.data) {
    set({
      data: { ...state.data, connectors: state.data.connectors.map(c => c.id === id ? { ...c, status: "loading" } : c) },
      connectorFailures: withoutKey(state.connectorFailures, id),
    });
  }
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (!current() || quiet || detailRevisions.get(id) !== revision) return;
    return applyDetail(id, { kind: "local", failure: "session" });
  }
  if (!current()) return;
  const outcome = await readConnector(id, token);
  if (!current() || !state.data || detailRevisions.get(id) !== revision) return;
  // A passive read only reports good news: a transient failure on a focus
  // check is not a reason to repaint an auth-needed row as broken.
  if (quiet && outcome.kind !== "detail") return;
  applyDetail(id, outcome);
}

/* Access tokens ----------------------------------------------------------- */

let tokenRevision = 0;
export async function loadAccessTokens(): Promise<void> {
  const identityCurrent = fence();
  const revision = ++tokenRevision;
  const current = () => identityCurrent() && revision === tokenRevision;
  const existing = new Map(state.tokens.map(token => [token.id, token]));
  set({ tokenPhase: "loading", tokenNotice: null });
  try {
    const payload = await operatorRequest("/ui/access-tokens", "GET", current);
    if (!current()) return;
    if (!Array.isArray(payload?.accessTokens)) throw new Error("The access token collection was not returned.");
    const tokens = payload.accessTokens;
    // Creation, rename and revoke replace record objects. Prefer records
    // changed locally since this read began over its possibly older snapshot.
    const changed = state.tokens.filter(token => existing.get(token.id) !== token);
    const changedIds = new Set(changed.map(token => token.id));
    set({ tokenPhase: "ready", tokens: [
      ...changed,
      ...tokens.filter(token => !changedIds.has(token.id)),
    ] });
  } catch {
    if (!current()) return;
    set({
      tokenPhase: "error",
      tokenNotice: failure(
        "Access tokens could not be loaded.",
      ),
    });
  }
}

function tokenFailure(tokenNotice: Notice): Partial<OperatorState> {
  return { tokenBusy: false, tokenNotice, pendingFocus: "tokenNotice" };
}

/**
 * Resolves true only when the token exists. `mutate` lands a handled failure in
 * state and resolves like any other outcome, so a caller that clears its form on
 * resolution would throw away what the operator typed the moment the POST
 * failed — the dead end every other flow here avoids. The form clears on this
 * boolean instead.
 */
export function createAccessToken(name: string): Promise<boolean> {
  if (state.tokenBusy) return Promise.resolve(false);
  if (!name) {
    set(tokenFailure(failure("Name the MCP client before creating a token.")));
    return Promise.resolve(false);
  }
  let created = false;
  return mutate({
    request: (current) =>
      operatorRequest("/ui/access-tokens", "POST", current, { name }),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => {
      const issued = payload?.accessToken;
      if (!payload?.token || !issued) {
        throw new Error("The created token was not returned.");
      }
      created = true;
      return {
        tokenBusy: false,
        tokenPhase: "ready",
        tokens: [
          issued,
          ...state.tokens.filter((token) => token.id !== issued.id),
        ],
        createdToken: state.page === "tokens" ? payload.token : null,
        tokenNotice: info("Access token created."),
        pendingFocus: state.page === "tokens" ? "tokenRevealHeading" : null,
      };
    },
    failed: () => tokenFailure(failure("Access token could not be created. Check the name, capacity, and storage.")),
  }).then(() => created);
}

export function dismissCreatedToken(): void {
  set({ createdToken: null });
}

export function renameAccessToken(id: string | null): void {
  set({ tokenRenaming: id });
}

function accessTokenMutation(
  id: string,
  method: "DELETE" | "PUT",
  body: object | undefined,
  success: string,
  fallback: string,
): Promise<void> {
  return mutate({
    request: (current) =>
      operatorRequest(
        `/ui/access-tokens/${encodeURIComponent(id)}`,
        method,
        current,
        body,
      ),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => ({
      tokenBusy: false,
      tokenRenaming: null,
      tokenNotice: info(success),
      pendingFocus: "tokenNotice",
      ...(payload?.accessToken
        ? {
            tokens: state.tokens.map((token) =>
              token.id === id ? payload.accessToken! : token,
            ),
          }
        : {}),
    }),
    failed: () => tokenFailure(failure(fallback)),
  });
}

export function saveAccessTokenName(id: string, name: string): Promise<void> {
  return accessTokenMutation(
    id,
    "PUT",
    { name },
    "Access token renamed.",
    "Access token could not be renamed.",
  );
}

export function revokeAccessToken(id: string): Promise<void> {
  const named = state.tokens.find((token) => token.id === id);
  const confirmed = window.confirm(
    `Revoke ${named?.name || "this access token"}? Its MCP client will immediately lose access.`,
  );
  if (!confirmed) return Promise.resolve();
  return accessTokenMutation(
    id,
    "DELETE",
    undefined,
    "Access token revoked.",
    "Access token could not be revoked.",
  );
}
