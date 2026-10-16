import type { OperatorUiContract } from "../contract.js";
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

function gate(notice: Notice | null = null): void {
  cancelRecoveryRead();
  queryClient.clear();
  forgetNav();
  stopOAuthPolling();
  clearTimeout(returnTimer);
  returnTimer = undefined;
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
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

/** Fetch `/ui/data`. The only route that decides gated versus signed in. */
async function loadData(signal: AbortSignal): Promise<void> {
  if (signedOut) return;
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
  if (res.status === 401 || res.status === 403) {
    if (auth.kind === "clerk") {
      gate(
        failure(
          res.status === 403
            ? `This Clerk account can't open ${productName}'s operator pages.`
            : "Your Clerk session wasn't accepted. Sign out, then sign in again.",
        ),
      );
      return scheduleRecovery();
    }
    if (auth.kind === "cloudflare-access") {
      gate(failure("Cloudflare Access did not accept this identity for operator pages. Retry to check again."));
      return scheduleRecovery();
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

/** Catalog and auth controls publish together, guarded by one refresh revision. */
let snapshotRevision = 0;
export function loadOperatorContract(): Promise<void> {
  return guardedRecoveryRead((signal) => refreshSnapshot(false, undefined, signal), true);
}

async function refreshSnapshot(quiet = false, connectorId?: string, pollSignal?: AbortSignal): Promise<void> {
  if (signedOut) return;
  // A scoped OAuth cycle supersedes general publication without cancelling
  // the older transport or letting its deadline overwrite the newer state.
  if (recoveryRead && recoveryRead.controller.signal !== pollSignal) releaseRecoveryRead();
  // A new catalog cycle also supersedes any summary that has not landed yet.
  ++dataRevision;
  const identityCurrent = fence();
  const revision = ++snapshotRevision;
  const current = () => identityCurrent() && revision === snapshotRevision && !pollSignal?.aborted;
  const data = state.data;
  if (!data) return;
  if (!quiet) set({ contractPhase: "loading" });
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (!current()) return;
    gate(failure("Your sign-in session couldn't be read. Retry to check again."));
    if (!connectorId) scheduleRecovery();
    return;
  }
  if (!current()) return;
  const outcomes = new Map<string, DetailOutcome>();
  let loadedContract: OperatorUiContract | null | undefined;
  const publish = () => {
    if (!current() || loadedContract === undefined) return;
    if (connectorId && loadedContract && !outcomes.has(connectorId)) return;
    // Publish each completed connector with its matching catalog facts. A slow
    // provider leaves other rows usable; pending rows retain their last pair.
    const refreshed =
      loadedContract && connectorId ? mergeConnectorContract(loadedContract, connectorId) : loadedContract;
    const contract = refreshed
      ? {
          ...refreshed,
          live: {
            ...refreshed.live,
            connectors: refreshed.live.connectors.map((live) =>
              outcomes.has(live.id)
                ? live
                : (state.contract?.live.connectors.find((previous) => previous.id === live.id) ?? live),
            ),
          },
        }
      : null;
    set({
      ...detailsPatch(outcomes, quiet && !connectorId, contract),
      contract,
      contractPhase: contract ? "ready" : "error",
    });
    if (connectorId) {
      const outcome = outcomes.get(connectorId);
      if (
        !contract ||
        outcome?.kind !== "detail" ||
        outcome.detail.status === "error" ||
        contract.live.connectors.find((row) => row.id === connectorId)?.status === "error"
      )
        stopOAuthPolling(connectorId);
    }
  };
  const connectors = data.connectors.filter((connector) => !connectorId || connector.id === connectorId);
  let next = 0;
  const worker = async () => {
    while (next < connectors.length && current()) {
      const connector = connectors[next++]!;
      const outcome = await readConnector(connector.id, token, revision, pollSignal);
      if (current()) {
        outcomes.set(connector.id, outcome);
        publish();
      }
    }
  };
  const contractRead = queryClient
    .fetchQuery({
      queryKey: ["operator-config", state.generation, revision],
      queryFn: async ({ signal }) => {
        const response = await fetch(
          connectorId ? `/ui/api/config?connector=${encodeURIComponent(connectorId)}` : "/ui/api/config",
          {
            headers: requestHeaders(token),
            credentials: "same-origin",
            signal: pollSignal ? AbortSignal.any([signal, pollSignal]) : signal,
          },
        );
        if (response.status === 401 || response.status === 403) throw new RequestFailure("session");
        if (!response.ok) throw new RequestFailure("refused");
        const value = (await response.json()) as OperatorUiContract;
        if (value.schemaVersion !== 1 || !value.config || !value.you || !Array.isArray(value.live?.connectors))
          throw new RequestFailure("refused");
        return value;
      },
    })
    .then(
      (contract) => ({ contract, error: undefined }),
      (error: unknown) => ({ contract: undefined, error }),
    )
    .then((result) => {
      if (!current()) return;
      if (result.error instanceof RequestFailure && result.error.kind === "session") {
        gate(failure("Your session cannot read this configuration. Retry to check again."));
        if (!connectorId) scheduleRecovery();
      } else {
        loadedContract = result.contract ?? null;
        publish();
      }
    });
  await Promise.all([contractRead, ...Array.from({ length: Math.min(4, connectors.length) }, worker)]);
  if (!current()) return;
  // OAuth recovery has its own cap and cancellation. Never turn a failed poll
  // into a deployment-wide retry through the general recovery backoff.
  if (connectorId) return;
  const needsRecovery =
    !loadedContract ||
    Object.keys(state.connectorFailures).length > 0 ||
    [...outcomes.values()].some(
      (outcome) => outcome.kind !== "detail" || outcome.detail.credential?.problem === "credential_unreadable",
    );
  if (needsRecovery) scheduleRecovery();
  else resetRecovery(false);
}

/** A scoped poll replaces one live row; all unrelated contract facts stay put. */
function mergeConnectorContract(next: OperatorUiContract, id: string): OperatorUiContract | null {
  const previous = state.contract;
  const live = next.live.connectors.find((connector) => connector.id === id);
  if (!previous || !live) return null;
  return {
    ...previous,
    live: {
      ...previous.live,
      connectors: previous.live.connectors.map((connector) => (connector.id === id ? live : connector)),
    },
  };
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
    if (current() && state.session === "ready") set({ pendingFocus: `${state.page}Heading` });
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
function loadCurrent(exposeRetry = false): Promise<void> {
  return guardedRecoveryRead(loadData, exposeRetry);
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

const RECOVERY_DELAYS_MS = [2000, 2000, 4000, 8000];
let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
let recoveryAttempt = 0;
let recoveryNotBefore = 0;
const RECOVERY_READ_TIMEOUT_MS = 15_000;
interface RecoveryRead {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  finish: () => void;
}
let recoveryRead: RecoveryRead | undefined;
// Superseded catalog refreshes are revision-fenced, but still need physical
// cancellation if this identity or view goes away before their transport lands.
const recoveryReads = new Set<RecoveryRead>();

function releaseRecoveryRead(): void {
  if (!recoveryRead) return;
  clearTimeout(recoveryRead.timer);
  recoveryRead.finish();
  recoveryRead = undefined;
  set({ recoveryPending: false });
}

function cancelRecoveryRead(): void {
  if (recoveryReads.size === 0) return;
  recoveryRead = undefined;
  for (const read of recoveryReads) {
    clearTimeout(read.timer);
    read.controller.abort();
    read.finish();
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

/** Refreshes never replay the mutation that caused them. */
export function refreshConnector(id: string, quiet = false): Promise<void> {
  if (!state.data?.connectors.some((connector) => connector.id === id)) return Promise.resolve();
  if (!quiet && state.data)
    set({
      data: {
        ...state.data,
        connectors: state.data.connectors.map((connector) =>
          connector.id === id ? { ...connector, status: "loading" } : connector,
        ),
      },
      connectorFailures: withoutKey(state.connectorFailures, id),
    });
  return guardedRecoveryRead((signal) => refreshSnapshot(quiet, undefined, signal));
}

/* Access tokens ----------------------------------------------------------- */

let tokenRevision = 0;
export async function loadAccessTokens(): Promise<void> {
  const identityCurrent = fence();
  const revision = ++tokenRevision;
  const current = () => identityCurrent() && revision === tokenRevision;
  const existing = new Map(state.tokens.map((token) => [token.id, token]));
  set({ tokenPhase: "loading", tokenNotice: null });
  try {
    const payload = await operatorRequest("/ui/access-tokens", "GET", current);
    if (!current()) return;
    if (!Array.isArray(payload?.accessTokens)) throw new Error("The access token collection was not returned.");
    const tokens = payload.accessTokens;
    // Creation, rename and revoke replace record objects. Prefer records
    // changed locally since this read began over its possibly older snapshot.
    const changed = state.tokens.filter((token) => existing.get(token.id) !== token);
    const changedIds = new Set(changed.map((token) => token.id));
    set({ tokenPhase: "ready", tokens: [...changed, ...tokens.filter((token) => !changedIds.has(token.id))] });
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
    request: (current) => operatorRequest("/ui/access-tokens", "POST", current, { name }),
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
        tokens: [issued, ...state.tokens.filter((token) => token.id !== issued.id)],
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
    request: (current) => operatorRequest(`/ui/access-tokens/${encodeURIComponent(id)}`, method, current, body),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => ({
      tokenBusy: false,
      tokenRenaming: null,
      tokenNotice: info(success),
      pendingFocus: "tokenNotice",
      ...(payload?.accessToken
        ? {
            tokens: state.tokens.map((token) => (token.id === id ? payload.accessToken! : token)),
          }
        : {}),
    }),
    failed: () => tokenFailure(failure(fallback)),
  });
}

export function saveAccessTokenName(id: string, name: string): Promise<void> {
  return accessTokenMutation(id, "PUT", { name }, "Access token renamed.", "Access token could not be renamed.");
}

export function revokeAccessToken(id: string): Promise<void> {
  const named = state.tokens.find((token) => token.id === id);
  const confirmed = window.confirm(
    `Revoke ${named?.name || "this access token"}? Its MCP client will immediately lose access.`,
  );
  if (!confirmed) return Promise.resolve();
  return accessTokenMutation(id, "DELETE", undefined, "Access token revoked.", "Access token could not be revoked.");
}
