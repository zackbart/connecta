import type { CatalogDriftReport } from "../types.js";
import type {
  CredentialManagementCapability,
  UiArtifactRow,
  UiArtifactView,
  UiConnector,
  UiData,
  UiProblem,
  UiToolSafety,
} from "./model.js";
import type { FixPromptKind } from "./fix-prompts.js";

/**
 * Everything the operator app knows, and every rule for changing it, with no
 * DOM in sight. The components render this and nothing else, so the questions
 * that matter — what a page shows while it loads, what an identity change
 * erases, whether a value may become an href — are answered by functions a test
 * can call directly rather than by reading rendered markup back out of a
 * browser.
 */

export type OperatorPage =
  | "tokens"
  | "connections"
  | "activity"
  | "artifacts"
  | "artifact";

/** Pages the nav lists. A single artifact is reached from the library, not the nav. */
export const OPERATOR_PAGES: readonly OperatorPage[] = [
  "connections",
  "tokens",
  "activity",
  "artifacts",
];

export const PAGE_META: Readonly<
  Record<OperatorPage, { path: string; label: string }>
> = {
  tokens: { path: "/tokens", label: "Access tokens" },
  connections: { path: "/", label: "Connections" },
  activity: { path: "/activity", label: "Activity" },
  artifacts: { path: "/artifacts", label: "Artifacts" },
  artifact: { path: "/artifacts", label: "Artifact" },
};

/**
 * What each page is for, in one line under its heading — on the gate as well
 * as once signed in, so the page an operator lands on reads the same before
 * and after the session is checked.
 */
export function pageDescription(page: OperatorPage, productDescription: string): string {
  if (page === "activity") {
    return "Every connector tool call, by who made it and how it ended. Arguments and results are never stored.";
  }
  if (isArtifactPage(page)) {
    return "Pages agents published for the team. Each one keeps every version.";
  }
  return productDescription;
}

/** What the gate says while the session is checked, page by page. */
export function checkingCopy(page: OperatorPage): string {
  if (page === "artifact") return "Loading artifact…";
  if (page === "artifacts") return "Loading artifacts…";
  return "Checking your session…";
}

export function pageForPath(path: string): OperatorPage {
  if (path.startsWith("/artifacts/")) return "artifact";
  const match = OPERATOR_PAGES.find((page) => PAGE_META[page].path === path);
  return match ?? "connections";
}

/** Artifact pages load their own data and never ask `/ui/data` whether to open. */
export function isArtifactPage(page: OperatorPage): boolean {
  return page === "artifacts" || page === "artifact";
}

/**
 * Where a viewer's frame gets its page: `/artifacts/<id>` or a snapshot,
 * `/artifacts/<id>/v/<version>?d=<name>:<version>…`, mapped to its API call.
 */
export function artifactViewRequest(pathname: string, search: string): string | undefined {
  const match = /^\/artifacts\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/v\/(\d{1,9}))?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  const params = new URLSearchParams();
  if (match[2]) {
    params.set("v", match[2]);
    for (const pin of new URLSearchParams(search).getAll("d")) params.append("d", pin);
  }
  const query = params.toString();
  return `/artifacts/_api/view/${match[1]}${query ? `?${query}` : ""}`;
}

export interface UiActivityActor {
  kind?: string;
  id?: string;
  namespace?: string;
  label?: string;
}

export interface UiActivityEvent {
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
 */
export type RequestFailureKind = "session" | "forbidden" | "network" | "refused";

export interface RequestFailureFacts {
  kind: RequestFailureKind;
  status?: number | undefined;
  problem?: unknown;
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
  oauth_disconnect:
    "Disconnect didn't finish. If the service refused it, the deployment's log has its reply.",
  oauth_reconnect:
    "Authorization couldn't start. If the service refused it, the deployment's log has its reply.",
  credential_test: "The credential test couldn't run.",
};

/**
 * The route's answer to a finished OAuth action. Its state picks the sentence;
 * `opened` says whether the authorization page is already in a new tab.
 */
export function oauthDoneNotice(
  action: "oauth_disconnect" | "oauth_reconnect",
  answer: { state?: unknown } | null,
  opened = true,
): Notice {
  if (action === "oauth_disconnect") {
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
export function credentialTestNotice(
  connectorId: string,
  answer: { ok?: unknown } | null,
): Notice {
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
export function refusedNotice(
  action: DownstreamAction,
  connectorId: string,
  problem?: unknown,
): Notice {
  if (
    action === "credential_test" &&
    (problem === "credential_required" || problem === "credential_mismatch")
  ) {
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
export type ConnectorLoadFailure = "session" | "network";

export function connectorLoadFailureCopy(
  failure: ConnectorLoadFailure,
  productName: string,
): string {
  return failure === "session"
    ? "Your session wasn't accepted while loading this connector. Sign in again to see its status."
    : `Couldn't reach ${productName} to load this connector. Check your connection, then refresh it.`;
}

/** The signed-in page's answer when `/ui/data` could not be read. */
export function loadFailureCopy(
  failure: "server" | "network",
  productName: string,
): { title: string; body: string } {
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
  collection: "activity" | "artifacts" | "artifact",
  facts: RequestFailureFacts,
  productName: string,
): string {
  if (facts.kind === "network") {
    return `Couldn't reach ${productName}. Check your connection, then retry.`;
  }
  if (facts.kind === "session") return "Your session has ended. Sign in again to see this page.";
  if (facts.kind === "forbidden" || facts.status === 404) {
    if (collection === "artifact") return "There is no artifact here, or this identity can't open it.";
    return collection === "activity"
      ? "Activity isn't available to this identity."
      : "Artifacts aren't available to this identity.";
  }
  return "The deployment answered with an error. Retry in a moment; if it keeps failing, the deployment's log has the reason.";
}

/** A destructive or disruptive row action waiting for a second, in-page click. */
export interface PendingConfirm {
  connectorId: string;
  action: "oauth_disconnect" | "oauth_restart" | "credential_remove";
}

/** The confirm's question, naming the connector by its title. */
export function confirmCopy(
  action: PendingConfirm["action"],
  name: string,
): { question: string; confirm: string } {
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

export interface UiAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt?: string;
}

export function accessTokenUnavailableCopy(capability?: string): string {
  return capability === undefined
    ? "Access tokens are not configured for this deployment."
    : "Token management requires an interactive sign-in and explicit permission.";
}

export interface OperatorState {
  tokenPhase: LoadPhase;
  tokenNotice: Notice | null;
  tokens: UiAccessToken[];
  createdToken: string | null;
  tokenRenaming: string | null;
  tokenBusy: boolean;
  page: OperatorPage;
  /**
   * Bumped by every identity change. Async work captures it before awaiting and
   * throws its result away if the operator is no longer the one who asked —
   * the fence that keeps one identity's data off another identity's screen.
   */
  generation: number;
  /** `loading` until the first /ui/data answer decides gated or ready. */
  session: "loading" | "gated" | "ready";
  gate: Notice | null;
  /** True while a signed-in operator's /ui/data is in flight. */
  refreshing: boolean;
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
  artifactPhase: LoadPhase;
  artifactNotice: Notice | null;
  artifactRows: UiArtifactRow[];
  artifactCursor: string | null;
  artifactQuery: string;
  artifactArchived: boolean;
  artifactView: UiArtifactView | null;
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
    data: null,
    connectorFilter: "",
    oauthNotice: null,
    oauthNoticeFor: null,
    oauthBusy: null,
    oauthBlocked: null,
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
    tokenRenaming: null,
    tokenBusy: false,
    activityPhase: "idle" as LoadPhase,
    activityNotice: null,
    activityEvents: [],
    activityCursor: null,
    activitySearch: "",
    artifactPhase: "idle" as LoadPhase,
    artifactNotice: null,
    artifactRows: [],
    artifactCursor: null,
    artifactQuery: "",
    artifactArchived: false,
    artifactView: null,
  } satisfies Partial<OperatorState>;
}

/**
 * Drop to the gate and forget the previous operator. Bumping the generation is
 * what makes the drop stick: work already in flight for the old identity
 * resolves into a state that no longer accepts it.
 */
export function resetIdentity(
  state: OperatorState,
  gate: Notice | null = null,
): OperatorState {
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
export function withPage(
  state: OperatorState,
  page: OperatorPage,
): OperatorState {
  return {
    ...state,
    page,
    createdToken: null,
    tokenRenaming: null,
    tokenNotice: null,
    credentialEditing: null,
    credentialNotice: null,
    credentialNoticeFor: null,
    confirming: null,
  };
}

export function credentialUnavailableCopy(
  capability?: CredentialManagementCapability,
): string {
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
  if (status === "auth_required") {
    return problem === "credential_required" ? "Credential needed" : "Authorization needed";
  }
  return "Unavailable";
}

export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

/** The tone a status carries wherever it is rendered as a badge or a tile. */
export type Tone = "ok" | "warn" | "danger" | "neutral";

export function connectorStatusTone(status: string): Tone {
  if (status === "ok") return "ok";
  if (status === "auth_required") return "warn";
  if (status === "loading") return "neutral";
  return "danger";
}

/**
 * The deployment in four numbers, so the page answers "is anything wrong"
 * above the list instead of only inside it. `attention` is what an operator
 * can act on now; `unavailable` is what they cannot. A connector still loading
 * its catalog counts only toward `total`, since calling it connected or failed
 * would be a guess either way.
 */
export interface ConnectorSummary {
  total: number;
  connected: number;
  /** Waiting on authorization, whether OAuth or a secret in configuration. */
  attention: number;
  /** Waiting on a credential someone can add on this page. */
  credentials: number;
  unavailable: number;
  /** Connectors whose details have not arrived yet. */
  loading: number;
  tools: number;
  /** Connectors whose last observed catalog refresh differed from the manifest. */
  drifting: number;
}

export function summarizeConnectors(
  connectors: readonly UiConnector[],
): ConnectorSummary {
  const summary: ConnectorSummary = {
    total: connectors.length,
    connected: 0,
    attention: 0,
    credentials: 0,
    unavailable: 0,
    loading: 0,
    tools: 0,
    drifting: 0,
  };
  for (const connector of connectors) {
    if (connector.status === "ok") summary.connected += 1;
    else if (connector.status === "auth_required") {
      if (connector.problem === "credential_required") summary.credentials += 1;
      else summary.attention += 1;
    }
    else if (connector.status === "loading") summary.loading += 1;
    else summary.unavailable += 1;
    summary.tools += connector.toolCount || 0;
    if (driftState(connector.catalogDrift) === "warning") summary.drifting += 1;
  }
  return summary;
}

/**
 * The one line above the list. Connected and tool counts are always present;
 * the two counts an operator may have to act on appear only when they are not
 * zero, so a healthy deployment stays short.
 */
export function connectorSummaryParts(
  summary: ConnectorSummary,
): Array<{ text: string; tone: Tone }> {
  // Nothing has answered yet: "0 connected · 0 tools" would be a claim, and
  // a false one.
  if (summary.total > 0 && summary.loading === summary.total) {
    return [
      {
        text: `Checking ${summary.total} connector${summary.total === 1 ? "" : "s"}…`,
        tone: "neutral",
      },
    ];
  }
  return [
    { text: `${summary.connected} connected`, tone: "neutral" as Tone },
    ...(summary.attention
      ? [
          {
            text: `${summary.attention} need${summary.attention === 1 ? "s" : ""} authorization`,
            tone: "warn" as Tone,
          },
        ]
      : []),
    ...(summary.credentials
      ? [
          {
            text: `${summary.credentials} need${summary.credentials === 1 ? "s" : ""} a credential`,
            tone: "warn" as Tone,
          },
        ]
      : []),
    ...(summary.unavailable
      ? [{ text: `${summary.unavailable} unavailable`, tone: "danger" as Tone }]
      : []),
    { text: toolCountLabel(summary.tools), tone: "neutral" as Tone },
    ...(summary.loading
      ? [{ text: `${summary.loading} still loading`, tone: "neutral" as Tone }]
      : []),
  ];
}

/**
 * The badge for each call path, keyed by the server's classification so each
 * state is a row here rather than a branch in a component.
 */
export const TOOL_SAFETY_BADGE: Readonly<
  Record<UiToolSafety, { label: string; tone: Tone; title: string }>
> = {
  runs_in_programs: {
    label: "runs in programs",
    tone: "ok",
    title: "Explicitly read-only: execute_code programs may call it without asking.",
  },
  exempt: {
    label: "exempt from approval",
    tone: "neutral",
    title: "Not read-only, but this deployment's config lets programs call it without pausing. Each call still counts against the write budget and appears in activity; call_tool still refuses it.",
  },
  needs_approval: {
    label: "asks for approval",
    tone: "warn",
    title: "Not explicitly read-only: a program pauses for resume_execution, and a direct call crosses call_destructive_tool — either way the host asks first.",
  },
};

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
  oauth_required:
    "Needs OAuth authorization: no grant is stored, or the stored grant expired or was revoked.",
  credential_required:
    "Needs a credential: nothing usable is stored in its credential slot.",
  auth_required:
    "Needs authorization. Its secret lives in deployment configuration, not on this page.",
  credential_mismatch:
    "The stored credential does not match the fields this connector declares, so it cannot be used.",
  catalog_failed:
    "Connected, but its tool catalog could not be loaded, so none of its tools are served.",
};

export function problemCopy(problem: UiProblem | undefined): string | null {
  return problem ? PROBLEM_COPY[problem] ?? null : null;
}

/**
 * A problem someone can fix by authorizing is a warning, matching the amber
 * "Authorization needed" badge above it; one where something broke is an
 * error. The two used to share the red box, so the row contradicted itself.
 */
export function problemTone(problem: UiProblem): "warn" | "danger" {
  return problem === "oauth_required" ||
    problem === "credential_required" ||
    problem === "auth_required"
    ? "warn"
    : "danger";
}

/** Who owns this connector's downstream credentials, in two words. */
export function authScopeLabel(scope: UiConnector["authScope"]): string {
  return scope === "personal" ? "personal auth" : "shared auth";
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
 * The four categories, in the order an operator should read them: what the
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
];

export function driftTotal(drift?: CatalogDriftReport): number {
  if (!drift) return 0;
  return DRIFT_CATEGORIES.reduce((sum, { key }) => sum + (drift[key] || 0), 0);
}

export function driftState(drift?: CatalogDriftReport): DriftState {
  if (!drift) return "unavailable";
  return driftTotal(drift) > 0 ? "warning" : "clean";
}

/** Every category with its count, so a clean report still shows its zeros. */
export function driftCounts(
  drift?: CatalogDriftReport,
): Array<{ key: string; label: string; count: number }> {
  if (!drift) return [];
  return DRIFT_CATEGORIES.map(({ key, label }) => ({
    key,
    label,
    count: drift[key] || 0,
  }));
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
  ].some((value) => String(value ?? "").toLowerCase().includes(q));
}

export function filterActivity(
  events: UiActivityEvent[],
  query: string,
): UiActivityEvent[] {
  return events.filter((event) => activityMatches(event, query));
}

/** Counts only. What the deployment ran, never what it sent or received. */
export function activitySummary(events: UiActivityEvent[]): string {
  if (events.length === 0) return "";
  const tools = new Set(events.map((event) => event.address)).size;
  return `${events.length} loaded call${events.length === 1 ? "" : "s"} · ${tools} tool${
    tools === 1 ? "" : "s"
  }`;
}

// A pause and an approval are neither success nor failure: each gets its own
// class, and the stylesheet paints neither as an error.
const ACTIVITY_OUTCOMES = [
  "success",
  "error",
  "timeout",
  "cancelled",
  "paused",
  "approved",
];

export function activityOutcomeClass(outcome: string): string {
  return ACTIVITY_OUTCOMES.includes(outcome) ? outcome : "error";
}

/** Each outcome as a badge: a word a person reads, and a tone that is never alone. */
const OUTCOME_BADGE: Readonly<Record<string, { label: string; tone: Tone }>> = {
  success: { label: "Succeeded", tone: "ok" },
  error: { label: "Failed", tone: "danger" },
  timeout: { label: "Timed out", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  paused: { label: "Waiting for approval", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
};

export function activityOutcomeBadge(outcome: string): { label: string; tone: Tone } {
  return OUTCOME_BADGE[outcome] ?? { label: "Failed", tone: "danger" };
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  execute_code: "In a program",
  call_tool: "Direct call",
  call_destructive_tool: "Direct call, approved by the host",
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
  const parts = [SOURCE_LABELS[event.source] ?? event.source];
  if (event.approval === "tool") parts.push("approved for the rest of the run");
  if (event.approval === "call") parts.push("approved for this call");
  if (event.attempts > 1) parts.push(`${event.attempts} attempts`);
  const reasons = [event.friction, event.errorCode]
    .filter((code): code is string => Boolean(code))
    .map(reasonLabel);
  // The friction class and the code often say the same thing in two
  // vocabularies ("auth_required" twice); once is enough.
  for (const reason of new Set(reasons)) parts.push(reason);
  return parts.join(" · ");
}

/**
 * An artifact's last refresh, when it is worth a badge. Only a failure is: a
 * success is what "Current data" already says, and a superseded run is
 * nobody's concern.
 */
export function artifactRefreshBadge(
  last: { status: string } | undefined,
): { label: string; tone: Tone } | null {
  return last?.status === "failed" ? { label: "Refresh failed", tone: "danger" } : null;
}

/**
 * A stored credential that cannot be used, by cause. The payload's `error`
 * beside it is not shown: it can carry a vault's own words.
 */
export function credentialProblemCopy(problem: string | undefined): string {
  if (problem === "credential_mismatch") return PROBLEM_COPY.credential_mismatch;
  if (problem === "credential_unreadable") {
    return "The stored credential can't be read, so it can't be used. Replace it, or remove it and add a new one.";
  }
  return "The stored credential can't be used. Replace it, or remove it and add a new one.";
}

export function credentialStateLabel(credential: {
  configured: boolean;
  fields?: unknown[];
  lastFour?: string;
  updatedAt?: string;
}): string {
  if (!credential.configured) return "not configured";
  const masked = credential.fields?.length
    ? "configured"
    : `configured · ••••${credential.lastFour ?? ""}`;
  return credential.updatedAt
    ? `${masked} · updated ${formatDate(credential.updatedAt)}`
    : masked;
}

/** Gate copy for each browser-auth shape, so the sign-in state is never a blank page. */
export function gateCopy(kind: string, signedIn: boolean): string {
  if (kind === "cloudflare-access") {
    return "Cloudflare Access admitted this browser, but the current identity cannot open deployment-wide operator pages.";
  }
  if (kind !== "clerk") {
    return "Paste an operator bearer token to open this page. Nothing is requested until you do.";
  }
  return signedIn
    ? "Signed in with Clerk, but this account cannot open deployment-wide operator pages."
    : "Sign in with Clerk to open this operator page.";
}
