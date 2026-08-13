import type { CatalogDriftReport } from "../types.js";
import type {
  AccessTokenManagementCapability,
  CredentialManagementCapability,
  UiData,
} from "./model.js";

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
  | "credentials"
  | "tokens"
  | "activity";

export const OPERATOR_PAGES: readonly OperatorPage[] = [
  "connections",
  "credentials",
  "tokens",
  "activity",
];

export const PAGE_META: Readonly<
  Record<OperatorPage, { path: string; label: string }>
> = {
  connections: { path: "/", label: "Connections" },
  credentials: { path: "/credentials", label: "Credentials" },
  tokens: { path: "/tokens", label: "Access tokens" },
  activity: { path: "/activity", label: "Activity" },
};

export function pageForPath(path: string): OperatorPage {
  const match = OPERATOR_PAGES.find((page) => PAGE_META[page].path === path);
  return match ?? "connections";
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
}

export interface UiAccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  revokedAt?: string;
}

/** A message with the tone that decides its live region: status or alert. */
export interface Notice {
  message: string;
  tone: "info" | "error";
}

export function info(message: string): Notice {
  return { message, tone: "info" };
}

export function failure(message: string): Notice {
  return { message, tone: "error" };
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
  tokenPhase: LoadPhase;
  tokenNotice: Notice | null;
  tokens: UiAccessToken[];
  /** Shown once, never re-fetchable, and cleared by anything that navigates. */
  createdToken: string | null;
  /** Access-token id whose rename form is open. */
  tokenRenaming: string | null;
  tokenBusy: boolean;
  activityPhase: LoadPhase;
  activityNotice: Notice | null;
  activityEvents: UiActivityEvent[];
  activityCursor: string | null;
  activitySearch: string;
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
    createdToken: null,
    tokenRenaming: null,
    tokenNotice: null,
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
    return "Credential storage is not configured. Set credentials.encryptionKey before managing connector credentials here.";
  }
  return "Credential management requires an eligible Clerk operator. Bearer-authenticated sessions can inspect connections but cannot manage stored credentials.";
}

export function accessTokenUnavailableCopy(
  capability?: AccessTokenManagementCapability,
): string {
  if (capability === "not_configured") {
    return "Access tokens are not configured for this deployment. Add accessTokens to the deployment configuration to enable them.";
  }
  return "Access token management requires an eligible Clerk operator. A Bearer token can connect to MCP, but it cannot create or revoke other tokens.";
}

export function connectorStatusLabel(status: string): string {
  if (status === "ok") return "Connected";
  if (status === "auth_required") return "Authorization needed";
  return "Unavailable";
}

export function toolCountLabel(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
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

const ACTIVITY_OUTCOMES = ["success", "error", "timeout", "cancelled"];

export function activityOutcomeClass(outcome: string): string {
  return ACTIVITY_OUTCOMES.includes(outcome) ? outcome : "error";
}

/** The one-line detail under an address: source, retries, and friction. */
export function activityDetail(event: UiActivityEvent): string {
  const parts = [event.source];
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

/** Gate copy for the two inbound-auth shapes, so the sign-in state is never a blank page. */
export function gateCopy(kind: string, signedIn: boolean): string {
  if (kind !== "clerk") {
    return "Paste an operator bearer token to open this page. Nothing is requested until you do.";
  }
  return signedIn
    ? "Signed in with Clerk, but this account cannot open deployment-wide operator pages."
    : "Sign in with Clerk to open this operator page.";
}
