import type { OperatorRole, OperatorUiContractV2 } from "./contract.js";
import type { CatalogDriftReport } from "../types.js";
import type { CredentialManagementCapability, UiConnector, UiData, UiProblem } from "./model.js";
import type { FixPromptKind } from "./fix-prompts.js";
import type { AgentSlot } from "./agents.js";

/**
 * Everything the operator app knows, and every rule for changing it, with no
 * DOM in sight. The components render this and nothing else, so the questions
 * that matter — what a page shows while it loads, what an identity change
 * erases, whether a value may become an href — are answered by functions a test
 * can call directly rather than by reading rendered markup back out of a
 * browser.
 */

const REGISTRATION_LABELS: Record<NonNullable<UiConnector["registrationPath"]>, string> = {
  cimd: "Client metadata document (CIMD)",
  dcr: "Dynamic registration (DCR)",
  static: "Pre-registered client",
};

export function registrationPathLabel(path: NonNullable<UiConnector["registrationPath"]>): string {
  return REGISTRATION_LABELS[path];
}

/**
 * A connector's source column: the maintained provider with the
 * implementation it uses, since a dual provider's `auth` selects either the
 * vendor's hosted MCP server or Connecta's REST connector.
 */
export function connectorSourceLabel(source: { kind: string; provider?: string }): string {
  if (!source.provider) return source.kind;
  const implementation = source.kind === "remote-mcp" ? "hosted MCP" : source.kind === "api" ? "REST" : source.kind;
  return `${source.provider} · ${implementation}`;
}

export type OperatorPage = "overview" | "endpoints" | "settings" | "connector" | "tokens" | "connections" | "activity";

/** Pages the nav lists, in dashboard order. */
export const OPERATOR_PAGES: readonly OperatorPage[] = [
  "overview",
  "endpoints",
  "connections",
  "activity",
  "tokens",
  "settings",
];

export const PAGE_META: Readonly<Record<OperatorPage, { path: string; label: string }>> = {
  overview: { path: "/", label: "Overview" },
  endpoints: { path: "/endpoints", label: "Endpoints" },
  connector: { path: "/connectors", label: "Connector" },
  settings: { path: "/settings", label: "Settings" },
  tokens: { path: "/tokens", label: "Tokens" },
  connections: { path: "/connectors", label: "Connectors" },
  activity: { path: "/activity", label: "Activity" },
};

/** Legacy links remain valid, with the browser replacing their URL. */
export function canonicalOperatorPath(path: string): string {
  return (
    ({ "/access": "/endpoints", "/tools": "/connectors", "/config": "/settings" } as Record<string, string>)[path] ??
    path
  );
}

/**
 * What each page is for, in one line under its heading — on the gate as well
 * as once signed in, so the page an operator lands on reads the same before
 * and after the session is checked.
 */
export function pageDescription(page: OperatorPage, productDescription: string): string {
  if (page === "activity") {
    return "Every connector tool call, by who made it and how it ended. Arguments and results are never stored.";
  }
  return productDescription;
}

/**
 * Signed in, but neither a maintainer nor a member of any endpoint: who to
 * ask, and that this is not an error to retry.
 */
export function noAccessCopy(kind: string, productName: string): string {
  const who =
    kind === "clerk"
      ? "This account is signed in"
      : kind === "cloudflare-access"
        ? "Cloudflare Access signed you in"
        : "This token is valid";
  return `${who}, but it isn't a maintainer or a member of any endpoint on ${productName}. Ask a maintainer of this deployment to add you to an endpoint, then reload.`;
}

/** What the gate says while the session is checked, page by page. */
export function checkingCopy(): string {
  return "Checking your session…";
}

export function pageForPath(path: string): OperatorPage {
  if (/^\/connectors\/[a-z0-9_-]+$/.test(path)) return "connector";
  if (path === "/tokens") return "tokens";
  const match = OPERATOR_PAGES.find((page) => PAGE_META[page].path === canonicalOperatorPath(path));
  return match ?? "connections";
}

export interface UiActivityActor {
  kind?: string;
  id?: string;
  namespace?: string;
  label?: string;
}

export interface UiActivityEvent {
  kind?: "catalog_drift";
  drift?: import("../activity.js").ActivityCatalogChange;
  id?: string;
  requestId?: string;
  classification?: "read" | "write";
  resultBytes?: number;
  occurredAt: string;
  actor?: UiActivityActor;
  connectorId: string;
  toolName: string;
  address: string;
  source: string;
  outcome: string;
  durationMs: number;
  attempts: number;
  errorCode?: string;
  friction?: string;
  approval?: string;
  packageVersion?: string;
  clientName?: string;
  clientVersion?: string;
}

/**
 * Which fix prompt a failure offers. A kind and a configured connector id —
 * the message beside it never travels with it.
 */
export interface NoticeFix {
  kind: FixPromptKind;
  connectorId: string;
}

/** A message with the tone that decides its live region: status or alert. */
export interface Notice {
  message: string;
  tone: "info" | "error";
  fix?: NoticeFix;
}

export function info(message: string): Notice {
  return { message, tone: "info" };
}

export function failure(message: string, fix?: NoticeFix): Notice {
  return fix ? { message, tone: "error", fix } : { message, tone: "error" };
}

/**
 * Why a request the page made did not land, as the store classifies it. Only
 * this kind, a status code, and a closed `problem` enum ever reach a notice;
 * the route's `error` text never does.
 *
 * - `session` — no usable session, or the route answered 401.
 * - `forbidden` — the route answered 403: this identity may not do that. On a
 *   mutation that is a permission, not an expired session, so it stays inline.
 * - `network` — the browser could not reach the deployment at all.
 * - `refused` — the route answered, and said no.
 * - `stale` — never sent: what the action was checked against changed before
 *   dispatch (a refreshed slot list or member contract).
 */
export type RequestFailureKind = "session" | "forbidden" | "network" | "refused" | "stale";

export interface RequestFailureFacts {
  kind: RequestFailureKind;
  status?: number | undefined;
  problem?: unknown;
  /** A refusal's machine `code` from a closed set, such as `slot_changed`; checked, never shown. */
  code?: unknown;
}

/**
 * What the notices for an OAuth action and a credential Test say. Each of
 * those actions reaches a downstream, and a downstream's refusal can quote the
 * secret it was sent — so these notices are fixed sentences chosen by outcome,
 * and no text the server sent back is ever one of them. The route logs the
 * downstream's words on the host; the fix prompt beside a failure is keyed off
 * the same outcome.
 */
export type DownstreamAction = "oauth_disconnect" | "oauth_reconnect" | "credential_test";

/** Every action a connector row can start, downstream or not. */
export type RowAction = DownstreamAction | "credential_save" | "credential_remove";

const REFUSED_COPY: Readonly<Record<DownstreamAction, string>> = {
  oauth_disconnect: "Disconnect didn't finish. If the service refused it, the deployment's log has its reply.",
  oauth_reconnect: "Authorization couldn't start. If the service refused it, the deployment's log has its reply.",
  credential_test: "The credential test couldn't run.",
};

/**
 * The route's answer to a finished OAuth action. Its state picks the sentence;
 * `opened` says whether the authorization page is already in a new tab.
 */
export function oauthDoneNotice(
  action: "oauth_disconnect" | "oauth_reconnect",
  answer: { state?: unknown; code?: unknown } | null,
  opened = true,
): Notice {
  if (action === "oauth_disconnect") {
    if (answer?.code === "oauth_revocation_failed")
      return info(
        "Disconnected locally. Provider revocation could not be confirmed. Revoke the grant in the provider's console.",
      );
    return info("Disconnected. Connect again whenever you are ready.");
  }
  if (answer?.state === "ok") return info("Connected.");
  return info(
    opened
      ? "Finish authorizing in the new tab. This page updates when you come back."
      : "Your browser blocked the new tab. Open the authorization page from the link here.",
  );
}

/** A credential Test's result. `ok` is the only part of the answer it reads. */
export function credentialTestNotice(connectorId: string, answer: { ok?: unknown } | null): Notice {
  return answer?.ok === true
    ? info("Credential is valid.")
    : failure(
        "Credential test failed: the service rejected the stored credential, or the test couldn't reach it. The deployment's log has the service's reply.",
        { kind: "credential_test_failed", connectorId },
      );
}

/**
 * A route that refused one of these actions. A credential Test that found
 * nothing usable to test names the problem, which picks the same copy and fix
 * prompt the Connections page uses for it; every other refusal gets the
 * action's one sentence. `problem` is whatever the response carried, so it is
 * checked, not trusted.
 */
export function refusedNotice(action: DownstreamAction, connectorId: string, problem?: unknown): Notice {
  if (action === "credential_test" && (problem === "credential_required" || problem === "credential_mismatch")) {
    return failure(PROBLEM_COPY[problem], { kind: problem, connectorId });
  }
  return failure(REFUSED_COPY[action], {
    kind: action === "credential_test" ? "credential_test_failed" : "oauth_action_failed",
    connectorId,
  });
}

/**
 * A credential save or removal the route refused, by status. The route's
 * `error` can name a vault failure or echo validation detail, so none of it
 * is shown; the status is enough to say what to do next.
 */
function credentialRefusedCopy(
  action: "credential_save" | "credential_remove",
  status: number | undefined,
  problem: unknown,
): string {
  if (problem === "credential_mismatch") return PROBLEM_COPY.credential_mismatch;
  const verb = action === "credential_save" ? "saved" : "removed";
  if (status === 400 || status === 413 || status === 415) {
    return action === "credential_save"
      ? "The credential wasn't saved: a value is empty or not in the expected format. Check it and save again."
      : "The credential wasn't removed. Refresh the page and try again.";
  }
  if (status === 404) {
    return "This connector no longer has a credential slot. Refresh the page to see its current setup.";
  }
  if (status === 503) {
    return `Credential storage isn't configured on this deployment, so nothing was ${verb}.`;
  }
  return `The credential wasn't ${verb}. Try again; if it keeps failing, the deployment's log has the reason.`;
}

/** An action whose permission or target changed before it was sent. */
export const STALE_COPY = "This changed before the request was sent, so nothing was sent. Check it and try again.";

/**
 * Every row action's failure, in one voice. The page's own failures — a
 * lapsed session, a denied identity, a dropped connection — read the same for
 * every action; a route's refusal picks the action's fixed sentence.
 */
export function actionFailedNotice(
  action: RowAction,
  connectorId: string,
  facts: RequestFailureFacts,
  productName: string,
): Notice {
  if (facts.kind === "session") {
    return failure("Your session has ended. Sign in again, then retry.");
  }
  if (facts.kind === "forbidden") {
    return failure("You don't have permission to change this connection's authentication.");
  }
  if (facts.kind === "network") {
    return failure(`Couldn't reach ${productName}. Check your connection and try again.`);
  }
  if (facts.kind === "stale") return failure(STALE_COPY);
  if (action === "credential_save" || action === "credential_remove") {
    return failure(credentialRefusedCopy(action, facts.status, facts.problem));
  }
  return refusedNotice(action, connectorId, facts.problem);
}

/**
 * Why one connector's details did not load, when the reason is on this side
 * of the deployment rather than the downstream's. A downstream failure is the
 * server's `connector_unavailable` and keeps its own copy and fix prompt;
 * these two have nothing for a coding agent to fix.
 */
export type ConnectorLoadFailure = "session" | "network" | "unavailable";

export function connectorLoadFailureCopy(failure: ConnectorLoadFailure, productName: string): string {
  if (failure === "unavailable") return "Session identity is temporarily unavailable. Retry this connection.";
  return failure === "session"
    ? "Your session wasn't accepted while loading this connector. Retry to check again. Sign in again if the session keeps failing."
    : `Couldn't reach ${productName} to load this connector. Check your connection, then refresh it.`;
}

/** The signed-in page's answer when `/ui/data` could not be read. */
export function loadFailureCopy(failure: "server" | "network", productName: string): { title: string; body: string } {
  return {
    title: `Couldn't reach ${productName}`,
    body:
      failure === "network"
        ? "Your browser couldn't connect. Check your connection, then retry."
        : "The deployment answered with an error. Retry in a moment; if it keeps failing, the deployment's log has the reason.",
  };
}

/** A collection page's load failure: fixed words, whatever the route said. */
export function collectionFailureCopy(
  _collection: "activity",
  facts: RequestFailureFacts,
  productName: string,
): string {
  if (facts.kind === "network") {
    return `Couldn't reach ${productName}. Check your connection, then retry.`;
  }
  if (facts.kind === "session") return "Your session has ended. Sign in again to see this page.";
  if (facts.kind === "forbidden" || facts.status === 404) {
    return "Activity isn't available to this identity.";
  }
  return "The deployment answered with an error. Retry in a moment; if it keeps failing, the deployment's log has the reason.";
}

/** A destructive or disruptive row action waiting for a second, in-page click. */
export interface PendingConfirm {
  connectorId: string;
  action: "oauth_disconnect" | "oauth_restart" | "credential_remove";
}

/** The confirm's question, naming the connector by its title. */
export function confirmCopy(action: PendingConfirm["action"], name: string): { question: string; confirm: string } {
  if (action === "oauth_disconnect") {
    return {
      question: `Disconnect ${name}? Its stored grant and any pending authorization are removed, and its tools stop working until it is connected again.`,
      confirm: "Disconnect",
    };
  }
  if (action === "oauth_restart") {
    return {
      question: `Reconnect ${name}? Its current grant stops working until you finish authorizing in the new tab.`,
      confirm: "Reconnect",
    };
  }
  return {
    question: `Remove ${name}'s credential? The connector stops authenticating until a replacement is added.`,
    confirm: "Remove",
  };
}

/**
 * A remote collection's four states, named once so every page spells them the
 * same way. `idle` is "nobody has asked yet" and is what makes a re-entered
 * page fetch again after an identity change.
 */
type LoadPhase = "idle" | "loading" | "ready" | "error";

export function accessTokenUnavailableCopy(capability?: string): string {
  return capability === undefined
    ? "Access tokens are not configured for this deployment."
    : "Token management requires an interactive sign-in and explicit permission.";
}

export interface OperatorState {
  tokenPhase: LoadPhase;
  tokenNotice: Notice | null;
  /** One slot per declared agent, from `/ui/access-tokens`. */
  tokens: AgentSlot[];
  /** A just-issued secret, shown once in its dialog and dropped when that closes. */
  createdToken: string | null;
  /** The agent `createdToken` belongs to. */
  createdTokenFor: string | null;
  /** A rotation or revocation waiting on its in-row confirmation. */
  tokenConfirm: { name: string; action: "rotate" | "revoke" } | null;
  /**
   * Agents whose last token operation ended with an unknown outcome (503,
   * 499, or a dropped connection). Their actions stay off until a slot list
   * read that started after the failure succeeds.
   */
  unresolvedSlots: string[];
  tokenBusy: boolean;
  page: OperatorPage;
  /**
   * Bumped by every identity change. Async work captures it before awaiting and
   * throws its result away if the operator is no longer the one who asked —
   * the fence that keeps one identity's data off another identity's screen.
   */
  generation: number;
  /**
   * `loading` until `/ui/api/config` answers (and, for a maintainer,
   * `/ui/data` too). `denied` is signed in as someone who is neither a
   * maintainer nor a pool member.
   */
  session: "loading" | "gated" | "ready" | "denied";
  gate: Notice | null;
  /** True while a signed-in operator's /ui/data is in flight. */
  refreshing: boolean;
  /** A bounded admission recovery is pending; Retry can supersede it. */
  recoveryPending: boolean;
  /**
   * Why the last /ui/data read failed when the session itself was not the
   * reason: the page stays signed in, with its chrome, and offers a retry.
   * Only a 401 or 403 on that read returns to the gate.
   */
  loadFailure: "server" | "network" | null;
  /**
   * Element id the next render should focus. A rebuilt page has no stable node
   * to hand focus to from an event handler, so the request travels through
   * state and the shell spends it once the new markup exists.
   */
  pendingFocus: string | null;
  /**
   * Like `pendingFocus`, but spent only when focus has nowhere to be — the
   * control that had it is gone. An action that lands next to its own control
   * announces through its live region and leaves focus where the operator is.
   */
  focusIfLost: string | null;
  data: UiData | null;
  /** Operator contract v2, for either role; null until `/ui/api/config` answers. */
  contract: OperatorUiContractV2 | null;
  /**
   * The role the last good contract confirmed. It outlives a failed refresh
   * that clears `contract`, so the next answer with a different role is
   * still recognized as a different viewer. Only an identity reset clears it.
   */
  role: OperatorRole | null;
  contractPhase: LoadPhase;
  health: "loading" | "ok" | "unavailable";
  connectorFilter: string;
  oauthNotice: Notice | null;
  /** The connector row `oauthNotice` answers, which is where it renders. */
  oauthNoticeFor: string | null;
  /** Connector id whose OAuth mutation is in flight. */
  oauthBusy: string | null;
  /**
   * Connector id whose authorization started while the browser refused the
   * new tab: its row offers the link instead of the button.
   */
  oauthBlocked: string | null;
  /**
   * The authorization link the route returned for `oauthBlocked`. A member has
   * no `/ui/data` connector to keep it on, so it is held here.
   */
  oauthBlockedUrl: string | null;
  /** A row action waiting for its in-page confirmation. */
  confirming: PendingConfirm | null;
  /** Connectors whose details failed on this side of the deployment. */
  connectorFailures: Readonly<Record<string, ConnectorLoadFailure>>;
  credentialNotice: Notice | null;
  /** The connector row `credentialNotice` answers. */
  credentialNoticeFor: string | null;
  /** Connector id whose credential form is open. */
  credentialEditing: string | null;
  /** Connector id whose credential mutation is in flight. */
  credentialBusy: string | null;
  activityPhase: LoadPhase;
  activityNotice: Notice | null;
  activityEvents: UiActivityEvent[];
  activityCursor: string | null;
  activitySearch: string;
}

/** Who the contract says this viewer is, or null before it loads. */
export function operatorRole(state: Pick<OperatorState, "contract">): OperatorRole | null {
  return state.contract?.role ?? null;
}

/**
 * The role pages and navigation render for. The contract's, or, while a
 * refresh that failed has left no contract on screen, maintainer when the
 * last good contract confirmed one and that maintainer's data is still here:
 * their page stays mounted on its own retry state instead of being torn down
 * mid-recovery. Never a request's permission; the store sends maintainer
 * reads only while the contract itself says maintainer.
 */
export function displayRole(state: Pick<OperatorState, "contract" | "role" | "data">): OperatorRole | null {
  if (state.contract) return state.contract.role;
  return state.role === "maintainer" && state.data ? "maintainer" : null;
}

/**
 * A confirmed maintainer's page is mounted without a contract behind it: a
 * refresh failed, or its read ran past the deadline. The shell shows one
 * recovery banner with Retry above whichever page is open, and that page is
 * stale until a contract confirms the role again.
 */
export function contractRecovering(state: Pick<OperatorState, "contract" | "role" | "data">): boolean {
  return !state.contract && displayRole(state) === "maintainer";
}

/**
 * Whether Activity is open to this viewer: maintainers only, on a deployment
 * that records history. Members always read "forbidden".
 */
export function activityReadable(state: Pick<OperatorState, "contract" | "data">): boolean {
  return Boolean(state.data?.activityEnabled) && activityAllowed(state);
}

/** The contract's half of `activityReadable`: a maintainer, on a deployment that records. */
export function activityAllowed(state: Pick<OperatorState, "contract">): boolean {
  const contract = state.contract;
  return (
    contract?.role === "maintainer" &&
    contract.live.activity !== "forbidden" &&
    contract.live.activity !== "unconfigured"
  );
}

export function initialState(page: OperatorPage): OperatorState {
  return {
    page,
    generation: 0,
    session: "loading",
    gate: null,
    refreshing: false,
    loadFailure: null,
    pendingFocus: null,
    focusIfLost: null,
    ...identityScopedState(),
  };
}

/**
 * Every field that belongs to one operator identity. Split out because the only
 * safe way to change identity is to replace all of them at once: a field left
 * behind here is one identity's data on another identity's screen.
 */
function identityScopedState() {
  return {
    recoveryPending: false,
    data: null,
    contract: null,
    role: null,
    contractPhase: "idle" as LoadPhase,
    health: "loading" as const,
    connectorFilter: "",
    oauthNotice: null,
    oauthNoticeFor: null,
    oauthBusy: null,
    oauthBlocked: null,
    oauthBlockedUrl: null,
    confirming: null,
    connectorFailures: {},
    credentialNotice: null,
    credentialNoticeFor: null,
    credentialEditing: null,
    credentialBusy: null,
    tokenPhase: "idle" as LoadPhase,
    tokenNotice: null,
    tokens: [],
    createdToken: null,
    createdTokenFor: null,
    tokenConfirm: null,
    unresolvedSlots: [],
    tokenBusy: false,
    activityPhase: "idle" as LoadPhase,
    activityNotice: null,
    activityEvents: [],
    activityCursor: null,
    activitySearch: "",
  } satisfies Partial<OperatorState>;
}

/**
 * Drop to the gate and forget the previous operator. Bumping the generation is
 * what makes the drop stick: work already in flight for the old identity
 * resolves into a state that no longer accepts it.
 */
export function resetIdentity(state: OperatorState, gate: Notice | null = null): OperatorState {
  return {
    ...state,
    generation: state.generation + 1,
    session: "gated",
    gate,
    refreshing: false,
    loadFailure: null,
    pendingFocus: null,
    focusIfLost: null,
    ...identityScopedState(),
  };
}

/**
 * Leaving a page closes what should not survive it: a one-time secret, a half
 * typed credential, and the notices that answered the page just left.
 */
export function withPage(state: OperatorState, page: OperatorPage): OperatorState {
  return {
    ...state,
    page,
    createdToken: null,
    createdTokenFor: null,
    tokenConfirm: null,
    tokenNotice: null,
    credentialEditing: null,
    credentialNotice: null,
    credentialNoticeFor: null,
    confirming: null,
  };
}

export function credentialUnavailableCopy(capability?: CredentialManagementCapability): string {
  if (capability === "no_slots") {
    return "No connectors declare operator-managed credential slots. Connector credentials remain configuration-as-code until a slot is declared.";
  }
  if (capability === "vault_not_configured") {
    return "Credential storage is not configured. Configure a vault before managing connector credentials here.";
  }
  return "Credential management requires an interactive user. Bearer-authenticated sessions can inspect connections but cannot manage stored credentials.";
}

/**
 * The status badge. An auth-needed connector is named by what it needs, so a
 * row whose fix is "Add credential" does not say "Authorization needed".
 */
export function connectorStatusLabel(status: string, problem?: UiProblem): string {
  if (status === "loading") return "Loading details";
  if (status === "ok") return "Connected";
  if (status === "credential_required") return "Credential needed";
  if (status === "auth_required") {
    return problem === "credential_required" ? "Credential needed" : "Authorization needed";
  }
  return "Unavailable";
}

/** The tone a status carries wherever it is rendered as a badge or a tile. */
export type Tone = "ok" | "warn" | "danger" | "neutral" | "accent";

export function connectorStatusTone(status: string): Tone {
  if (status === "ok") return "ok";
  if (status === "auth_required" || status === "credential_required") return "warn";
  if (status === "loading") return "neutral";
  return "danger";
}

/**
 * What the page says about a connector that is not usable, one fixed sentence
 * per problem kind the server classified. This is the only account of a
 * failure the Connections page renders: a connector's status message can quote
 * a downstream error body, and a downstream error body can quote the secret
 * that was just rejected, so the raw text stays in the deployment's log and
 * never reaches the payload or the DOM. The fix prompt beside it is keyed off
 * the same kind.
 */
const PROBLEM_COPY: Readonly<Record<UiProblem, string>> = {
  connector_unavailable:
    "Unavailable: its status check or catalog load failed, or did not finish in time. The deployment's log has the downstream error.",
  oauth_required: "Needs OAuth authorization: no grant is stored, or the stored grant expired or was revoked.",
  credential_required: "Needs a credential: nothing usable is stored in its credential slot.",
  auth_required: "Needs authorization. Its secret lives in deployment configuration, not on this page.",
  credential_mismatch: "The stored credential does not match the fields this connector declares, so it cannot be used.",
  catalog_failed: "Connected, but its tool catalog could not be loaded, so none of its tools are served.",
};

export function problemCopy(problem: UiProblem | undefined): string | null {
  return problem ? (PROBLEM_COPY[problem] ?? null) : null;
}

/**
 * A problem someone can fix by authorizing is a warning, matching the amber
 * "Authorization needed" badge above it; one where something broke is an
 * error. The two used to share the red box, so the row contradicted itself.
 */
export function problemTone(problem: UiProblem): "warn" | "danger" {
  return problem === "oauth_required" || problem === "credential_required" || problem === "auth_required"
    ? "warn"
    : "danger";
}

/** What the page knows about a connector beyond its live status: catalog drift and a failed detail read. */
export interface ConnectorSignals {
  drift?: boolean;
  failed?: boolean;
}

/** One connector's health everywhere it is shown: badge tone, status word, and the one action beside it. */
export interface ConnectorVerdict {
  tone: "ok" | "warn" | "danger" | "neutral";
  label: string;
  /** The link to the Connection tab, or null when the connector is fine. */
  action: "Connect" | "Replace key" | "Inspect" | "Review" | null;
}

const PROBLEM_LABEL: Readonly<Record<UiProblem, string>> = {
  connector_unavailable: "Unavailable",
  oauth_required: "Authorization needed",
  credential_required: "Credential needed",
  auth_required: "Authorization needed",
  credential_mismatch: "Credential mismatch",
  catalog_failed: "Catalog failed",
};

function problemAction(problem: UiProblem): NonNullable<ConnectorVerdict["action"]> {
  if (problem === "credential_mismatch") return "Replace key";
  return problemTone(problem) === "warn" ? "Connect" : "Inspect";
}

/**
 * The verdict the Connectors list, the Overview, Endpoints and a connector's
 * page all show. The server's problem code comes first, then a failed detail
 * read on this page, then a non-ok status, then catalog drift. A problem
 * outranks the status, so a connector whose catalog failed is never
 * "Connected". A failed read marks its connector `connector_unavailable` in
 * the store, so that one code beside a failed read is the page's own and
 * reads "Couldn't load" instead of blaming the downstream.
 */
export function connectorVerdict(
  live: { status: string; problem?: UiProblem },
  signals: ConnectorSignals = {},
): ConnectorVerdict {
  if (live.problem && !(signals.failed && live.problem === "connector_unavailable")) {
    return { tone: problemTone(live.problem), label: PROBLEM_LABEL[live.problem], action: problemAction(live.problem) };
  }
  if (signals.failed) return { tone: "warn", label: "Couldn't load", action: "Inspect" };
  if (live.status === "loading") return { tone: "neutral", label: connectorStatusLabel(live.status), action: null };
  if (live.status !== "ok") {
    const tone = connectorStatusTone(live.status) === "warn" ? "warn" : "danger";
    return { tone, label: connectorStatusLabel(live.status), action: tone === "warn" ? "Connect" : "Inspect" };
  }
  if (signals.drift) return { tone: "warn", label: "Catalog drift", action: "Review" };
  return { tone: "ok", label: "Connected", action: null };
}

/**
 * What this identity may do with a connector, in one line. Being able to use it
 * is implied by seeing it at all, so the sentence covers authentication, which
 * is the part that differs between operators.
 */
export function permissionLabel(connector: UiConnector): string {
  if (connector.permissions?.manageSharedAuth) {
    return "You can manage shared authentication for this connection.";
  }
  if (connector.permissions?.connectPersonal) {
    return "You can connect your own account to this connection.";
  }
  return "Authentication for this connection is managed by your deployment.";
}

/**
 * Hosted-provider catalog drift, as an operator reads it
 * ([#343](https://github.com/zackbart/connecta/issues/343)).
 *
 * - `unavailable` — no refresh has been observed in this runtime, so there is
 *   nothing to report. Deliberately not `clean`: "we have not looked" and "we
 *   looked and it matches" are different answers, and only one of them is a
 *   reason to stop worrying.
 * - `clean` — a refresh happened and every category counted zero.
 * - `warning` — a refresh happened and at least one category did not.
 */
export type DriftState = "clean" | "warning" | "unavailable";

/**
 * The categories, in the order an operator should read them: what the
 * deployment refuses to call, what it can no longer call, what contradicts a
 * vetted verdict, and what changed shape underneath a reviewed schema. Counts
 * only — a name or a schema on this path would be the payload leak the whole
 * drift model exists to avoid.
 */
const DRIFT_CATEGORIES: ReadonlyArray<{
  key: keyof Omit<CatalogDriftReport, "observedAt">;
  label: string;
}> = [
  { key: "unclassifiedTools", label: "Unclassified" },
  { key: "unservedTools", label: "Unserved" },
  { key: "annotationConflicts", label: "Annotation conflicts" },
  { key: "schemaChanges", label: "Schema changes" },
  { key: "droppedTools", label: "Dropped tool names" },
];

function driftTotal(drift?: CatalogDriftReport): number {
  if (!drift) return 0;
  return DRIFT_CATEGORIES.reduce((sum, { key }) => sum + (drift[key] || 0), 0);
}

export function driftState(drift?: CatalogDriftReport): DriftState {
  if (!drift) return "unavailable";
  return driftTotal(drift) > 0 ? "warning" : "clean";
}

/** Every category with its count, so a clean report still shows its zeros. */
export function driftCounts(drift?: CatalogDriftReport): Array<{ key: string; label: string; count: number }> {
  if (!drift) return [];
  return DRIFT_CATEGORIES.filter(({ key }) => key !== "droppedTools" || drift.droppedTools !== undefined).map(
    ({ key, label }) => ({
      key,
      label,
      count: drift[key] || 0,
    }),
  );
}

/** One line naming the state and when it was observed. Never what drifted. */
export function driftSummary(drift?: CatalogDriftReport): string {
  const state = driftState(drift);
  if (state === "unavailable") {
    return "No catalog refresh observed yet in this runtime.";
  }
  const observed = formatDate(drift?.observedAt);
  const when = observed ? ` · observed ${observed}` : "";
  if (state === "clean") return `Matches the reviewed manifest${when}`;
  const total = driftTotal(drift);
  return `${total} difference${total === 1 ? "" : "s"} from the reviewed manifest${when}`;
}

/**
 * Only http/https may become a clickable href — the browser half of the gate
 * `src/ui.ts` applies before an authorizationUrl is ever serialized. A hostile
 * downstream that gets a `javascript:` URL past one of them still meets the
 * other, and the caller renders inert text instead of a link.
 */
export function safeHttpHref(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Locale timestamp, or "" for anything that is not a readable date. */
export function formatDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  // Minutes, not seconds: nothing on these pages is read to the second, and
  // the seconds were most of the noise in every row that carried a date.
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ACTOR_KINDS: Readonly<Record<string, string>> = {
  clerk: "Clerk",
  bearer: "Bearer token",
  "cloudflare-access": "Cloudflare Access",
  anonymous: "Anonymous",
};

/** How a caller signed in, as a person reads it. An unknown kind is shown as sent. */
function actorKindLabel(kind: string | undefined): string {
  if (!kind) return "Unknown caller";
  return ACTOR_KINDS[kind] ?? kind;
}

/** Who made a call: their name when there is one, and how they signed in. */
export function actorLabel(actor?: UiActivityActor): string {
  if (!actor?.kind) return "Unknown caller";
  const who = actor.label || actor.id;
  const kind = actorKindLabel(actor.kind);
  return who ? `${who} (${kind})` : kind;
}

/**
 * The stable id behind a friendly label, shown only when a label or namespace
 * could otherwise make two different people look like one.
 */
export function actorStableId(actor?: UiActivityActor): string | null {
  if (!actor?.id) return null;
  if (!actor.label && !actor.namespace) return null;
  return actor.namespace ? `${actor.namespace} · ${actor.id}` : actor.id;
}

function activityMatches(event: UiActivityEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    event.address,
    event.connectorId,
    event.toolName,
    event.source,
    event.outcome,
    event.errorCode,
    event.friction,
    event.actor?.kind,
    event.actor?.id,
    event.actor?.namespace,
    event.actor?.label,
    activityOutcomeBadge(event.outcome).label,
    activityDetail(event),
    actorKindLabel(event.actor?.kind),
  ].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(q),
  );
}

export function filterActivity(events: UiActivityEvent[], query: string): UiActivityEvent[] {
  return events.filter((event) => activityMatches(event, query));
}

/** Counts only. What the deployment ran, never what it sent or received. */
export function activitySummary(events: UiActivityEvent[]): string {
  if (events.length === 0) return "";
  const calls = events.filter((event) => event.kind !== "catalog_drift");
  const changes = events.length - calls.length;
  const tools = new Set(calls.map((event) => event.address)).size;
  return `${calls.length} loaded call${calls.length === 1 ? "" : "s"} · ${tools} tool${
    tools === 1 ? "" : "s"
  }${changes ? ` · ${changes} catalog change${changes === 1 ? "" : "s"}` : ""}`;
}

// A pause and an approval are neither success nor failure: each gets its own
// class, and the stylesheet paints neither as an error. Nothing has emitted
// either since issue #672 removed program pauses, but older rows carry them.
const ACTIVITY_OUTCOMES = ["success", "error", "timeout", "cancelled", "paused", "approved"];

export function activityOutcomeClass(outcome: string): string {
  return ACTIVITY_OUTCOMES.includes(outcome) ? outcome : "error";
}

/** Each outcome as a badge: a word a person reads, and a tone that is never alone. */
const OUTCOME_BADGE: Readonly<Record<string, { label: string; tone: Tone }>> = {
  success: { label: "Succeeded", tone: "ok" },
  error: { label: "Failed", tone: "danger" },
  timeout: { label: "Timed out", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  paused: { label: "Paused for approval", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
};

export function activityOutcomeBadge(outcome: string): { label: string; tone: Tone } {
  return OUTCOME_BADGE[outcome] ?? { label: "Failed", tone: "danger" };
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  execute_code: "In a program",
  call_tool: "Direct call",
  call_destructive_tool: "Direct call, approved by the host",
  // History only: resume_execution left with program pauses (#672).
  resume_execution: "Resumed program",
  batch_call: "Batch call",
};

/**
 * Friction classes and the error codes an operator meets most, in words. An
 * unknown code falls back to itself with the underscores taken out, which is
 * still more readable than the wire form and never a guess at its meaning.
 */
const REASON_LABELS: Readonly<Record<string, string>> = {
  tool_not_found: "tool not found",
  unknown_address: "tool not found",
  unknown_tool: "tool not found",
  ambiguous_tool_alias: "ambiguous tool name",
  schema_retry: "arguments didn't match the schema",
  invalid_args: "arguments didn't match the schema",
  destructive_reroute: "needed host approval",
  destructive_tool_requires_approval: "needed host approval",
  read_only_endpoint: "endpoint is read-only",
  approval_required: "needed approval",
  auth_required: "needed authorization",
  result_too_large: "result too large to return inline",
  timeout: "timed out",
};

function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code.replaceAll("_", " ");
}

/** The one-line detail under an address: where it ran, retries, and why it stalled. */
export function activityDetail(event: UiActivityEvent): string {
  if (event.kind === "catalog_drift") return "Catalog changed";
  const parts = [SOURCE_LABELS[event.source] ?? event.source];
  if (event.approval === "tool") parts.push("approved for the rest of the run");
  if (event.approval === "call") parts.push("approved for this call");
  if (event.attempts > 1) parts.push(`${event.attempts} attempts`);
  const reasons = [event.friction, event.errorCode].filter((code): code is string => Boolean(code)).map(reasonLabel);
  // The friction class and the code often say the same thing in two
  // vocabularies ("auth_required" twice); once is enough.
  for (const reason of new Set(reasons)) parts.push(reason);
  return parts.join(" · ");
}

/**
 * A stored credential that cannot be used, by cause. The payload's `error`
 * beside it is not shown: it can carry a vault's own words.
 */
export function credentialProblemCopy(problem: string | undefined): string {
  if (problem === "credential_mismatch") return PROBLEM_COPY.credential_mismatch;
  if (problem === "credential_unreadable") {
    return "Credential status is unavailable. Retry the status check before replacing or removing the credential.";
  }
  return "The stored credential can't be used. Replace it, or remove it and add a new one.";
}

export function credentialStateLabel(credential: {
  configured: boolean | null;
  problem?: string;
  fields?: unknown[];
  lastFour?: string;
  updatedAt?: string;
}): string {
  if (credential.configured === null || credential.problem === "credential_unreadable") return "unavailable";
  if (!credential.configured) return "not configured";
  const masked = "configured";
  return credential.updatedAt ? `${masked} · updated ${formatDate(credential.updatedAt)}` : masked;
}

/** Gate copy for each browser-auth shape, so the sign-in state is never a blank page. */
export function gateCopy(kind: string, signedIn: boolean): string {
  if (kind === "cloudflare-access") {
    return "Checking Cloudflare Access identity failed. Retry to check whether this browser can open operator pages.";
  }
  if (kind !== "clerk") {
    return "Paste an operator bearer token.";
  }
  return signedIn
    ? "Signed in with Clerk, but this account cannot open deployment-wide operator pages."
    : "Sign in with Clerk to open this operator page.";
}
