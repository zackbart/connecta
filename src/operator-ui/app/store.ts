import type { OperatorMemberManage, OperatorUiContractV2 } from "../contract.js";
import { queryClient } from "./query.js";
import { isCancelledError } from "@tanstack/react-query";
import type { UiConnector, UiData } from "../model.js";
import {
  actionFailedNotice,
  collectionFailureCopy,
  credentialTestNotice,
  failure,
  STALE_COPY,
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
} from "../view.js";
import { resolveSlot, slotActions, tokenFailureNotice, type AgentSlot, type SlotAction } from "../agents.js";
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
    : Promise.resolve(storedToken());
}

/** Storage that throws (private browsing) reads as no stored token. */
function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Keep or forget the bearer token; storage that throws keeps nothing. */
function storeToken(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, value);
  } catch {
    /* Storage may be unavailable. */
  }
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
  cancelRecoveryRead();
  queryClient.clear();
  connectorPublications.clear();
  forgetNav();
  stopOAuthPolling();
  clearTimeout(returnTimer);
  returnTimer = undefined;
  clearTimeout(recoveryTimer);
  recoveryTimer = undefined;
  forgetSlotFence();
  state = { ...resetIdentity(state, notice), session };
  for (const listener of listeners) listener();
}

/**
 * The session's own refusal, in the words of the sign-in in use. Clerk and
 * Access keep the shared recovery schedule, so a transient refusal clears on
 * its own; a bearer token the deployment refused is forgotten instead, so the
 * gate asks for another.
 */
function refuseSession(status: number): void {
  if (auth.kind === "clerk") {
    gate(
      failure(
        status === 403
          ? `This Clerk account can't open ${productName}'s operator pages.`
          : "Clerk session not accepted. Sign out and sign in again.",
      ),
    );
    return scheduleRecovery();
  }
  if (auth.kind === "cloudflare-access") {
    gate(failure("Cloudflare Access didn't accept this identity. Retry."));
    return scheduleRecovery();
  }
  storeToken(null);
  gate(failure("Token not accepted. Paste a valid operator token."));
}

interface OperatorResponse {
  token?: string;
  agent?: AgentSlot;
  agents?: AgentSlot[];
  ok?: boolean;
  state?: string;
  problem?: string;
  code?: string;
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
  readonly code: unknown;
  constructor(kind: RequestFailureKind, status?: number, problem?: unknown, code?: unknown) {
    super(`Operator request failed: ${kind}`);
    this.kind = kind;
    this.status = status;
    this.problem = problem;
    this.code = code;
  }
}

function factsOf(error: unknown): RequestFailureFacts {
  return error instanceof RequestFailure ? error : { kind: "refused" };
}

/** Routes only a maintainer may call; a member's page never sends them. */
const MAINTAINER_ONLY = ["/ui/data", "/ui/connectors/", "/ui/api/activity", "/ui/access-tokens"];

type ConnectionAction = "connect" | "restart" | "disconnect" | "save" | "test" | "clear";

/**
 * A credential or OAuth write as the contract's `manage` names it: which
 * connector, which kind of management, and which action. Null for any other
 * path.
 */
function connectionWrite(
  path: string,
  method: string,
): { connectorId: string; kind: "oauth" | "credential"; action: ConnectionAction } | null {
  const url = new URL(path, "http://operator.invalid");
  const oauth = /^\/ui\/oauth\/([^/]+)$/.exec(url.pathname);
  if (oauth) {
    const action =
      method === "DELETE" ? "disconnect" : url.searchParams.get("mode") === "continue" ? "connect" : "restart";
    return { connectorId: decodeURIComponent(oauth[1]!), kind: "oauth", action };
  }
  const credential = /^\/ui\/credentials\/([^/]+)(\/test)?$/.exec(url.pathname);
  if (credential) {
    const action = credential[2] ? "test" : method === "DELETE" ? "clear" : "save";
    return { connectorId: decodeURIComponent(credential[1]!), kind: "credential", action };
  }
  return null;
}

/**
 * Whether this viewer may send a credential or OAuth write right now. Only a
 * contract on screen that agrees with the confirmed role decides: a maintainer
 * acts on any connector it shows; a member only on a personal connector their
 * contract lists, with an action its `manage` names.
 */
function connectionWriteAllowed(write: NonNullable<ReturnType<typeof connectionWrite>>): boolean {
  const contract = state.contract;
  if (!contract || state.role !== contract.role) return false;
  if (contract.role === "maintainer") {
    return Boolean(contract.config?.connectors.some((connector) => connector.id === write.connectorId));
  }
  const connector = contract.connectors.find((c) => c.id === write.connectorId);
  if (!connector || connector.authScope !== "personal" || connector.manage.kind !== write.kind) return false;
  return (connector.manage.actions as readonly string[]).includes(write.action);
}

/**
 * The last step before an operator request reaches the network, checked here
 * after every await its caller made, because a contract refresh can fail or
 * change the role while a session token is being read. A maintainer-only
 * route needs a confirmed maintainer; a credential or OAuth write needs a
 * contract that allows it (see `connectionWriteAllowed`). Anything else is
 * withheld (null), and callers treat null as a request that was never sent.
 */
function send(path: string, init: RequestInit): Promise<Response> | null {
  const privileged = MAINTAINER_ONLY.some((route) => path === route || path.startsWith(route));
  if (privileged && !maintainerNow()) return null;
  const write = connectionWrite(path, init.method ?? "GET");
  if (write && !connectionWriteAllowed(write)) return null;
  return fetch(path, init);
}

async function operatorRequest(
  path: string,
  method: "DELETE" | "GET" | "POST" | "PUT",
  current: () => boolean,
  body?: object,
  /**
   * Whether what the action was validated against still holds. Checked here,
   * after the last await and immediately before `fetch`, the way `send()`
   * checks the role: a reload or contract refresh during the session-token
   * read cannot let through an action that is no longer valid.
   */
  stillValid?: () => boolean,
): Promise<OperatorResponse | null> {
  let token;
  try {
    token = await sessionToken();
  } catch {
    throw new RequestFailure("session");
  }
  if (!current()) throw new RequestFailure("session");
  if (!token && auth.kind !== "cloudflare-access") throw new RequestFailure("session");
  if (stillValid && !stillValid()) throw new RequestFailure("stale");
  const sent = send(path, {
    method,
    headers: requestHeaders(token, Boolean(body)),
    credentials: "same-origin",
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Withheld: this viewer is not a confirmed maintainer any more.
  if (!sent) throw new RequestFailure("forbidden");
  let res: Response;
  try {
    res = await sent;
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
  if (!res.ok) throw new RequestFailure("refused", res.status, payload.problem, payload.code);
  return payload;
}

/**
 * A failed Access summary cannot establish an identity. Other auth modes keep
 * their existing signed-in error page. Both can retry the read.
 */
function unreachable(loadFailure: "server" | "network"): void {
  if (auth.kind === "cloudflare-access") {
    gate(failure("Cloudflare Access identity is unavailable. Retry."));
  } else {
    set({ session: "ready", gate: null, refreshing: false, loadFailure });
  }
  scheduleRecovery();
}

let dataRevision = 0;

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

/** One `GET /ui/api/config`, classified. Never throws; an abort reads as network. */
async function fetchContract(
  path: string,
  token: string | null | undefined,
  signal: AbortSignal,
): Promise<ContractOutcome> {
  let response: Response;
  try {
    response = await fetch(path, { headers: requestHeaders(token), credentials: "same-origin", signal });
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
 * Whether a maintainer-only read may go out now: the last confirmed role is
 * maintainer and the contract on screen still says so. Every privileged read
 * checks this when it is sent, not only at boot, so a background refetch
 * never runs for a member or while the role is unknown.
 */
function maintainerNow(): boolean {
  return state.role === "maintainer" && state.contract?.role === "maintainer";
}

/**
 * A role other than the last confirmed one is a different viewer, even when a
 * failed refresh cleared `contract` in between: drop everything read for the
 * old role, cancel its reads, and admit the viewer again from the top.
 * Returns true when it did.
 */
function resetOnRoleChange(contract: OperatorUiContractV2): boolean {
  if (state.role === null || state.role === contract.role) return false;
  resetRecovery();
  gate(null, "loading");
  void loadCurrent();
  return true;
}

/**
 * The contract could not be read for a reason other than the session: no
 * role to render by. Access cannot establish an identity without it and
 * returns to its gate; other modes stay signed in on an error state with no
 * maintainer navigation. Both keep the shared recovery schedule.
 */
function contractUnavailable(outcome: "network" | "refused"): void {
  if (auth.kind === "cloudflare-access") {
    gate(failure("Cloudflare Access identity is unavailable. Retry."));
  } else {
    set({
      session: "ready",
      gate: null,
      refreshing: false,
      contract: null,
      contractPhase: "error",
      loadFailure: outcome === "network" ? "network" : null,
      ...(state.role === "member" ? memberUnavailable() : {}),
    });
  }
  scheduleRecovery();
}

/**
 * A member whose contract could not be confirmed, by failure or by deadline:
 * nothing actionable stays on screen. Open confirmations and forms close, and
 * the member page's own refresh error takes focus at its heading, since the
 * control that had it is gone.
 */
function memberUnavailable(): Partial<OperatorState> {
  return {
    contract: null,
    contractPhase: "error",
    confirming: null,
    credentialEditing: null,
    focusIfLost: "memberHeading",
  };
}

/**
 * The admission read. `GET /ui/api/config` is the one gate, for both roles:
 * 401 is signed out, the private 404 is signed in without access, and 200
 * says who this viewer is. A member's page is ready on that answer alone.
 * Only a confirmed maintainer goes on to `/ui/data` and the connector
 * details, which reuse this contract rather than read it again.
 */
async function loadData(signal: AbortSignal): Promise<void> {
  if (signedOut) return;
  const identityCurrent = fence();
  const revision = ++dataRevision;
  ++snapshotRevision;
  const publication = ++snapshotReadRevision;
  const current = () => identityCurrent() && revision === dataRevision && !signal.aborted;
  // The contract is what this read is waiting on first.
  set({
    ...(state.session === "ready" ? { refreshing: true } : {}),
    loadFailure: null,
    ...(state.contractPhase === "ready" ? {} : { contractPhase: "loading" as const }),
  });
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (!current()) return;
    return gate(failure("Couldn't read your session. Sign in again."));
  }
  if (!current()) return;
  if (!token && auth.kind !== "cloudflare-access") return gate(null);
  const outcome = await fetchContract("/ui/api/config", token, signal);
  if (!current()) return;
  if (outcome.kind === "session") return refuseSession(outcome.status);
  if (outcome.kind === "denied") return gate(null, "denied");
  if (outcome.kind !== "contract") return contractUnavailable(outcome.kind);
  const { contract } = outcome;
  if (resetOnRoleChange(contract)) return;
  if (contract.role === "member") {
    set({
      ...memberRefreshed(contract),
      contract,
      role: "member",
      contractPhase: "ready",
      session: "ready",
      gate: null,
      refreshing: false,
      loadFailure: null,
      ...memberConnected(contract),
    });
    return resetRecovery(false);
  }
  // A maintainer's page waits for `/ui/data` too.
  set({
    ...contractSlotsRefreshed(contract),
    contract: preservePolledRows(contract, publication),
    role: "maintainer",
    contractPhase: "loading",
  });
  // Withheld: the role became unknown or changed; its own state says so.
  const sent = send("/ui/data", { signal, headers: requestHeaders(token), credentials: "same-origin" });
  if (!sent) return;
  let res: Response;
  try {
    res = await sent;
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
    data: {
      ...data,
      connectors: data.connectors.map((row) =>
        (connectorPublications.get(row.id)?.revision ?? 0) > publication
          ? (state.data?.connectors.find((previous) => previous.id === row.id) ?? row)
          : row,
      ),
    },
    session: "ready",
    gate: null,
    refreshing: false,
    loadFailure: null,
  });
  // A passive recovery owns the whole matching catalog/auth cycle. Releasing
  // its in-flight guard at the summary would let focus supersede slow reads.
  await refreshSnapshot(false, undefined, signal, contract, publication);
}

/* Member actions, validated at dispatch ------------------------------------- */

type MemberAction = "connect" | "restart" | "disconnect" | "save" | "test" | "clear";

const MEMBER_ACTION_KIND: Record<MemberAction, OperatorMemberManage["kind"]> = {
  connect: "oauth",
  restart: "oauth",
  disconnect: "oauth",
  save: "credential",
  test: "credential",
  clear: "credential",
};

const CONFIRM_ACTION: Record<PendingConfirm["action"], MemberAction> = {
  oauth_restart: "restart",
  oauth_disconnect: "disconnect",
  credential_remove: "clear",
};

/** Bumped per connector whenever a refreshed member contract changes its `manage`. */
const manageRevisions = new Map<string, number>();

function listsAction(contract: OperatorUiContractV2 | null, connector: string, action: MemberAction): boolean {
  if (contract?.role !== "member") return false;
  const manage = contract.connectors.find((c) => c.id === connector && c.authScope === "personal")?.manage;
  if (!manage || manage.kind === "none" || manage.kind !== MEMBER_ACTION_KIND[action]) return false;
  return (manage.actions as string[]).includes(action);
}

/**
 * A member action's dispatch check. It must be listed now, which also spares
 * an OAuth start its blank tab. At dispatch, `send()` checks again that the
 * current contract lists it; this adds the stricter condition that `manage`
 * has not changed at all since the member chose it. `undefined` for a
 * maintainer, whose writes `send()` alone gates; `null` when the member may
 * not take it right now.
 */
function memberDispatch(connector: string, action: MemberAction): (() => boolean) | null | undefined {
  if (state.role !== "member") return undefined;
  if (!listsAction(state.contract, connector, action)) return null;
  const revision = manageRevisions.get(connector) ?? 0;
  return () => (manageRevisions.get(connector) ?? 0) === revision;
}

/**
 * A refreshed member contract, before it lands: bump the revision of every
 * connector whose `manage` changed, and close any confirmation or form whose
 * action the new contract no longer lists.
 */
function memberRefreshed(contract: OperatorUiContractV2): Partial<OperatorState> {
  const manageOf = (value: OperatorUiContractV2 | null) =>
    new Map((value?.role === "member" ? value.connectors : []).map((c) => [c.id, JSON.stringify(c.manage)]));
  const before = manageOf(state.contract);
  const after = manageOf(contract);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(id) !== after.get(id)) manageRevisions.set(id, (manageRevisions.get(id) ?? 0) + 1);
  }
  const patch: Partial<OperatorState> = {};
  const confirming = state.confirming;
  if (confirming && !listsAction(contract, confirming.connectorId, CONFIRM_ACTION[confirming.action])) {
    patch.confirming = null;
  }
  if (state.credentialEditing && !listsAction(contract, state.credentialEditing, "save")) {
    patch.credentialEditing = null;
  }
  return patch;
}

/** Refused before anything was sent, and said beside the row that asked. */
function memberRefused(connector: string, kind: "oauth" | "credential"): Promise<void> {
  set(
    kind === "oauth"
      ? oauthNoticePatch(connector, failure(STALE_COPY))
      : {
          credentialNotice: failure(STALE_COPY),
          credentialNoticeFor: connector,
          focusIfLost: `credentialNotice-${connector}`,
        },
  );
  return Promise.resolve();
}

/**
 * A member's authorization finished in another tab: their contract now says
 * the connection is ok, and the row that started it says so in its own words.
 */
function memberConnected(contract: OperatorUiContractV2): Partial<OperatorState> {
  const patch: Partial<OperatorState> = {};
  for (const connector of contract.connectors) {
    if (connector.connection?.state !== "ok") continue;
    // Both records go: the poll's, and the one that outlives it.
    const started = memberAuthorizations.delete(connector.id);
    if (!awaitingAuthorization.delete(connector.id) && !started) continue;
    if (state.oauthNoticeFor === connector.id) {
      Object.assign(patch, { oauthNotice: info("Connected."), oauthBlocked: null, oauthBlockedUrl: null });
    }
  }
  return patch;
}

/**
 * Member authorizations this tab started, by start time. The OAuth poll gives
 * up after its window, but consent can take longer, so returning to the tab
 * still re-reads the member's contract until it shows the connection, the
 * member disconnects it, or `MEMBER_AUTHORIZATION_WINDOW_MS` passes.
 */
const memberAuthorizations = new Map<string, number>();
/**
 * When a return last re-read a member's contract for an authorization. Kept
 * apart from `lastReturnPass`, which a successful read resets with the rest
 * of recovery: two returns 200 ms apart would otherwise both read.
 */
let lastAuthorizationReturn = -Infinity;
const MEMBER_AUTHORIZATION_WINDOW_MS = 10 * 60_000;

/** Whether any member authorization is still worth checking on return. */
function memberAuthorizationPending(): boolean {
  const now = Date.now();
  for (const [id, startedAt] of memberAuthorizations) {
    if (now - startedAt > MEMBER_AUTHORIZATION_WINDOW_MS) memberAuthorizations.delete(id);
  }
  return memberAuthorizations.size > 0;
}

/** Catalog and auth controls publish together, guarded by one refresh revision. */
let snapshotRevision = 0;
// Full cycles own admission/recovery. Polls only supersede one connector's
// publication, including a summary or detail that was already in flight.
let snapshotReadRevision = 0;
const connectorPublications = new Map<
  string,
  { revision: number; live: OperatorUiContractV2["live"]["connectors"][number] | undefined }
>();

function preservePolledRows(contract: OperatorUiContractV2, publication: number): OperatorUiContractV2 {
  return {
    ...contract,
    live: {
      ...contract.live,
      connectors: contract.live.connectors.map((row) =>
        (connectorPublications.get(row.id)?.revision ?? 0) > publication
          ? (connectorPublications.get(row.id)?.live ?? row)
          : row,
      ),
    },
  };
}
/**
 * Refresh the catalog and auth controls. A viewer never confirmed as a
 * maintainer, or with no maintainer data yet, has nothing maintainer-only to
 * refresh: admit again from the top instead.
 */
export function loadOperatorContract(): Promise<void> {
  if (state.role !== "maintainer" || !state.data) return loadCurrent(true);
  return guardedRecoveryRead((signal) => refreshSnapshot(false, undefined, signal), true);
}

/**
 * One catalog/auth cycle for a confirmed maintainer: the contract (unless the
 * admission read just supplied it as `preloaded`) and every connector's
 * details, published together. When a failed read left no contract on
 * screen, the role is unknown until this one answers, so the details wait
 * for it instead of running alongside.
 */
async function refreshSnapshot(
  quiet = false,
  connectorId?: string,
  pollSignal?: AbortSignal,
  preloaded?: OperatorUiContractV2,
  publication = ++snapshotReadRevision,
): Promise<void> {
  if (signedOut || state.role !== "maintainer") return;
  if (!connectorId && !preloaded) {
    if (recoveryRead && recoveryRead.controller.signal !== pollSignal) releaseRecoveryRead();
    ++dataRevision;
    ++snapshotRevision;
  }
  const identityCurrent = fence();
  const revision = snapshotRevision;
  const current = () => identityCurrent() && revision === snapshotRevision && !pollSignal?.aborted;
  const data = state.data;
  if (!data) return;
  if (!quiet) set({ contractPhase: "loading" });
  let token;
  try {
    token = await sessionToken();
  } catch {
    if (!current()) return;
    gate(failure("Couldn't read your session. Retry."));
    if (!connectorId) scheduleRecovery();
    return;
  }
  if (!current()) return;
  const outcomes = new Map<string, DetailOutcome>();
  let loadedContract: OperatorUiContractV2 | null | undefined = preloaded;
  const publish = () => {
    if (!current() || loadedContract === undefined) return;
    if (connectorId && loadedContract && !outcomes.has(connectorId)) return;
    // Publish each completed connector with its matching catalog facts. A slow
    // provider leaves other rows usable; pending rows retain their last pair.
    const publishable = new Map(
      [...outcomes].filter(([id]) => (connectorPublications.get(id)?.revision ?? 0) <= publication),
    );
    const refreshed = connectorId
      ? loadedContract
        ? mergeConnectorContract(loadedContract, connectorId)
        : state.contract
      : loadedContract
        ? preservePolledRows(loadedContract, publication)
        : null;
    const contract = refreshed
      ? {
          ...refreshed,
          live: {
            ...refreshed.live,
            connectors: refreshed.live.connectors.map((live) =>
              publishable.has(live.id)
                ? live
                : (state.contract?.live.connectors.find((previous) => previous.id === live.id) ?? live),
            ),
          },
        }
      : null;
    set({
      ...detailsPatch(publishable, quiet && !connectorId, contract),
      contract,
      contractPhase: contract ? "ready" : "error",
    });
    if (connectorId) {
      connectorPublications.set(connectorId, {
        revision: publication,
        live:
          loadedContract?.live.connectors.find((row) => row.id === connectorId) ??
          state.contract?.live.connectors.find((row) => row.id === connectorId),
      });
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
      const outcome = await readConnector(connector.id, token, publication, pollSignal);
      if (current()) {
        outcomes.set(connector.id, outcome);
        publish();
      }
    }
  };
  const contractRead = preloaded
    ? Promise.resolve(publish())
    : queryClient
        .fetchQuery({
          queryKey: ["operator-config", state.generation, publication],
          queryFn: ({ signal }) =>
            fetchContract(
              connectorId ? `/ui/api/config?connector=${encodeURIComponent(connectorId)}` : "/ui/api/config",
              token,
              pollSignal ? AbortSignal.any([signal, pollSignal]) : signal,
            ),
        })
        .catch((): ContractOutcome => ({ kind: "network" }))
        .then((outcome) => {
          if (!current()) return;
          if (outcome.kind === "session") {
            gate(failure("Your session can't read this configuration. Retry."));
            if (!connectorId) scheduleRecovery();
          } else if (outcome.kind === "denied") {
            gate(null, "denied");
          } else if (outcome.kind === "contract" && resetOnRoleChange(outcome.contract)) {
            // A different viewer: everything above was dropped and admission restarted.
          } else {
            // A failed read clears the old snapshot; the role it confirmed stays.
            loadedContract = outcome.kind === "contract" ? outcome.contract : null;
            // A full contract speaks for every agent's slot; a scoped OAuth poll's does not.
            if (loadedContract && !connectorId) set(contractSlotsRefreshed(loadedContract));
            publish();
          }
        });
  if (!preloaded && !state.contract) await contractRead;
  const workers = maintainerNow() ? Array.from({ length: Math.min(4, connectors.length) }, worker) : [];
  await Promise.all([contractRead, ...workers]);
  if (!current()) return;
  // OAuth recovery has its own cap and cancellation. Never turn a failed poll
  // into a deployment-wide retry through the general recovery backoff.
  if (connectorId) return;
  const needsRecovery =
    !loadedContract ||
    Object.keys(state.connectorFailures).length > 0 ||
    [...outcomes].some(
      ([id, outcome]) =>
        (connectorPublications.get(id)?.revision ?? 0) <= publication &&
        (outcome.kind !== "detail" || outcome.detail.credential?.problem === "credential_unreadable"),
    );
  if (needsRecovery) scheduleRecovery();
  else resetRecovery(false);
}

/** A scoped poll replaces one live row; all unrelated contract facts stay put. */
function mergeConnectorContract(next: OperatorUiContractV2, id: string): OperatorUiContractV2 | null {
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
    if (options.reload) reloadConnection(options.reload);
  } catch (error) {
    if (!current()) return options.abandoned?.();
    set(options.failed(factsOf(error)));
    if (options.reload) reloadConnection(options.reload);
  }
}

/**
 * Re-read one connection after an action on it. A maintainer re-reads the
 * connector; a member has no connector route, and re-reads the contract,
 * which carries their own connection state.
 */
function reloadConnection(connector: string): void {
  if (maintainerNow()) void refreshConnector(connector);
  else if (state.role === "member") void loadOperatorContract();
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
  storeToken(value);
  const current = fence();
  void loadCurrent().then(() => {
    if (!current()) return;
    if (state.session === "ready") set({ pendingFocus: `${state.page}Heading` });
    else if (state.session === "denied") set({ pendingFocus: "gateHeading" });
  });
}

export function forgetBearer(): void {
  signedOut = true;
  resetRecovery();
  storeToken(null);
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
  if (memberDispatch(connectorId, CONFIRM_ACTION[action]) === null) return;
  set({ confirming: { connectorId, action }, pendingFocus: `confirm-cancel-${connectorId}` });
}

/** Recovery started: close the page's in-row confirmation; the page is stale. */
export function closeForRecovery(): void {
  if (state.confirming) set({ confirming: null });
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
function stopOAuthPolling(connector?: string): void {
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
  const valid = memberDispatch(connector, mode === "continue" ? "connect" : "restart");
  if (valid === null) return memberRefused(connector, "oauth");
  stopOAuthPolling();
  const startedOn = navigationRevision;
  const generation = oauthPollGeneration;
  const tab = openBlankTab();
  return mutate({
    request: (current) => operatorRequest(oauthStartPath(connector, mode), "POST", current, undefined, valid),
    busy: {
      oauthBusy: connector,
      oauthNotice: null,
      oauthNoticeFor: connector,
      oauthBlocked: null,
      oauthBlockedUrl: null,
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
      // A member's "check on return" outlives the poll window; see `memberAuthorizations`.
      if (state.role === "member") memberAuthorizations.set(connector, Date.now());
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
        oauthBlockedUrl: tab ? null : url,
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
  const valid = memberDispatch(connector, "disconnect");
  if (valid === null) return memberRefused(connector, "oauth");
  stopOAuthPolling(connector);
  return mutate({
    request: (current) =>
      operatorRequest(`/ui/oauth/${encodeURIComponent(connector)}`, "DELETE", current, undefined, valid),
    busy: {
      oauthBusy: connector,
      oauthNotice: null,
      oauthNoticeFor: connector,
      oauthBlocked: null,
      oauthBlockedUrl: null,
      confirming: null,
    },
    done: (payload) => {
      memberAuthorizations.delete(connector);
      return oauthNoticePatch(connector, oauthDoneNotice("oauth_disconnect", payload));
    },
    failed: (facts) =>
      oauthNoticePatch(connector, actionFailedNotice("oauth_disconnect", connector, facts, productName)),
    reload: connector,
  });
}

/* Credentials ------------------------------------------------------------- */

export function editCredential(connector: string | null): void {
  if (connector && memberDispatch(connector, "save") === null) return;
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
  const valid = memberDispatch(connector, "save");
  if (valid === null) return memberRefused(connector, "credential");
  return credentialMutation(
    connector,
    "credential_save",
    (current) => operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}`, "PUT", current, body, valid),
    () => ({ credentialEditing: null, credentialNotice: info("Credential saved.") }),
  );
}

export function removeCredential(connector: string): Promise<void> {
  const valid = memberDispatch(connector, "clear");
  if (valid === null) return memberRefused(connector, "credential");
  return credentialMutation(
    connector,
    "credential_remove",
    (current) =>
      operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}`, "DELETE", current, undefined, valid),
    () => ({ credentialNotice: info("Credential removed.") }),
  );
}

export function testCredential(connector: string): Promise<void> {
  const valid = memberDispatch(connector, "test");
  if (valid === null) return memberRefused(connector, "credential");
  return credentialMutation(
    connector,
    "credential_test",
    (current) =>
      operatorRequest(`/ui/credentials/${encodeURIComponent(connector)}/test`, "POST", current, undefined, valid),
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
    pendingFocus: state.role === "member" ? "memberHeading" : `${state.page}Heading`,
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
      // A member has no `/ui/data`, so the deadline alone takes their contract
      // down, as a failed read would. Their late read is fenced: only a read
      // started after the deadline may put actions back on screen.
      const member = state.role === "member";
      if (member) ++dataRevision;
      set({
        recoveryPending: false,
        refreshing: false,
        ...(state.data
          ? { contract: null, contractPhase: "error" }
          : auth.kind === "cloudflare-access"
            ? {
                session: "gated",
                gate: failure("Cloudflare Access identity is unavailable. Retry."),
                ...(member ? memberUnavailable() : {}),
              }
            : { session: "ready", gate: null, loadFailure: "network", ...(member ? memberUnavailable() : {}) }),
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
  // No access is an answer, not a transient failure: nothing to recheck.
  if (signedOut || recoveryRead || state.session === "denied") return;
  // Focus is also a way out of a refusal. It only re-requests admission.
  // A member's page is whole without `/ui/data`; it has nothing else to recheck.
  const member = state.role === "member" && state.contract?.role === "member";
  if (
    recoveryAttempt > 0 ||
    state.session !== "ready" ||
    (!state.data && !member) ||
    state.loadFailure ||
    state.contractPhase === "error"
  ) {
    recover();
    return;
  }
  // A member's own connection state rides in the contract: read it again
  // while an authorization this tab started may have finished elsewhere.
  if (member) {
    if (state.oauthBusy || (!awaitingAuthorization.size && !memberAuthorizationPending())) return;
    const now = Date.now();
    if (now - lastAuthorizationReturn < RETURN_MIN_INTERVAL_MS) return;
    lastAuthorizationReturn = now;
    void loadOperatorContract();
    return;
  }
  if (!state.data || !maintainerNow()) return;
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
      return gate(failure("Clerk couldn't load. Try again."));
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
      return gate(failure("Clerk couldn't start. Reload the page."));
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
  const sent = send(`/ui/connectors/${encodeURIComponent(id)}`, {
    signal,
    headers: requestHeaders(token),
    credentials: "same-origin",
  });
  // Withheld: the cycle that asked is fenced or about to be.
  if (!sent) return { kind: "local", failure: "session" };
  let response: Response;
  try {
    response = await sent;
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
  contract: OperatorUiContractV2 | null,
): Partial<OperatorState> {
  if (!state.data) return {};
  let connectorFailures = state.connectorFailures;
  const patch: Partial<OperatorState> = {};
  const connectors = state.data.connectors
    .filter((c) => !contract?.config || contract.config.connectors.some((v) => v.id === c.id))
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
  if (!maintainerNow() || !state.data?.connectors.some((connector) => connector.id === id)) return Promise.resolve();
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

/*
 * One fence decides whether an agent's slot may be acted on. Every event that
 * touches a slot takes the next value of one monotonic counter as that
 * agent's generation: a mutation's dispatch, its completion or failure, a
 * list read's result for it, and a contract refresh whose `agents[].token`
 * disagrees with the list or drops the agent.
 *
 * - A list read applies to an agent only if no event touched it after the
 *   read started, and it resolves the slot only if, in addition, no mutation
 *   for that agent is in flight.
 * - A mutation applies its result only if no other event touched the slot
 *   after its dispatch. Otherwise the slot stays unresolved with the newer
 *   evidence, and nothing is restored.
 * - Any other outcome (unreadable or invalid response, 409, 503, 499, network)
 *   leaves the slot unresolved, so only a read started after it can resolve it.
 *
 * An unresolved slot's controls are off and nothing is dispatched against it.
 */

let tokenEpoch = 0;
/** Each agent's generation: the epoch of the latest event that touched its slot. */
const slotGeneration = new Map<string, number>();
const unresolvedAt = new Map<string, number>();
/** Agents with a token mutation sent and not yet settled. */
const slotsInFlight = new Set<string>();

function touch(name: string): number {
  const generation = ++tokenEpoch;
  slotGeneration.set(name, generation);
  return generation;
}

/**
 * The agents the last successful maintainer contract listed. Like the last
 * confirmed role, it outlives a failed refresh that clears `contract`, so the
 * next good answer is still compared with what came before it.
 */
let confirmedAgents = new Set<string>();

/**
 * The fence belongs to one identity. A new one starts empty, and a ticket
 * from the old one never touches it again (see `SlotTicket.identity`).
 */
function forgetSlotFence(): void {
  tokenConfirmChecked = null;
  memberAuthorizations.clear();
  lastAuthorizationReturn = -Infinity;
  slotGeneration.clear();
  unresolvedAt.clear();
  slotsInFlight.clear();
  confirmedAgents = new Set();
}

const generationOf = (name: string) => slotGeneration.get(name) ?? 0;
const unresolvedList = (): Pick<OperatorState, "unresolvedSlots"> => ({ unresolvedSlots: [...unresolvedAt.keys()] });

/** Touch these agents' slots and leave them unresolved, as a state patch. */
function unresolve(names: Iterable<string>): Pick<OperatorState, "unresolvedSlots"> {
  for (const name of names) unresolvedAt.set(name, touch(name));
  return unresolvedList();
}

/** The slots with this one replaced, or appended when a read has not listed it yet. */
function replaceSlot(slot: AgentSlot): Pick<OperatorState, "tokens"> {
  return {
    tokens: state.tokens.some((current) => current.name === slot.name)
      ? state.tokens.map((current) => (current.name === slot.name ? slot : current))
      : [...state.tokens, slot],
  };
}

const isTimestamp = (value: unknown) => typeof value === "string" && value.length > 0;

/** One slot exactly as the route defines it, or nothing: a partial answer resolves nothing. */
function parseSlot(value: unknown): AgentSlot | null {
  if (!value || typeof value !== "object") return null;
  const slot = value as Record<string, unknown>;
  if (typeof slot.name !== "string" || !slot.name) return null;
  if (slot.revision !== undefined && typeof slot.revision !== "string") return null;
  const revision = typeof slot.revision === "string" ? { revision: slot.revision } : {};
  if (slot.state === "none") return { name: slot.name, state: "none", ...revision };
  if (slot.state === "issued" && isTimestamp(slot.issuedAt)) {
    return { name: slot.name, state: "issued", issuedAt: slot.issuedAt as string, ...revision };
  }
  if (slot.state === "revoked" && isTimestamp(slot.revokedAt)) {
    return { name: slot.name, state: "revoked", revokedAt: slot.revokedAt as string, ...revision };
  }
  return null;
}

/**
 * A refreshed maintainer contract, before it lands: touch and unresolve every
 * listed slot whose `agents[].token` now disagrees with the list, and every
 * agent the refresh dropped. An action pending against either then fails its
 * dispatch check, and a mutation in flight for it will not apply its result.
 */
function contractSlotsRefreshed(contract: OperatorUiContractV2): Partial<OperatorState> {
  if (contract.role !== "maintainer") return {};
  const next = new Map(contract.agents.map((agent) => [agent.name, agent.token]));
  // Compared with the last confirmed agents plus every live slot, not with
  // `state.contract`, which a failed refresh in between may have cleared.
  const previous = new Set([...confirmedAgents, ...state.tokens.map((slot) => slot.name)]);
  confirmedAgents = new Set(next.keys());
  const changed = new Set([...previous].filter((name) => !next.has(name)));
  // Field by field, revision included: the same state at another revision is another slot.
  const stamp = (token: { state: string; issuedAt?: string; revokedAt?: string; revision?: string }) =>
    `${token.state}:${token.issuedAt ?? ""}:${token.revokedAt ?? ""}:${token.revision ?? ""}`;
  for (const slot of state.tokens) {
    const token = next.get(slot.name);
    if (token && stamp(token) !== stamp(slot)) changed.add(slot.name);
  }
  return changed.size ? unresolve(changed) : {};
}

/** What an action was validated against: the agent's generation, and the route's revision for `expect`. */
interface SlotChecked {
  action: SlotAction;
  generation: number;
  /** The route's own slot revision, sent as `expect`. A slot without one is never acted on. */
  expect: string;
}

/**
 * Which of `actions` the agent's slot allows right now: a live, resolved
 * slot, nothing in flight for it and no other token operation running. The
 * row renders from the same facts.
 */
function slotCheck(name: string, actions: SlotAction[]): SlotChecked | null {
  if (state.tokenBusy || !maintainerNow() || unresolvedAt.has(name) || slotsInFlight.has(name)) return null;
  const resolved = resolveSlot(state.contract, state.tokens, name);
  if (!resolved?.live) return null;
  const action = slotActions(resolved.slot).find((candidate) => actions.includes(candidate));
  // No revision to send as `expect`: unresolved until a list read supplies one.
  if (!action || !resolved.slot.revision) return null;
  return { action, generation: generationOf(name), expect: resolved.slot.revision };
}

/**
 * The compare-and-swap body every token mutation sends, POST and DELETE
 * alike: the route's slot revision the operator confirmed against. The route
 * refuses a mismatch with 409 `slot_changed` before minting or writing.
 */
function expectBody(checked: SlotChecked): { expect: string } {
  return { expect: checked.expect };
}

/** One mutation's claim on its slot, from dispatch to settlement. */
interface SlotTicket {
  /** The identity (`state.generation`) that created it; another identity's fence is never touched. */
  identity: number;
  /** The generation its dispatch took; null until it is sent. */
  dispatched: number | null;
}

function slotTicket(): SlotTicket {
  return { identity: state.generation, dispatched: null };
}

/**
 * The dispatch check for an action validated as `checked`, run immediately
 * before `fetch`. Passing it is the send: the slot is touched, unresolved and
 * in flight, and the ticket keeps the generation the result will be held to.
 */
function slotDispatch(name: string, checked: SlotChecked, ticket: SlotTicket): () => boolean {
  return () => {
    if (!maintainerNow() || unresolvedAt.has(name) || slotsInFlight.has(name)) return false;
    const resolved = resolveSlot(state.contract, state.tokens, name);
    const valid =
      Boolean(resolved?.live) &&
      slotActions(resolved!.slot).includes(checked.action) &&
      generationOf(name) === checked.generation;
    if (!valid) return false;
    set(unresolve([name]));
    ticket.dispatched = generationOf(name);
    slotsInFlight.add(name);
    return true;
  };
}

/**
 * Settle a mutation whose response was parsed and validated. The result is
 * applied only when nothing touched the slot since dispatch; otherwise the
 * newer evidence stays, the slot stays unresolved, and the caller says so.
 */
function settleSlot(ticket: SlotTicket, slot: AgentSlot): { applied: boolean; patch: Partial<OperatorState> } {
  // `mutate` only lands results for the identity that asked; check anyway.
  if (ticket.identity !== state.generation) return { applied: false, patch: {} };
  slotsInFlight.delete(slot.name);
  const untouched = ticket.dispatched !== null && generationOf(slot.name) === ticket.dispatched;
  touch(slot.name);
  if (!untouched) return { applied: false, patch: unresolve([slot.name]) };
  unresolvedAt.delete(slot.name);
  return { applied: true, patch: { ...replaceSlot(slot), ...unresolvedList() } };
}

/** Settle a mutation that failed or could not be read: unresolved, and touched after any read already running. */
function abandonSlot(name: string, ticket: SlotTicket): Pick<OperatorState, "unresolvedSlots"> | Record<string, never> {
  // Never sent, or sent by an identity that is gone: nothing here to settle.
  if (ticket.dispatched === null || ticket.identity !== state.generation) return {};
  slotsInFlight.delete(name);
  return unresolve([name]);
}

let tokenRevision = 0;
export async function loadAccessTokens(): Promise<void> {
  if (!maintainerNow()) return;
  const identityCurrent = fence();
  const revision = ++tokenRevision;
  const current = () => identityCurrent() && revision === tokenRevision;
  // A read speaks for an agent only if nothing touched its slot after this.
  const startedAt = tokenEpoch;
  set({ tokenPhase: "loading", tokenNotice: null });
  try {
    const payload = await operatorRequest("/ui/access-tokens", "GET", current);
    if (!current()) return;
    if (!Array.isArray(payload?.agents)) throw new Error("The agent token slots were not returned.");
    const listed = payload.agents.map(parseSlot);
    if (listed.some((slot) => slot === null)) throw new Error("An agent token slot could not be read.");
    const fresh = (name: string) => generationOf(name) <= startedAt;
    const read = new Map((listed as AgentSlot[]).map((slot) => [slot.name, slot]));
    const tokens: AgentSlot[] = [];
    for (const slot of read.values()) {
      // Something touched this slot after the read started: keep what is on screen.
      const kept = state.tokens.find((current) => current.name === slot.name);
      if (!fresh(slot.name)) {
        if (kept) tokens.push(kept);
        continue;
      }
      tokens.push(slot);
      touch(slot.name);
      if (!slotsInFlight.has(slot.name)) unresolvedAt.delete(slot.name);
    }
    // Agents the read no longer lists leave, unresolved, unless something newer touched them.
    for (const slot of state.tokens) {
      if (read.has(slot.name)) continue;
      if (!fresh(slot.name)) tokens.push(slot);
      else unresolvedAt.set(slot.name, touch(slot.name));
    }
    set({ tokenPhase: "ready", tokens, ...unresolvedList() });
  } catch {
    if (!current()) return;
    // The page's error block says so, once; the notice line stays for actions.
    // An unreadable list settles nothing, and unresolves what it was meant to
    // confirm, unless something newer already touched it.
    const stale = state.tokens.map((slot) => slot.name).filter((name) => generationOf(name) <= startedAt);
    set({ tokenPhase: "error", ...unresolve(stale) });
  }
}

/** A failed token operation, said once. Nothing is retried: the operator decides. */
function tokenFailure(action: SlotAction, name: string, facts: RequestFailureFacts): Partial<OperatorState> {
  return {
    tokenBusy: false,
    tokenNotice: tokenFailureNotice(action, name, facts, productName),
    pendingFocus: "tokenNotice",
  };
}

/** Said when a validated result arrived after newer evidence about its slot. */
const settledLate = (name: string) => `${name}'s token changed during this request. Refresh to check it.`;

/** Issue the agent's first token or rotate it; the previous secret stops at once. */
export function rotateAgentToken(name: string): Promise<void> {
  // The same resolution the row renders from: only a live, resolved slot is acted on.
  const checked = slotCheck(name, ["issue", "rotate"]);
  if (!checked) return Promise.resolve();
  // Rotation takes a working token away: it asks in the row first.
  if (checked.action === "rotate") return askTokenAction(name, checked);
  return sendRotation(name, checked);
}

/** Ask in the row before a rotation or revocation; nothing is sent until `confirmTokenAction`. */
function askTokenAction(name: string, checked: SlotChecked): Promise<void> {
  tokenConfirmChecked = checked;
  set({
    tokenConfirm: { name, action: checked.action === "revoke" ? "revoke" : "rotate" },
    pendingFocus: `confirm-cancel-token-${name}`,
  });
  return Promise.resolve();
}

/** What the open token confirmation was asked against. */
let tokenConfirmChecked: SlotChecked | null = null;

/**
 * Close the token confirmation without acting. Recovery closes it too
 * (`useCloseOnRecovery`), with focus then going to the banner's Retry.
 */
export function cancelTokenAction(returnFocusTo?: string): void {
  tokenConfirmChecked = null;
  if (state.tokenConfirm) set({ tokenConfirm: null, ...(returnFocusTo ? { pendingFocus: returnFocusTo } : {}) });
}

/**
 * The operator confirmed. Sent only if the slot is exactly as it was when the
 * question was asked; otherwise the row says it changed and nothing goes out.
 */
export function confirmTokenAction(): Promise<void> {
  const pending = state.tokenConfirm;
  const checked = tokenConfirmChecked;
  tokenConfirmChecked = null;
  if (!pending || !checked) return Promise.resolve();
  set({ tokenConfirm: null });
  const now = slotCheck(pending.name, [checked.action]);
  if (!now || now.generation !== checked.generation) {
    set(tokenFailure(checked.action, pending.name, { kind: "stale" }));
    return Promise.resolve();
  }
  return checked.action === "revoke" ? sendRevocation(pending.name, checked) : sendRotation(pending.name, checked);
}

function sendRotation(name: string, checked: SlotChecked): Promise<void> {
  const { action } = checked;
  const ticket = slotTicket();
  return mutate({
    request: (current) =>
      operatorRequest(
        `/ui/access-tokens/${encodeURIComponent(name)}`,
        "POST",
        current,
        expectBody(checked),
        slotDispatch(name, checked, ticket),
      ),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => {
      const slot = parseSlot(payload?.agent);
      const secret = payload?.token;
      if (typeof secret !== "string" || !secret || slot?.name !== name || slot.state !== "issued") {
        throw new Error("The issued token was not returned.");
      }
      const { applied, patch } = settleSlot(ticket, slot);
      // The secret was minted either way and is never shown again, so it is
      // still revealed; only the slot's newer evidence wins.
      const reveal = state.page === "tokens";
      return {
        tokenBusy: false,
        tokenPhase: "ready",
        ...patch,
        createdToken: reveal ? secret : null,
        createdTokenFor: reveal ? name : null,
        tokenNotice: applied
          ? info(`Token ${action === "issue" ? "issued" : "rotated"} for ${name}.`)
          : failure(settledLate(name)),
      };
    },
    failed: (facts) => ({ ...tokenFailure(action, name, facts), ...abandonSlot(name, ticket) }),
    abandoned: () => void abandonSlot(name, ticket),
  });
}

export function dismissCreatedToken(): void {
  set({ createdToken: null, createdTokenFor: null });
}

export function revokeAgentToken(name: string): Promise<void> {
  const checked = slotCheck(name, ["revoke"]);
  if (!checked) return Promise.resolve();
  return askTokenAction(name, checked);
}

function sendRevocation(name: string, checked: SlotChecked): Promise<void> {
  const ticket = slotTicket();
  return mutate({
    request: (current) =>
      operatorRequest(
        `/ui/access-tokens/${encodeURIComponent(name)}`,
        "DELETE",
        current,
        expectBody(checked),
        slotDispatch(name, checked, ticket),
      ),
    busy: { tokenBusy: true, tokenNotice: null },
    done: (payload) => {
      const slot = parseSlot(payload?.agent);
      if (slot?.name !== name || slot.state !== "revoked") throw new Error("The revoked slot was not returned.");
      const { applied, patch } = settleSlot(ticket, slot);
      return {
        tokenBusy: false,
        ...patch,
        tokenNotice: applied ? info(`${name}'s token revoked.`) : failure(settledLate(name)),
        pendingFocus: "tokenNotice",
      };
    },
    failed: (facts) => ({ ...tokenFailure("revoke", name, facts), ...abandonSlot(name, ticket) }),
    abandoned: () => void abandonSlot(name, ticket),
  });
}
