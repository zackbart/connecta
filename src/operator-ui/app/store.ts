import type { OperatorRole, OperatorUiContractV2 } from "../contract.js";
import { queryClient } from "./query.js";
import { isCancelledError } from "@tanstack/react-query";
import type { UiConnector, UiData } from "../model.js";
import {
  actionFailedNotice,
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

function requestHeaders(token: string | null | undefined, body = false): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}),
  };
}

/** Preserve the Activity link across reloads when the deployment read fails. */
const NAV_HINT_KEY = "connecta:nav";

function rememberNav(data: UiData): void {
  try {
    sessionStorage.setItem(NAV_HINT_KEY, JSON.stringify({ activity: data.activityEnabled }));
  } catch {
    /* Storage may be unavailable. */
  }
}

function forgetNav(): void {
  try {
    sessionStorage.removeItem(NAV_HINT_KEY);
  } catch {
    /* Nothing was stored. */
  }
}

/** A tab-local hint, erased on every identity change; it grants no API access. */
export function navHint(): { activity: boolean } {
  try {
    const hint = JSON.parse(sessionStorage.getItem(NAV_HINT_KEY) ?? "null") as { activity?: unknown } | null;
    return { activity: hint?.activity === true };
  } catch {
    return { activity: false };
  }
}

function gate(notice: Notice | null = null, session: OperatorState["session"] = "gated"): void {
  queryClient.clear();
  forgetNav();
  awaitingAuthorization.clear();
  state = { ...resetIdentity(state, notice), session };
  for (const listener of listeners) listener();
}

/**
 * The session's own refusal, in the words of the sign-in in use. A bearer
 * token the deployment refused is forgotten, so the gate asks for another.
 */
function refuseSession(status: number): void {
  if (auth.kind === "clerk") {
    return gate(
      failure(
        status === 403
          ? `This Clerk account can't open ${productName}'s operator pages.`
          : "Your Clerk session wasn't accepted. Sign out, then sign in again.",
      ),
    );
  }
  if (auth.kind === "cloudflare-access") {
    return gate(failure("Cloudflare Access let this browser in, but this identity isn't an operator here."));
  }
  localStorage.removeItem(TOKEN_KEY);
  gate(failure("That token wasn't accepted. Paste a valid operator token."));
}

interface OperatorResponse {
  token?: string;
  agent?: UiAgentSlot;
  agents?: UiAgentSlot[];
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
 * A failed Access summary cannot establish an identity. Other auth modes keep
 * their existing signed-in error page. Both can retry the read.
 */
function unreachable(loadFailure: "server" | "network"): void {
  if (auth.kind === "cloudflare-access") {
    gate(failure("Cloudflare Access identity is unavailable. Retry to check your session."));
  } else {
    set({ session: "ready", gate: null, refreshing: false, loadFailure });
  }
  scheduleRecovery();
}

let dataRevision = 0;

/**
 * Fetch `/ui/data`, maintainers only: the contract has already said who this
 * is, and a member never asks for it.
 */
async function loadData(): Promise<void> {
  if (!maintainerNow()) return;
  const identityCurrent = fence();
  const revision = ++dataRevision;
  ++snapshotRevision;
  const current = () => identityCurrent() && revision === dataRevision && !signal.aborted;
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
      signal,
      headers: requestHeaders(token),
      credentials: "same-origin",
    });
  } catch {
    if (!current()) return;
    return unreachable("network");
  }
  if (!current()) return;
  if (res.status === 401 || res.status === 403) return refuseSession(res.status);
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
  rememberNav(data);
  set({
    data,
    contract: null,
    contractPhase: "loading",
    session: "ready",
    gate: null,
    refreshing: false,
    loadFailure: null,
  });
  // A passive recovery owns the whole matching catalog/auth cycle. Releasing
  // its in-flight guard at the summary would let focus supersede slow reads.
  await refreshSnapshot(false, undefined, signal);
}

/**
 * Contract v2 only: one cutover, no v1 fallback. A maintainer view carries
 * `config` and `root`; a member view carries neither, and nothing on screen
 * reads a maintainer field without checking `role` first.
 */
function isContractV2(value: OperatorUiContractV2 | null): value is OperatorUiContractV2 {
  if (!value || value.schemaVersion !== 2) return false;
  if (value.role !== "maintainer" && value.role !== "member") return false;
  if (!value.you || !Array.isArray(value.live?.connectors) || !Array.isArray(value.pools)) return false;
  if (!Array.isArray(value.matrix) || !Array.isArray(value.agents) || !Array.isArray(value.connectors)) return false;
  return value.role === "member" || (Boolean(value.config) && Boolean(value.root));
}

type ContractOutcome =
  | { kind: "contract"; contract: OperatorUiContractV2 }
  | { kind: "session"; status: number }
  | { kind: "denied" }
  | { kind: "network" }
  | { kind: "refused" };

async function fetchContract(token: string | null | undefined, signal: AbortSignal): Promise<ContractOutcome> {
  let response: Response;
  try {
    response = await fetch("/ui/api/config", { headers: requestHeaders(token), credentials: "same-origin", signal });
  } catch {
    return { kind: "network" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "session", status: response.status };
  // The private 404: signed in, but neither a maintainer nor a pool member.
  if (response.status === 404) return { kind: "denied" };
  if (!response.ok) return { kind: "refused" };
  try {
    const value = (await response.json()) as OperatorUiContractV2;
    return isContractV2(value) ? { kind: "contract", contract: value } : { kind: "refused" };
  } catch {
    return { kind: "refused" };
  }
}

/**
 * `GET /ui/api/config` is the one gate, for both roles: 401 is signed out,
 * the private 404 is signed in without access, and 200 says who this viewer
 * is. Resolves to that role, or null when the page has nothing to build on.
 * Nothing maintainer-only is requested until it resolves "maintainer".
 */
let contractRevision = 0;
export async function loadOperatorContract(): Promise<OperatorRole | null> {
  const identityCurrent = fence();
  const revision = ++contractRevision;
  const current = () => identityCurrent() && revision === contractRevision;
  set({ contractPhase: "loading" });
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (current()) gate(failure("Your sign-in session couldn't be read. Sign in again."));
    return null;
  }
  if (!current()) return null;
  if (!token && auth.kind !== "cloudflare-access") {
    gate(null);
    return null;
  }
  let outcome: ContractOutcome;
  try {
    outcome = await queryClient.fetchQuery({
      queryKey: ["operator-config", state.generation, revision],
      queryFn: ({ signal }) => fetchContract(token, signal),
    });
  } catch {
    // Clearing an identity's cache cancels the query; the fence drops it.
    outcome = { kind: "network" };
  }
  if (!current()) return null;
  if (outcome.kind === "session") {
    refuseSession(outcome.status);
    return null;
  }
  if (outcome.kind === "denied") {
    gate(null, "denied");
    return null;
  }
  if (outcome.kind !== "contract") {
    // No role to render by: the page offers a retry and nothing privileged.
    set({
      session: "ready",
      contract: null,
      contractPhase: "error",
      loadFailure: outcome.kind === "network" ? "network" : null,
    });
    return null;
  }
  const { contract } = outcome;
  // A role other than the last confirmed one is a different viewer, even
  // when a failed refresh cleared `contract` in between: drop everything read
  // for the old role and fence its requests in flight, then accept this
  // answer as a fresh start. A new maintainer's data loads here, so the
  // caller has nothing more to do.
  const changed = state.role !== null && state.role !== contract.role;
  if (changed) gate(null, "loading");
  // A maintainer's page waits for `/ui/data` too; a member's is ready now.
  set({
    contract,
    role: contract.role,
    contractPhase: "ready",
    ...(contract.role === "member" ? { session: "ready" as const, loadFailure: null } : {}),
  });
  if (!changed) return contract.role;
  if (contract.role === "maintainer") void loadData();
  return null;
}

/**
 * Whether a maintainer-only read may go out now: the last confirmed role is
 * maintainer and the contract on screen still says so. Every privileged read
 * checks this when it is sent, not only at boot, so a background refetch
 * never runs for a member or while the role is unknown.
 */
function maintainerNow(): boolean {
  return state.role === "maintainer" && state.contract?.role === "maintainer";
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
  if (options.reload) {
    ++snapshotRevision;
    ++dataRevision;
    releaseRecoveryRead();
  }
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
      pendingFocus: state.session === "ready" ? `${page}Heading` : "gateHeading",
    };
  }
  for (const listener of listeners) listener();
}

let routerNavigate: ((href: string) => void) | undefined;
let currentPath = window.location.pathname;
let navigationRevision = 0;
export function configureNavigation(navigate: (href: string) => void): void {
  routerNavigate = navigate;
}
export function routeChanged(path: string): void {
  if (path !== currentPath) {
    currentPath = path;
    ++navigationRevision;
    const pendingRead = recoveryRead !== undefined;
    cancelRecoveryRead();
    if (pendingRead) scheduleRecovery();
    for (const id of awaitingAuthorization.keys()) {
      if (path !== `/connectors/${encodeURIComponent(id)}`) stopOAuthPolling(id);
    }
  }
  const page = pageForPath(path);
  if (state.page !== page) setPage(page, true);
}
export function navigate(page: OperatorPage, href: string): void {
  routeChanged(new URL(href, window.location.href).pathname);
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
  resetRecovery();
  gate(null);
  signedOut = false;
  localStorage.setItem(TOKEN_KEY, value);
  const current = fence();
  void loadCurrent().then(() => {
    if (state.session === "ready") set({ pendingFocus: `${state.page}Heading` });
    else if (state.session === "denied") set({ pendingFocus: "gateHeading" });
  });
}

export function forgetBearer(): void {
  signedOut = true;
  resetRecovery();
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
const awaitingAuthorization = new Map<string, number>();
let oauthPollTimer: ReturnType<typeof setTimeout> | undefined;
let oauthDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
let oauthPollController: AbortController | undefined;
let oauthPollGeneration = 0;
const OAUTH_POLL_INTERVAL_MS = 2000;
const OAUTH_POLL_WINDOW_MS = 30_000;

/** Navigation, unmount and identity resets also cancel in-flight poll reads. */
export function stopOAuthPolling(connector?: string): void {
  ++oauthPollGeneration;
  if (connector && !awaitingAuthorization.has(connector)) return;
  if (connector) awaitingAuthorization.delete(connector);
  else awaitingAuthorization.clear();
  clearTimeout(oauthPollTimer);
  clearTimeout(oauthDeadlineTimer);
  oauthPollTimer = undefined;
  oauthDeadlineTimer = undefined;
  oauthPollController?.abort();
  oauthPollController = undefined;
}

/** Connector-page unmount cancels any read still owned by that view. */
export function stopConnectorReads(id: string): void {
  cancelRecoveryRead();
  stopOAuthPolling(id);
}

function scheduleOAuthPoll(): void {
  if (oauthPollTimer !== undefined || awaitingAuthorization.size === 0) return;
  const current = fence();
  const generation = oauthPollGeneration;
  oauthPollTimer = setTimeout(async () => {
    oauthPollTimer = undefined;
    if (!current() || generation !== oauthPollGeneration) return;
    for (const [id, deadline] of awaitingAuthorization) {
      if (Date.now() >= deadline) stopOAuthPolling(id);
    }
    if (awaitingAuthorization.size === 0) return;
    if (
      (typeof document === "undefined" || document.visibilityState !== "hidden") &&
      state.session === "ready" &&
      !state.oauthBusy
    ) {
      for (const id of awaitingAuthorization.keys()) {
        await pollOAuthConnector(id);
      }
    }
    scheduleOAuthPoll();
  }, OAUTH_POLL_INTERVAL_MS);
}

async function pollOAuthConnector(id: string): Promise<void> {
  if (oauthPollController || !awaitingAuthorization.has(id)) return;
  const controller = new AbortController();
  oauthPollController = controller;
  await refreshSnapshot(true, id, controller.signal);
  if (oauthPollController === controller) oauthPollController = undefined;
}

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
  stopOAuthPolling();
  const startedOn = navigationRevision;
  const generation = oauthPollGeneration;
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
      if (startedOn === navigationRevision && generation === oauthPollGeneration) {
        awaitingAuthorization.set(connector, Date.now() + OAUTH_POLL_WINDOW_MS);
        oauthDeadlineTimer = setTimeout(() => stopOAuthPolling(connector), OAUTH_POLL_WINDOW_MS);
        scheduleOAuthPoll();
      }
      return {
        ...(state.data
          ? {
              data: {
                ...state.data,
                connectors: state.data.connectors.map((c) =>
                  c.id === connector ? { ...c, authorizationUrl: url } : c,
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
      return oauthNoticePatch(connector, actionFailedNotice("oauth_reconnect", connector, facts, productName));
    },
    reload: connector,
  });
}

export function disconnectOAuth(connector: string): Promise<void> {
  stopOAuthPolling(connector);
  return mutate({
    request: (current) => operatorRequest(`/ui/oauth/${encodeURIComponent(connector)}`, "DELETE", current),
    busy: {
      oauthBusy: connector,
      oauthNotice: null,
      oauthNoticeFor: connector,
      oauthBlocked: null,
      confirming: null,
    },
    done: (payload) => oauthNoticePatch(connector, oauthDoneNotice("oauth_disconnect", payload)),
    failed: (facts) =>
      oauthNoticePatch(connector, actionFailedNotice("oauth_disconnect", connector, facts, productName)),
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
    failed: (facts) => land({ credentialNotice: actionFailedNotice(action, connector, facts, productName) }),
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
    (current) => operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}`, "PUT", current, body),
    () => ({ credentialEditing: null, credentialNotice: info("Credential saved.") }),
  );
}

export function removeCredential(connector: string): Promise<void> {
  return credentialMutation(
    connector,
    "credential_remove",
    (current) => operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}`, "DELETE", current),
    () => ({ credentialNotice: info("Credential removed.") }),
  );
}

export function testCredential(connector: string): Promise<void> {
  return credentialMutation(
    connector,
    "credential_test",
    (current) => operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}/test`, "POST", current),
    (payload) => ({ credentialNotice: credentialTestNotice(connector, payload) }),
    false,
  );
}

/* Activity ---------------------------------------------------------------- */

let activityRevision = 0;
export async function loadActivity(reset: boolean): Promise<void> {
  if (!maintainerNow() || !state.data?.activityEnabled) return;
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
    const payload = await operatorRequest(`/ui/api/activity?${params}`, "GET", current);
    if (!current()) return;
    if (!payload || !Array.isArray(payload.events)) throw new RequestFailure("refused");
    set({
      activityPhase: "ready",
      activityEvents: [...(reset ? [] : state.activityEvents), ...(payload?.events ?? [])],
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

/** Load what the current page shows, deciding gated or ready on the way. */
async function loadCurrent(): Promise<void> {
  if ((await loadOperatorContract()) === "maintainer") await loadData();
}

/**
 * The signed-in error state's Retry: the same read, from the top. The block
 * that held the button is about to go, so focus moves to the heading of the
 * region being reloaded instead of dropping to the page.
 */
let lastExplicitRetry = -Infinity;

export function retryLoad(): Promise<void> {
  const now = Date.now();
  if (signedOut || now - lastExplicitRetry < RETURN_DEBOUNCE_MS) return Promise.resolve();
  lastExplicitRetry = now;
  resetRecovery();
  lastReturnPass = now;
  set({
    pendingFocus: `${state.page}Heading`,
  });
  return loadCurrent(true);
}

/** Retry for a collection page, with focus kept on its heading. */
export function retryCollection(): Promise<void> {
  set({ pendingFocus: `${state.page}Heading` });
  if (state.page === "activity" || state.page === "connector") return loadActivity(true);
  return loadActivity(true);
}

/* Boot -------------------------------------------------------------------- */

export function signIn(): void {
  signedOut = false;
  window.Clerk?.redirectToSignIn({
    signInFallbackRedirectUrl: window.location.href,
    signUpFallbackRedirectUrl: window.location.href,
  });
}

let signedOut = false;

export function signOut(): void {
  signedOut = true;
  resetRecovery();
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
let lastReturnPass = -Infinity;
const RETURN_DEBOUNCE_MS = 150;
const RETURN_MIN_INTERVAL_MS = 2000;

function onReturn(): void {
  if (signedOut) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (returnTimer !== undefined) return;
  const current = fence();
  returnTimer = setTimeout(() => {
    returnTimer = undefined;
    if (!current() || signedOut) return;
    recheckAuthorization();
  }, RETURN_DEBOUNCE_MS);
}

function recheckAuthorization(): void {
  if (state.session !== "ready" || !state.data || !maintainerNow()) return;
  for (const connector of state.data.connectors) {
    if (state.oauthBusy === connector.id) continue;
    // Only authorization that happens in another tab can change while this
    // one is away; a credential slot is filled on this page.
    const authorizesElsewhere =
      connector.status === "auth_required" && (connector.oauth === true || Boolean(connector.authorizationUrl));
    if (authorizesElsewhere || awaitingAuthorization.has(connector.id)) {
      void refreshConnector(connector.id, true);
    }
  }
  recoveryReads.clear();
  set({
    recoveryPending: false,
    refreshing: false,
    ...(state.contractPhase === "loading" ? { contractPhase: "error" } : {}),
  });
}

/** Release the admission guard at the deadline, but keep the read alive.
 * Passive returns coalesce onto that read until it settles. Explicit Retry
 * and lifecycle changes abort it; a newer catalog refresh only revision-fences
 * its result, so no deadline can discard healthy data.
 */
function guardedRecoveryRead(read: (signal: AbortSignal) => Promise<void>, exposeRetry = false): Promise<void> {
  releaseRecoveryRead();
  const current = fence();
  const controller = new AbortController();
  let finish!: () => void;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const cycle = {
    controller,
    finish,
    timer: setTimeout(() => {
      if (recoveryRead !== cycle || !current() || signedOut) return;
      finish();
      set({
        recoveryPending: false,
        refreshing: false,
        ...(state.data
          ? { contract: null, contractPhase: "error" }
          : auth.kind === "cloudflare-access"
            ? {
                session: "gated",
                gate: failure("Cloudflare Access identity is unavailable. Retry to check your session."),
              }
            : { session: "ready", gate: null, loadFailure: "network" }),
      });
      scheduleRecovery();
    }, RECOVERY_READ_TIMEOUT_MS),
  };
  recoveryRead = cycle;
  recoveryReads.add(cycle);
  set({ recoveryPending: exposeRetry });
  const work = read(controller.signal).finally(() => {
    recoveryReads.delete(cycle);
    if (recoveryRead !== cycle) return;
    recoveryRead = undefined;
    clearTimeout(cycle.timer);
    set({ recoveryPending: false });
  });
  return Promise.race([work, released]);
}

function resetRecovery(cancelRead = true): void {
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
  recoveryAttempt = 0;
  recoveryNotBefore = 0;
  if (cancelRead) cancelRecoveryRead();
  else releaseRecoveryRead();
  lastReturnPass = -Infinity;
}

/** All passive admission reads share the deadline, budget and in-flight read. */
function recover(): void {
  const now = Date.now();
  if (signedOut || recoveryRead || now < recoveryNotBefore || now - lastReturnPass < RETURN_MIN_INTERVAL_MS) return;
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
  lastReturnPass = now;
  void loadCurrent(true);
}

function scheduleRecovery(): void {
  if (signedOut) return;
  if (recoveryTimer !== undefined) return;
  // Refusals keep the attempt count. Even after the automatic budget is spent,
  // focus must wait through the final backoff before requesting admission.
  const delay = RECOVERY_DELAYS_MS[Math.min(recoveryAttempt, RECOVERY_DELAYS_MS.length - 1)]!;
  recoveryNotBefore = Math.max(Date.now() + delay, lastReturnPass + RETURN_MIN_INTERVAL_MS);
  if (recoveryAttempt >= RECOVERY_DELAYS_MS.length) return;
  recoveryAttempt++;
  const current = fence();
  recoveryTimer = setTimeout(() => {
    recoveryTimer = undefined;
    if (current() && !signedOut) recover();
  }, recoveryNotBefore - Date.now());
}

function recheckAuthorization(): void {
  if (signedOut || recoveryRead) return;
  // Focus is also a way out of a refusal. It only re-requests admission.
  if (
    recoveryAttempt > 0 ||
    state.session !== "ready" ||
    !state.data ||
    state.loadFailure ||
    state.contractPhase === "error"
  ) {
    recover();
    return;
  }
  const now = Date.now();
  if (now - lastReturnPass < RETURN_MIN_INTERVAL_MS) return;
  lastReturnPass = now;
  if (awaitingAuthorization.size > 0) {
    if (!state.oauthBusy) for (const id of awaitingAuthorization.keys()) void pollOAuthConnector(id);
    return;
  }
  const retry =
    Object.keys(state.connectorFailures).length > 0 ||
    state.data.connectors.some(
      (connector) =>
        connector.status === "error" ||
        connector.credential?.problem === "credential_unreadable" ||
        (connector.status === "auth_required" && (connector.oauth || connector.authorizationUrl)) ||
        awaitingAuthorization.has(connector.id),
    );
  if (retry && !state.oauthBusy) void guardedRecoveryRead((signal) => refreshSnapshot(true, undefined, signal));
}

export async function boot(): Promise<void> {
  const onPop = () => {
    if (!routerNavigate) routeChanged(window.location.pathname);
  };
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
        resetRecovery();
        gate(null);
        if (next) signedOut = false;
        if (!signedOut) void loadCurrent();
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

async function readConnector(
  id: string,
  token: string | null | undefined,
  revision: number,
  pollSignal?: AbortSignal,
): Promise<DetailOutcome> {
  try {
    return await queryClient.fetchQuery({
      queryKey: ["connector", state.generation, id, revision],
      queryFn: ({ signal }) => fetchConnector(id, token, pollSignal ? AbortSignal.any([signal, pollSignal]) : signal),
    });
  } catch (error) {
    return { kind: "local", failure: isCancelledError(error) ? "session" : "network" };
  }
}

async function fetchConnector(
  id: string,
  token: string | null | undefined,
  signal: AbortSignal,
): Promise<DetailOutcome> {
  let response: Response;
  try {
    response = await fetch(`/ui/connectors/${encodeURIComponent(id)}`, {
      signal,
      headers: requestHeaders(token),
      credentials: "same-origin",
    });
  } catch {
    return { kind: "local", failure: "network" };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "local", failure: "session" };
  }
  if (response.status === 503) {
    try {
      const payload = (await response.json()) as { problem?: unknown };
      if (payload.problem === "identity_unavailable") return { kind: "local", failure: "unavailable" };
    } catch {
      /* The status still refuses this read. */
    }
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

/** Build one atomic patch for all connector auth controls and catalog facts. */
function detailsPatch(
  outcomes: Map<string, DetailOutcome>,
  quiet: boolean,
  contract: OperatorUiContract | null,
): Partial<OperatorState> {
  if (!state.data) return {};
  let connectorFailures = state.connectorFailures;
  const patch: Partial<OperatorState> = {};
  const connectors = state.data.connectors
    .filter((c) => !contract || contract.config.connectors.some((v) => v.id === c.id))
    .map((c) => {
      const outcome = outcomes.get(c.id);
      if (!outcome) return c;
      if (outcome && !(quiet && outcome.kind !== "detail"))
        connectorFailures =
          outcome.kind === "local"
            ? { ...connectorFailures, [c.id]: outcome.failure }
            : withoutKey(connectorFailures, c.id);
      if (outcome && outcome.kind !== "detail" && !quiet) {
        const live = contract?.live.connectors.find((v) => v.id === c.id);
        if (live) {
          live.status = "error";
          live.problem = "connector_unavailable";
          live.tools = [];
        }
        const { problem: _problem, ...rest } = c;
        return outcome.kind === "downstream"
          ? { ...rest, status: "error" as const, problem: "connector_unavailable" as const }
          : { ...rest, status: "error" as const };
      }
      const live = contract?.live.connectors.find((v) => v.id === c.id);
      let detail = outcome?.kind === "detail" ? outcome.detail : c;
      if (live) {
        const { problem: _problem, registrationPath: _path, ...rest } = detail;
        detail = {
          ...rest,
          status: live.status,
          ...(live.problem ? { problem: live.problem } : {}),
          ...(live.auth ? { registrationPath: live.auth.registrationPath } : {}),
          tools: live.tools.map((t) => ({
            name: t.name,
            address: t.address,
            ...(t.description ? { description: t.description } : {}),
            safety: t.classification === "read" ? "runs_in_programs" : "needs_approval",
          })),
          toolCount: live.tools.length,
        };
      }
      if (detail.status === "ok" && awaitingAuthorization.has(c.id)) {
        stopOAuthPolling(c.id);
        if (state.oauthNoticeFor === c.id) {
          patch.oauthNotice = info("Connected.");
          patch.oauthBlocked = null;
        }
      }
      if (detail.status === "auth_required" && c.authorizationUrl && !detail.authorizationUrl)
        return { ...detail, authorizationUrl: c.authorizationUrl };
      if (detail.status === "ok") {
        const { authorizationUrl: _old, ...rest } = detail;
        return rest;
      }
      return detail;
    });
  return { ...patch, connectorFailures, data: { ...state.data, connectors } };
}

let detailGeneration = 0;
const detailRevisions = new Map<string, number>();
async function loadConnectorDetails(
  data: UiData,
  current: () => boolean,
  token: string | null | undefined,
): Promise<void> {
  const generation = ++detailGeneration;
  let next = 0;
  const worker = async () => {
    while (next < data.connectors.length && current() && generation === detailGeneration && maintainerNow()) {
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
  if (!maintainerNow()) return;
  const current = fence();
  const revision = (detailRevisions.get(id) ?? 0) + 1;
  detailRevisions.set(id, revision);
  if (!quiet && state.data) {
    set({
      data: {
        ...state.data,
        connectors: state.data.connectors.map((connector) =>
          connector.id === id ? { ...connector, status: "loading" } : connector,
        ),
      },
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
  if (!current() || !maintainerNow()) return;
  const outcome = await readConnector(id, token);
  if (!current() || !state.data || detailRevisions.get(id) !== revision) return;
  // A passive read only reports good news: a transient failure on a focus
  // check is not a reason to repaint an auth-needed row as broken.
  if (quiet && outcome.kind !== "detail") return;
  applyDetail(id, outcome);
}

/* Access tokens ----------------------------------------------------------- */

/** One declared agent's token slot, as /ui/access-tokens returns it. */
export type UiAgentSlot = (
  | { name: string; state: "none" }
  | { name: string; state: "issued"; issuedAt: string }
  | { name: string; state: "revoked"; revokedAt: string }
) & { revision?: string };

/**
 * Operator state still holds token rows (#834 replaces it). Each slot rides in
 * one: `id` and `name` are the agent name, `createdAt` is when its token was
 * issued, empty when none was, and `revokedAt` marks a revoked slot. The
 * prefix is never shown and stays empty.
 */
function slotRow(slot: UiAgentSlot): UiAccessToken {
  return {
    id: slot.name,
    name: slot.name,
    tokenPrefix: "",
    createdAt: slot.state === "issued" ? slot.issuedAt : "",
    ...(slot.state === "revoked" ? { revokedAt: slot.revokedAt } : {}),
    ...(slot.revision ? { revision: slot.revision } : {}),
  };
}

/** The body naming the slot revision this agent's row was read at, which every token mutation requires. */
function expectedSlot(name: string): { expect?: string } {
  const revision = state.tokens.find((token) => token.id === name)?.revision;
  return revision ? { expect: revision } : {};
}

/** The slot state one token row encodes. */
export function slotState(row: UiAccessToken): UiAgentSlot["state"] {
  return row.revokedAt ? "revoked" : row.createdAt ? "issued" : "none";
}

let tokenRevision = 0;
export async function loadAccessTokens(): Promise<void> {
  if (!maintainerNow()) return;
  const identityCurrent = fence();
  const revision = ++tokenRevision;
  const current = () => identityCurrent() && revision === tokenRevision;
  const existing = new Map(state.tokens.map((token) => [token.id, token]));
  set({ tokenPhase: "loading", tokenNotice: null });
  try {
    const payload = await operatorRequest("/ui/access-tokens", "GET", current);
    if (!current()) return;
    if (!Array.isArray(payload?.agents)) throw new Error("The agent token slots were not returned.");
    const tokens = payload.agents.map(slotRow);
    // Issue and revoke replace row objects. Prefer rows changed locally since
    // this read began over its possibly older snapshot.
    const changed = new Map(
      state.tokens.filter((token) => existing.get(token.id) !== token).map((token) => [token.id, token]),
    );
    set({ tokenPhase: "ready", tokens: tokens.map((token) => changed.get(token.id) ?? token) });
  } catch {
    if (!current()) return;
    set({
      tokenPhase: "error",
      tokenNotice: failure("Access tokens could not be loaded."),
    });
  }
}

function tokenFailure(tokenNotice: Notice): Partial<OperatorState> {
  return { tokenBusy: false, tokenNotice, pendingFocus: "tokenNotice" };
}

/** The rows with this slot's replaced, or appended when a read has not listed it yet. */
function replaceRow(slot: UiAgentSlot): UiAccessToken[] {
  const row = slotRow(slot);
  return state.tokens.some((token) => token.id === slot.name)
    ? state.tokens.map((token) => (token.id === slot.name ? row : token))
    : [...state.tokens, row];
}

/** Issue the agent's first token or rotate it; the previous secret stops at once. */
export function rotateAgentToken(name: string): Promise<void> {
  if (state.tokenBusy || !maintainerNow()) return Promise.resolve();
  const row = state.tokens.find((token) => token.id === name);
  if (
    row &&
    slotState(row) === "issued" &&
    !window.confirm(`Rotate ${name}'s token? Its current token stops working immediately.`)
  ) {
    return Promise.resolve();
  }
  return mutate({
    request: (current) =>
      operatorRequest(`/ui/access-tokens/${encodeURIComponent(name)}`, "POST", current, expectedSlot(name)),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => {
      const slot = payload?.agent;
      if (!payload?.token || slot?.name !== name) throw new Error("The issued token was not returned.");
      const reveal = state.page === "tokens";
      return {
        tokenBusy: false,
        tokenPhase: "ready",
        tokens: replaceRow(slot),
        createdToken: reveal ? payload.token : null,
        tokenNotice: info(`Token issued for ${name}.`),
        pendingFocus: reveal ? "tokenRevealHeading" : null,
      };
    },
    failed: () => tokenFailure(failure(`A token could not be issued for ${name}. Reload and try again.`)),
  });
}

export function dismissCreatedToken(): void {
  set({ createdToken: null });
}

export function revokeAgentToken(name: string): Promise<void> {
  if (!maintainerNow()) return Promise.resolve();
  if (!window.confirm(`Revoke ${name}'s token? The agent will immediately lose access.`)) return Promise.resolve();
  return mutate({
    request: (current) =>
      operatorRequest(`/ui/access-tokens/${encodeURIComponent(name)}`, "DELETE", current, expectedSlot(name)),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => {
      const slot = payload?.agent;
      if (slot?.name !== name) throw new Error("The revoked slot was not returned.");
      return {
        tokenBusy: false,
        tokens: replaceRow(slot),
        tokenNotice: info(`${name}'s token revoked.`),
        pendingFocus: "tokenNotice",
      };
    },
    failed: () => tokenFailure(failure(`${name}'s token could not be revoked.`)),
  });
}
