import type { UiData } from "../model.js";
import {
  failure,
  info,
  initialState,
  pageForPath,
  resetIdentity,
  withPage,
  type Notice,
  type OperatorPage,
  type OperatorState,
  type UiAccessToken,
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
  message?: string;
  error?: string;
  token?: string;
  accessToken?: UiAccessToken;
  accessTokens?: UiAccessToken[];
  events?: UiActivityEvent[];
  nextCursor?: string;
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
    throw new Error(payload.error || `Request failed (${res.status}).`);
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
  set({ data, session: "ready", gate: null, refreshing: false });
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
  failed: (notice: Notice) => Partial<OperatorState>;
  fallback: string;
  reload?: boolean;
}): Promise<void> {
  const current = fence();
  set(options.busy);
  try {
    const payload = await options.request(current);
    if (!current()) return;
    if (options.reload) await loadData();
    if (!current()) return;
    set(options.done(payload));
  } catch (error) {
    if (!current()) return;
    if (options.reload) {
      try {
        await loadData();
      } catch {
        // The mutation error is the actionable one; loadData owns its gate.
      }
      if (!current()) return;
    }
    set(options.failed(failure(message(error, options.fallback))));
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
  void loadData().then(() => {
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
      oauthBusy: null,
      pendingFocus: "oauthNotice",
      oauthNotice: info(
        disconnecting
          ? "OAuth disconnected. Restart authorization when you are ready to reconnect."
          : payload?.message ||
            "Authorization restarted. Open the authorization link to reconnect.",
      ),
    }),
    failed: (notice) => ({
      oauthBusy: null,
      oauthNotice: notice,
      pendingFocus: "oauthNotice",
    }),
    fallback: "OAuth action failed.",
    reload: true,
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
    failed: land,
    fallback: "Credential action failed.",
    reload,
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
    (payload) => {
      const copy =
        payload?.message ||
        (payload?.ok ? "Credential is valid." : "Credential test failed.");
      return payload?.ok ? info(copy) : failure(copy);
    },
    false,
  );
}

/* Access tokens ----------------------------------------------------------- */

export async function loadAccessTokens(): Promise<void> {
  const current = fence();
  set({ tokenPhase: "loading", tokenNotice: null });
  try {
    const payload = await operatorRequest("/ui/access-tokens", "GET", current);
    if (!current()) return;
    set({ tokenPhase: "ready", tokens: payload?.accessTokens ?? [] });
  } catch (error) {
    if (!current()) return;
    set({
      tokenPhase: "error",
      tokenNotice: failure(
        message(error, "Access tokens could not be loaded."),
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
        createdToken: payload.token,
        tokenNotice: info("Access token created."),
        pendingFocus: "tokenRevealHeading",
      };
    },
    failed: tokenFailure,
    fallback: "Access token could not be created.",
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
    failed: tokenFailure,
    fallback,
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
  window.addEventListener("pagehide", dismissCreatedToken);
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
        void loadData();
      });
    } catch (error) {
      const why = message(error, "unknown error");
      return gate(failure(`Clerk could not initialize: ${why}`));
    }
  }
  await loadData();
}
