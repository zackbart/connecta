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
  | "connections"
  | "activity"
  | "artifacts"
  | "artifact";

/** Pages the nav lists. A single artifact is reached from the library, not the nav. */
export const OPERATOR_PAGES: readonly OperatorPage[] = [
  "connections",
  "activity",
  "artifacts",
];

export const PAGE_META: Readonly<
  Record<OperatorPage, { path: string; label: string }>
> = {
  connections: { path: "/", label: "Connections" },
  activity: { path: "/activity", label: "Activity" },
  artifacts: { path: "/artifacts", label: "Artifacts" },
  artifact: { path: "/artifacts", label: "Artifact" },
};

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
 * What the notices for an OAuth action and a credential Test say. Each of
 * those actions reaches a downstream, and a downstream's refusal can quote the
 * secret it was sent — so these notices are fixed sentences chosen by outcome,
 * and no text the server sent back is ever one of them. The route logs the
 * downstream's words on the host; the fix prompt beside a failure is keyed off
 * the same outcome.
 */
export type DownstreamAction = "oauth_disconnect" | "oauth_reconnect" | "credential_test";

const REFUSED_COPY: Readonly<Record<DownstreamAction, string>> = {
  oauth_disconnect:
    "OAuth disconnect failed. If the downstream refused it, the deployment's log has its reply.",
  oauth_reconnect:
    "OAuth authorization could not restart. If the downstream refused it, the deployment's log has its reply.",
  credential_test: "The credential test could not run.",
};

/** The route's answer to a finished OAuth action. Its state picks the sentence. */
export function oauthDoneNotice(
  action: "oauth_disconnect" | "oauth_reconnect",
  answer: { state?: unknown } | null,
): Notice {
  if (action === "oauth_disconnect") {
    return info("OAuth disconnected. Restart authorization when you are ready to reconnect.");
  }
  return info(
    answer?.state === "ok"
      ? "OAuth reconnected."
      : "Authorization restarted. Open the authorization link to reconnect.",
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
        "Credential test failed: the downstream rejected the stored credential, or the test could not reach it. The deployment's log has the downstream's reply.",
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
 * A remote collection's four states, named once so every page spells them the
 * same way. `idle` is "nobody has asked yet" and is what makes a re-entered
 * page fetch again after an identity change.
 */
type LoadPhase = "idle" | "loading" | "ready" | "error";

export interface OperatorState {
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
   * Element id the next render should focus. A rebuilt page has no stable node
   * to hand focus to from an event handler, so the request travels through
   * state and the shell spends it once the new markup exists.
   */
  pendingFocus: string | null;
  data: UiData | null;
  connectorFilter: string;
  oauthNotice: Notice | null;
  /** Connector id whose OAuth mutation is in flight. */
  oauthBusy: string | null;
  credentialNotice: Notice | null;
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
    pendingFocus: null,
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
    oauthBusy: null,
    credentialNotice: null,
    credentialEditing: null,
    credentialBusy: null,
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
    pendingFocus: null,
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
    credentialEditing: null,
    credentialNotice: null,
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

export function connectorStatusLabel(status: string): string {
  if (status === "loading") return "Loading details";
  if (status === "ok") return "Connected";
  if (status === "auth_required") return "Authorization needed";
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
  attention: number;
  unavailable: number;
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
    unavailable: 0,
    tools: 0,
    drifting: 0,
  };
  for (const connector of connectors) {
    if (connector.status === "ok") summary.connected += 1;
    else if (connector.status === "auth_required") summary.attention += 1;
    else if (connector.status !== "loading") summary.unavailable += 1;
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
    ...(summary.unavailable
      ? [{ text: `${summary.unavailable} unavailable`, tone: "danger" as Tone }]
      : []),
    { text: toolCountLabel(summary.tools), tone: "neutral" as Tone },
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
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString();
}

export function actorLabel(actor?: UiActivityActor): string {
  if (!actor?.kind) return "unknown";
  if (actor.label) return `${actor.kind} · ${actor.label}`;
  return actor.id ? `${actor.kind} · ${actor.id}` : actor.kind;
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
  if (events.length === 0) return "Arguments and results are never stored.";
  const tools = new Set(events.map((event) => event.address)).size;
  return `${events.length} loaded call${events.length === 1 ? "" : "s"} · ${tools} tool${
    tools === 1 ? "" : "s"
  } · no arguments or results stored`;
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

/** The one-line detail under an address: source, retries, and friction. */
export function activityDetail(event: UiActivityEvent): string {
  const parts = [event.source];
  if (event.approval === "tool") parts.push("approved for the rest of the run");
  if (event.approval === "call") parts.push("approved for this call");
  if (event.attempts > 1) parts.push(`${event.attempts} attempts`);
  if (event.friction) parts.push(event.friction);
  // The friction class and the code coincide for auth_required and
  // result_too_large. Printing "· auth_required · auth_required" says nothing
  // twice, so the coarse class stands in for both when they agree.
  if (event.errorCode && event.errorCode !== event.friction) {
    parts.push(event.errorCode);
  }
  return parts.join(" · ");
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
