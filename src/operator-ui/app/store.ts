import type {
  UiArtifactRow,
  UiArtifactView,
  UiConnector,
  UiData,
} from "../model.js";
import {
  artifactViewRequest,
  credentialTestNotice,
  failure,
  info,
  initialState,
  oauthDoneNotice,
  pageForPath,
  refusedNotice,
  resetIdentity,
  withPage,
  type Notice,
  type OperatorPage,
  type OperatorState,
  type UiActivityEvent,
} from "../view.js";
import { auth, initialPage, TOKEN_KEY } from "./config.js";

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

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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

function gate(notice: Notice | null = null): void {
  state = resetIdentity(state, notice);
  for (const listener of listeners) listener();
}

interface OperatorResponse {
  ok?: boolean;
  state?: string;
  error?: string;
  problem?: string;
  authorizationUrl?: string;
  events?: UiActivityEvent[];
  nextCursor?: string;
}

/**
 * A route's non-2xx answer, as opposed to a failure this page describes
 * itself. Its message is the route's `error` text, which the credential form's
 * notices still show; the notices for actions that reach a downstream never
 * do, and read only `problem`.
 */
class Refusal extends Error {
  readonly problem: unknown;
  constructor(message: string, problem: unknown) {
    super(message);
    this.problem = problem;
  }
}

async function operatorRequest(
  path: string,
  method: "DELETE" | "GET" | "POST" | "PUT",
  current: () => boolean,
  body?: object,
): Promise<OperatorResponse | null> {
  const token = await sessionToken();
  if (!current()) throw new Error("The operator session changed.");
  if (!token && auth.kind !== "cloudflare-access") {
    throw new Error("Your operator session has expired.");
  }
  const res = await fetch(path, {
    method,
    headers: requestHeaders(token, Boolean(body)),
    credentials: "same-origin",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return null;
  let payload: OperatorResponse = {};
  try {
    payload = (await res.json()) as OperatorResponse;
  } catch {
    // The status code below still owns the operator-facing error.
  }
  if (res.status === 401) {
    throw new Error("Your operator session was not accepted. Sign in again.");
  }
  if (res.status === 403) {
    throw new Error("This identity may not perform that action.");
  }
  if (!res.ok) {
    throw new Refusal(payload.error || `Request failed (${res.status}).`, payload.problem);
  }
  return payload;
}

/** Fetch `/ui/data`. The only route that decides gated versus signed in. */
async function loadData(): Promise<void> {
  const current = fence();
  if (state.session === "ready") set({ refreshing: true });
  let token;
  try {
    token = await sessionToken();
  } catch (error) {
    if (!current()) return;
    const why = message(error, "unknown error");
    return gate(failure(`Could not read the Clerk session: ${why}`));
  }
  if (!current()) return;
  if (!token && auth.kind !== "cloudflare-access") return gate(null);
  let res: Response;
  try {
    res = await fetch("/ui/data", {
      headers: requestHeaders(token),
      credentials: "same-origin",
    });
  } catch (error) {
    if (!current()) return;
    return gate(failure(`Network error: ${message(error, "unknown error")}`));
  }
  if (!current()) return;
  if (res.status === 401 || res.status === 403) {
    if (auth.kind === "clerk") {
      return gate(
        failure(
          res.status === 403
            ? "This Clerk account is not allowed to access connecta."
            : "Your Clerk session was not accepted. Sign out and try again.",
        ),
      );
    }
    if (auth.kind === "cloudflare-access") {
      return gate(
        failure(
          "Cloudflare Access admitted the request, but this identity is not an eligible operator.",
        ),
      );
    }
    localStorage.removeItem(TOKEN_KEY);
    return gate(failure("Token rejected — enter a valid bearer token."));
  }
  if (!res.ok) return gate(failure(`Error ${res.status}`));
  let data: UiData;
  try {
    data = (await res.json()) as UiData;
  } catch {
    if (!current()) return;
    return gate(failure("Operator data could not be read."));
  }
  if (!current()) return;
  if (!Array.isArray(data.connectors)) return gate(failure("Connection list could not be read."));
  set({ data, session: "ready", gate: null, refreshing: false });
  void loadConnectorDetails(data, current, token);
}

/**
 * Every mutation in the same shape: mark the control busy, send exactly one
 * request, then land on a notice — success or failure, never neither. `reload`
 * refreshes `/ui/data` before landing, including after a failure, because a
 * partially applied reset must not leave stale tools and actions on screen.
 */
async function mutate(options: {
  request: (current: () => boolean) => Promise<OperatorResponse | null>;
  busy: Partial<OperatorState>;
  done: (payload: OperatorResponse | null) => Partial<OperatorState>;
  failed: (notice: Notice, error: unknown) => Partial<OperatorState>;
  fallback: string;
  reload?: string | undefined;
}): Promise<void> {
  const current = fence();
  if (options.reload) detailRevisions.set(options.reload, (detailRevisions.get(options.reload) ?? 0) + 1);
  set(options.busy);
  try {
    const payload = await options.request(current);
    if (!current()) return;
    if (!current()) return;
    set(options.done(payload));
    if (options.reload) void refreshConnector(options.reload);
  } catch (error) {
    if (!current()) return;
    set(options.failed(failure(message(error, options.fallback)), error));

  }
}

export function focusHandled(): void {
  if (state.pendingFocus !== null) set({ pendingFocus: null });
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

export function navigate(page: OperatorPage, href: string): void {
  history.pushState({ operatorPage: page }, "", href);
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

/* Downstream OAuth -------------------------------------------------------- */

export function oauthAction(
  connector: string,
  action: "disconnect" | "reconnect",
): Promise<void> {
  const disconnecting = action === "disconnect";
  const kind = disconnecting ? "oauth_disconnect" : "oauth_reconnect";
  const confirmed = window.confirm(
    disconnecting
      ? `Disconnect OAuth for ${connector}? Stored credentials and any pending authorization will be removed.`
      : `Restart OAuth for ${connector}? Stored credentials and any pending authorization will be replaced.`,
  );
  if (!confirmed) return Promise.resolve();
  return mutate({
    request: (current) =>
      operatorRequest(
        `/ui/oauth/${encodeURIComponent(connector)}`,
        disconnecting ? "DELETE" : "POST",
        current,
      ),
    busy: { oauthNotice: null, oauthBusy: connector },
    done: (payload) => ({
      ...(state.data ? { data: { ...state.data, connectors: state.data.connectors.map(c => {
        if (c.id !== connector) return c;
        const { authorizationUrl: _old, ...rest } = c;
        return { ...rest, status: "auth_required" as const, tools: [], toolCount: 0, ...(!disconnecting && payload?.authorizationUrl ? { authorizationUrl: payload.authorizationUrl } : {}) };
      }) } } : {}),
      oauthBusy: null,
      pendingFocus: "oauthNotice",
      oauthNotice: oauthDoneNotice(kind, payload),
    }),
    // The route's words never reach this notice (see `refusedNotice`); a
    // failure the page described itself — a lapsed session, a denied
    // identity, a dropped connection — keeps its own.
    failed: (notice, error) => ({
      oauthBusy: null,
      oauthNotice:
        error instanceof Refusal
          ? refusedNotice(kind, connector, error.problem)
          : { ...notice, fix: { kind: "oauth_action_failed", connectorId: connector } },
      pendingFocus: "oauthNotice",
    }),
    fallback: "OAuth action failed.",
    reload: connector,
  });
}

/* Credentials ------------------------------------------------------------- */

export function editCredential(connector: string | null): void {
  set({ credentialEditing: connector, credentialNotice: null });
}

/** A form the operator has not finished. Nothing is sent, and the page says why. */
export function refuseCredential(copy: string): void {
  set({ credentialNotice: failure(copy), pendingFocus: "credentialNotice" });
}

function credentialMutation(
  connector: string,
  request: (current: () => boolean) => Promise<OperatorResponse | null>,
  done: (payload: OperatorResponse | null) => Notice,
  reload = true,
  failed: (notice: Notice, error: unknown) => Notice = (notice) => notice,
): Promise<void> {
  const land = (credentialNotice: Notice) => ({
    credentialBusy: null,
    credentialNotice,
    pendingFocus: "credentialNotice",
  });
  return mutate({
    request,
    busy: { credentialBusy: connector, credentialNotice: null },
    done: (payload) => land(done(payload)),
    failed: (notice, error) => land(failed(notice, error)),
    fallback: "Credential action failed.",
    reload: reload ? connector : undefined,
  });
}

export function saveCredential(
  connector: string,
  body: { value: string } | { values: Record<string, string> },
): Promise<void> {
  return credentialMutation(
    connector,
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}`,
        "PUT",
        current,
        body,
      ),
    () => {
      set({ credentialEditing: null });
      return info("Credential saved.");
    },
  );
}

export function removeCredential(connector: string): Promise<void> {
  const confirmed = window.confirm(
    "Remove this credential? The connector will stop authenticating until a replacement is added.",
  );
  if (!confirmed) return Promise.resolve();
  return credentialMutation(
    connector,
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}`,
        "DELETE",
        current,
      ),
    () => info("Credential removed."),
  );
}

export function testCredential(connector: string): Promise<void> {
  return credentialMutation(
    connector,
    (current) =>
      operatorRequest(
        `/ui/credentials/${encodeURIComponent(connector)}/test`,
        "POST",
        current,
      ),
    (payload) => credentialTestNotice(connector, payload),
    false,
    // As for OAuth: the route's words never, the page's own always.
    (notice, error) =>
      error instanceof Refusal
        ? refusedNotice("credential_test", connector, error.problem)
        : { ...notice, fix: { kind: "credential_test_failed", connectorId: connector } },
  );
}

/* Activity ---------------------------------------------------------------- */

export async function loadActivity(reset: boolean): Promise<void> {
  if (!state.data?.activityEnabled) return;
  const current = fence();
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
      activityNotice: failure(message(error, "Activity could not be loaded.")),
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
): Promise<Response | undefined> {
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (current()) gate(failure("Could not read the sign-in session."));
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
    if (current()) gate(failure("Network error: the artifact could not be reached."));
    return undefined;
  }
  if (!current()) return undefined;
  if (res.status === 401) {
    if (auth.kind !== "clerk" && auth.kind !== "cloudflare-access") {
      localStorage.removeItem(TOKEN_KEY);
      gate(failure("Token rejected — enter a valid bearer token."));
    } else {
      gate(failure("Your session was not accepted. Sign out and try again."));
    }
    return undefined;
  }
  if (res.status === 403) {
    gate(failure("This deployment does not open artifact pages to this identity."));
    return undefined;
  }
  return res;
}

export async function loadArtifacts(reset: boolean): Promise<void> {
  const current = fence();
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
  const res = await artifactRead(`/artifacts/_api/list${query ? `?${query}` : ""}`, current);
  if (!res || !current()) return;
  if (!res.ok) {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure(
        res.status === 404
          ? "Artifacts are not available to this identity."
          : "Artifacts could not be loaded.",
      ),
    });
  }
  let payload: { artifacts?: UiArtifactRow[]; nextCursor?: string };
  try {
    payload = (await res.json()) as typeof payload;
  } catch {
    payload = {};
  }
  if (!current()) return;
  set({
    session: "ready",
    gate: null,
    artifactPhase: "ready",
    artifactRows: [...(reset ? [] : state.artifactRows), ...(payload.artifacts ?? [])],
    artifactCursor: payload.nextCursor ?? null,
  });
}

export async function loadArtifactView(): Promise<void> {
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
  const res = await artifactRead(request, current);
  if (!res || !current()) return;
  if (!res.ok) {
    return set({
      session: "ready",
      gate: null,
      artifactPhase: "error",
      artifactNotice: failure(
        res.status === 404
          ? "There is no artifact here, or this identity cannot open it."
          : "The artifact could not be loaded.",
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
      artifactNotice: failure("The artifact could not be read."),
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

export async function boot(): Promise<void> {
  const onPop = () => setPage(pageForPath(window.location.pathname), true);
  window.addEventListener("popstate", onPop);
  // A document restored from the back-forward cache must not restore a secret.
  if (auth.kind === "clerk") {
    const clerk = window.Clerk;
    if (!clerk) {
      const why = "Clerk could not load. Check your network and try again.";
      return gate(failure(why));
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
    } catch (error) {
      const why = message(error, "unknown error");
      return gate(failure(`Clerk could not initialize: ${why}`));
    }
  }
  await loadCurrent();
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
      let detail: UiConnector;
      try {
        const response = await fetch(`/ui/connectors/${encodeURIComponent(connector.id)}`, { headers: requestHeaders(token), credentials: "same-origin" });
        if (!response.ok) throw new Error(`Connection details unavailable (${response.status})`);
        detail = await response.json() as UiConnector;
      } catch { detail = { ...connector, status: "error", problem: "connector_unavailable" }; }
      if (!current() || generation !== detailGeneration || !state.data) return;
      if (detailRevisions.get(connector.id) !== revision) continue;
      set({ data: { ...state.data, connectors: state.data.connectors.map(c => c.id === connector.id ? detail : c) } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, data.connectors.length) }, worker));
}

export async function refreshConnector(id: string): Promise<void> {
  const current = fence();
  const revision = (detailRevisions.get(id) ?? 0) + 1;
  detailRevisions.set(id, revision);
  if (state.data) set({ data: { ...state.data, connectors: state.data.connectors.map(c => c.id === id ? { ...c, status: "loading" } : c) } });
  try {
    const token = await sessionToken();
    if (!current()) return;
    const response = await fetch(`/ui/connectors/${encodeURIComponent(id)}`, { headers: requestHeaders(token), credentials: "same-origin" });
    if (!response.ok) throw new Error(`Connection details unavailable (${response.status})`);
    const detail = await response.json() as UiConnector;
    if (!current() || !state.data || detailRevisions.get(id) !== revision) return;
    set({ data: { ...state.data, connectors: state.data.connectors.map(c => c.id === id ? { ...detail, ...(detail.status === "auth_required" && c.authorizationUrl ? { authorizationUrl: c.authorizationUrl } : {}) } : c) } });
  } catch {
    if (!current() || !state.data || detailRevisions.get(id) !== revision) return;
    set({ data: { ...state.data, connectors: state.data.connectors.map(c => c.id === id ? { ...c, status: "error", problem: "connector_unavailable" } : c) } });
  }
}
