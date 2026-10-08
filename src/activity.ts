import { CONNECTA_VERSION } from "./version.js";
import { assertKnownOptions, keys, optionsOf } from "./config-schema.js";
import { routeActivity } from "./routes/activity.js";
import type { ActivityModule } from "./module-contracts.js";
import { boundedEchoText, classificationCode, type ClassificationCode } from "./errors.js";
import { failureRecord, logFailure } from "./operator-record.js";
import type { CatalogDriftCounts, Logger } from "./types.js";

/**
 * How long an identity field may be before the store stops believing it.
 *
 * `connectorId` and `toolName` are ordinarily operator- and connector-authored,
 * and 128 bytes is far past any real one. But an address that resolved to
 * nothing is recorded *as written*, which puts a caller-authored string in both
 * fields — and "payload-free by construction" has to mean the event type has
 * nowhere to put a payload, not merely that connecta declines to. A 40 KB
 * invented connector id is a payload wearing an id's clothing.
 *
 * Clamped rather than dropped: the invented id is precisely what an operator
 * needs to see, and its first 128 bytes identify the mistake as well as all
 * 40,000 would. The `…` marker keeps a clamped value from reading as a real one.
 */
const MAX_ACTIVITY_NAME_BYTES = 128;

/**
 * Client facts use bounded ASCII grammars, never truncation or escaping.
 * Names are 1 to 64 characters: alphanumeric or @ first (scoped package names
 * such as `@modelcontextprotocol/inspector`), then alphanumerics, space, dot,
 * underscore, @, /, + or -. Versions are 1 to 32 characters: alphanumeric
 * first, then alphanumerics, dot, underscore, + or -. Prototype-key names are
 * withheld too. The end assertion rejects even a final CR/LF, unlike `$`.
 */
const CLIENT_FACT_GRAMMARS = {
  name: /^[A-Za-z0-9@][A-Za-z0-9 ._@/+-]{0,63}(?![\s\S])/,
  version: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}(?![\s\S])/,
};
const RESERVED_CLIENT_FACTS = new Set(["__proto__", "constructor", "prototype"]);

/** One policy for the record builder, SQL write/read boundaries, and UI. */
export function activityClientFact(value: unknown, field: "name" | "version"): string | undefined {
  return typeof value === "string" && !RESERVED_CLIENT_FACTS.has(value) && CLIENT_FACT_GRAMMARS[field].test(value)
    ? value
    : undefined;
}

/** Stored package versions use a bounded release-version grammar, including prereleases. */
export function activityPackageVersion(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 128 &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/.test(value)
    ? value : undefined;
}

/** Two names and the dot between them. */
const MAX_ACTIVITY_ADDRESS_BYTES = MAX_ACTIVITY_NAME_BYTES * 2 + 1;

export type ActivityCallSource =
  | "catalog_refresh"
  | "call_tool"
  | "call_destructive_tool"
  // Read-only history. Nothing emits `batch_call` since issue #273 removed the
  // tool, but activity storage is append-only: rows written by older
  // deployments are still read back — the D1 example maps a stored row straight
  // into this type — and an operator's timeline should not have to lie about
  // where a call came from. Never widen this member back into a live source.
  | "batch_call"
  | "execute_code"
  // Read-only history, like `batch_call`: a resumed program's approval and
  // the calls its replay made live, until issue #672 removed
  // `resume_execution`. Older rows still carry it. Never emit it again.
  | "resume_execution";

export type ActivityOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancelled"
  // Read-only history since issue #672 removed program pauses: a program
  // that stopped at a write to wait (`paused`), and the `resume_execution`
  // that approved it (`approved`). Older rows still carry them; a reader
  // renders them and nothing emits them.
  | "paused"
  | "approved";

/** Read-only history: how much one `resume_execution` approved (#672). */
export type ActivityApproval = "call" | "tool";

export type AgentFriction =
  | "tool_not_found"
  | "schema_retry"
  | "destructive_reroute"
  | "auth_required"
  | "result_too_large";

import { agentFrictionForCode } from "./activity-friction.js";
export { agentFrictionForCode } from "./activity-friction.js";
/**
 * Authenticated identity attached to an activity event. `id` is intentionally
 * optional: open deployments and shared bearer tokens cannot honestly identify
 * a person.
 */
export interface ActivityActor {
  kind: string;
  id?: string;
  /**
   * Stable, non-secret identity-directory namespace supplied by the admitting
   * auth provider. It lets authorized reads resolve ids through the same
   * provider rather than another provider that happens to share `kind`.
   */
  namespace?: string;
}

/**
 * Privacy-minimal history of one resolved downstream connector call.
 *
 * Arguments, results, generated code, search text, and raw errors are excluded
 * by construction. Deployments that need a safe human summary can add a
 * separate, explicit connector-level feature later.
 */
export interface ActivityCatalogChange {
  kind: "catalog_changed";
  addedTools: number;
  removedTools: number;
  changedTools: number;
}

/** Integer metadata is checked at every write and read boundary. */
export function activityCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function activityBehaviorFacts(event: {
  classification?: unknown; resultBytes?: unknown; kind?: unknown; drift?: unknown; pool?: unknown;
}): Pick<ToolCallActivityEvent, "classification" | "resultBytes" | "kind" | "drift" | "pool"> {
  const classification = event.classification === "read" || event.classification === "write" ? event.classification : undefined;
  const resultBytes = activityCount(event.resultBytes);
  const change = event.drift as Partial<ActivityCatalogChange> | undefined;
  const drift = event.kind === "catalog_drift" && change?.kind === "catalog_changed" &&
    activityCount(change.addedTools) !== undefined && activityCount(change.removedTools) !== undefined && activityCount(change.changedTools) !== undefined
    ? { kind: "catalog_changed" as const, addedTools: change.addedTools!, removedTools: change.removedTools!, changedTools: change.changedTools! } : undefined;
  // Pool names come from matched deployment config, whose grammar has no size
  // ceiling. Invalid stored scope stays withheld rather than becoming root scope.
  const pool = event.pool === undefined || event.pool === null ? undefined
    : typeof event.pool === "string" && /^[a-z0-9_-]+(?![\s\S])/.test(event.pool) ? event.pool : "<withheld>";
  return {
    ...(classification !== undefined ? { classification } : {}),
    ...(resultBytes !== undefined ? { resultBytes } : {}),
    ...(drift ? { kind: "catalog_drift", drift } : {}),
    ...(pool !== undefined ? { pool } : {}),
  };
}

export interface ToolCallActivityEvent {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  requestId: string;
  /** Absent on legacy tool rows. Catalog changes use the same paging envelope. */
  kind?: "catalog_drift";
  drift?: ActivityCatalogChange;
  /** The final registry verdict captured when resolution succeeded. */
  classification?: "read" | "write";
  /** UTF-8 bytes of the downstream value before result paging or truncation. */
  resultBytes?: number;
  pool?: string;
  actor: ActivityActor;
  connectorId: string;
  toolName: string;
  address: string;
  source: ActivityCallSource;
  outcome: ActivityOutcome;
  durationMs: number;
  attempts: number;
  /** Set only when the call actually failed; a truncated success has none. */
  errorCode?: string;
  /**
   * Payload-free recovery class. Usually derived from `errorCode`, but it can
   * also stand alone: a result too large to return inline is friction for the
   * agent while remaining an `outcome: "success"` call with no error code.
   */
  friction?: AgentFriction;
  /**
   * Read-only history: set only on an `approved` event written before issue
   * #672, the scope the approval covered. An enum, like everything else
   * here — the approved arguments were never recorded.
   */
  approval?: ActivityApproval;
  /** Real build version. Absent only in history written before telemetry existed. */
  packageVersion?: string;
  serverName: string;
  serverVersion: string;
  /** Self-declared client identity checked by activityClientFact; invalid facts are absent. */
  clientName?: string;
  clientVersion?: string;
  deploymentId?: string;
}

/**
 * A downstream catalog moved away from the manifest a release reviewed.
 *
 * Four integers and an id: the type has nowhere to put a tool name, a schema,
 * an argument, a result, or a downstream error string, which is the same
 * construction guarantee `ToolCallActivityEvent` makes. Which tool drifted is
 * deliberately absent — the runtime reports that something did, and the
 * maintainer-run check with a live catalog in front of it names names
 * ([#343](https://github.com/zackbart/connecta/issues/343),
 * [#351](https://github.com/zackbart/connecta/issues/351)).
 */
export interface CatalogDriftActivityEvent extends CatalogDriftCounts {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  connectorId: string;
  /** Real build version. Absent only in history written before telemetry existed. */
  packageVersion?: string;
  serverName: string;
  serverVersion: string;
  /** Self-declared client facts, when an explicit client context exists. */
  clientName?: string;
  clientVersion?: string;
  deploymentId?: string;
}

export interface ActivityPage {
  events: ToolCallActivityEvent[];
  nextCursor?: string;
}

/** Display-only actor returned by the authenticated activity read API. */
export interface ActivityReadActor extends ActivityActor {
  label?: string;
}

export type ActivityReadEvent = Omit<ToolCallActivityEvent, "actor"> & {
  actor: ActivityReadActor;
};

export interface ActivityReadPage {
  events: ActivityReadEvent[];
  nextCursor?: string;
}

/** Write-only deployments can implement only this small, vendor-neutral seam. */
export interface ActivitySink {
  record(event: ToolCallActivityEvent): void | Promise<void>;
  /**
   * Optional catalog-drift channel. Optional rather than a widened `record`,
   * because a store written before drift existed already decided what a row
   * looks like: a sink that does not implement this simply never hears about
   * drift, and the operator still reads the same counts from connector status.
   */
  recordCatalogDrift?(event: CatalogDriftActivityEvent): void | Promise<void>;
}

/** Optional read side used by Connecta's authenticated Activity UI. */
export interface ActivityReader {
  list(options: { cursor?: string; limit: number }): Promise<ActivityPage>;
}

export interface ActivityStore extends ActivitySink {
  list?: ActivityReader["list"];
  /**
   * The adapter and its retention, for `Connecta.describeConfig()`. Kinds
   * other than the shipped `"d1"` and `"sqlite"` are described as `"custom"`.
   */
  describe?(): { kind: string; retentionDays?: number };
}

/** Reader implementations throw this for an opaque cursor they cannot decode. */
export class InvalidActivityCursorError extends Error {
  override name = "InvalidActivityCursorError";

  constructor() {
    super("invalid activity cursor");
  }
}

export type ActivityReadGate = (
  actor: ActivityActor,
) => boolean | Promise<boolean>;

/**
 * Deployment-scoped destination for drift observations. Not request-scoped:
 * a drifting catalog is something the deployment saw, not something a caller
 * did, so it carries no actor and no request id to attribute it to one.
 */
export interface CatalogDriftActivityContext {
  recordDrift?: typeof recordCatalogDriftActivity;
  recordChange?: typeof recordCatalogChangeActivity;
  defer?: (promise: Promise<unknown>) => void;
  sink: ActivitySink;
  serverInfo: { name: string; version: string };
  clientInfo?: { name: string; version: string };
  deploymentId?: string;
  logger: Logger;
}

/** Request-scoped context shared by direct, batch, and code-mode call paths. */
export interface ActivityRequestContext {
  recordTool?: typeof recordToolActivity | undefined;
  sink: ActivitySink;
  actor: ActivityActor;
  requestId: string;
  pool?: string;
  serverInfo: { name: string; version: string };
  clientInfo?: { name: string; version: string };
  deploymentId?: string;
  defer?: (promise: Promise<unknown>) => void;
  logger: Logger;
}

export type ActivityEventInput = Pick<
  ToolCallActivityEvent,
  | "connectorId"
  | "toolName"
  | "address"
  | "source"
  | "outcome"
  | "durationMs"
  | "attempts"
  | "friction"
  | "classification"
  | "resultBytes"
  | "kind"
  | "drift"
> & {
  /**
   * A code connecta assigns. Rows written by older deployments may hold
   * others, so the stored event keeps `string`; a new row never does.
   */
  errorCode?: ClassificationCode;
};

/**
 * Best-effort by design: activity storage can never change a tool result.
 * Workers attach async sinks to waitUntil; synchronous sinks such as Analytics
 * Engine complete inline; Node promises remain detached from the response.
 */
export function recordToolActivity(
  context: ActivityRequestContext | undefined,
  input: ActivityEventInput,
): void {
  if (!context) return;
  // A caller-supplied class wins because it knows something the code table
  // cannot: friction that belongs to a call which did not fail.
  // Checked here as well as by type: a handler can put any string in a
  // `ConnectorCallError`'s code, and a downstream's own code is not recorded.
  const errorCode = classificationCode(input.errorCode);
  const friction = input.friction ?? agentFrictionForCode(errorCode);
  // Re-check client grammars at the record boundary; never spread the envelope.
  const clientName = activityClientFact(context.clientInfo?.name, "name");
  const clientVersion = activityClientFact(context.clientInfo?.version, "version");
  const event: ToolCallActivityEvent = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    requestId: context.requestId,
    actor: context.actor,
    ...activityBehaviorFacts({ ...input, pool: context.pool }),
    connectorId: boundedEchoText(input.connectorId, MAX_ACTIVITY_NAME_BYTES),
    toolName: boundedEchoText(input.toolName, MAX_ACTIVITY_NAME_BYTES),
    address: boundedEchoText(input.address, MAX_ACTIVITY_ADDRESS_BYTES),
    source: input.source,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    attempts: Math.max(1, Math.trunc(input.attempts)),
    ...(errorCode ? { errorCode } : {}),
    ...(friction ? { friction } : {}),
    packageVersion: CONNECTA_VERSION,
    serverName: context.serverInfo.name,
    serverVersion: context.serverInfo.version,
    ...(clientName !== undefined ? { clientName } : {}),
    ...(clientVersion !== undefined ? { clientVersion } : {}),
    ...(context.deploymentId
      ? { deploymentId: context.deploymentId }
      : {}),
  };
  try {
    const result = context.sink.record(event);
    if (!result || typeof (result as Promise<unknown>).then !== "function") {
      return;
    }
    const pending = Promise.resolve(result).catch((error) => {
      logFailure(context.logger, "activity record failed", failureRecord({}, error));
    });
    if (context.defer) context.defer(pending);
  } catch (error) {
    logFailure(context.logger, "activity record failed", failureRecord({}, error));
  }
}

/**
 * Record one catalog-drift observation, best-effort like every other activity
 * write: a store that is down, or a sink that never implemented the channel,
 * can never change what a refresh returned to the caller who paid for it.
 */
export function recordCatalogDriftActivity(
  context: CatalogDriftActivityContext | undefined,
  input: { connectorId: string } & CatalogDriftCounts,
): void {
  if (!context?.sink.recordCatalogDrift) return;
  const clientName = activityClientFact(context.clientInfo?.name, "name");
  const clientVersion = activityClientFact(context.clientInfo?.version, "version");
  const event: CatalogDriftActivityEvent = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    connectorId: boundedEchoText(input.connectorId, MAX_ACTIVITY_NAME_BYTES),
    unclassifiedTools: input.unclassifiedTools,
    unservedTools: input.unservedTools,
    annotationConflicts: input.annotationConflicts,
    schemaChanges: input.schemaChanges,
    ...(input.droppedTools ? { droppedTools: input.droppedTools } : {}),
    packageVersion: CONNECTA_VERSION,
    serverName: context.serverInfo.name,
    serverVersion: context.serverInfo.version,
    ...(clientName !== undefined ? { clientName } : {}),
    ...(clientVersion !== undefined ? { clientVersion } : {}),
    ...(context.deploymentId ? { deploymentId: context.deploymentId } : {}),
  };
  try {
    const result = context.sink.recordCatalogDrift(event);
    if (!result || typeof (result as Promise<unknown>).then !== "function") {
      return;
    }
    void Promise.resolve(result).catch((error) => {
      logFailure(context.logger, "catalog drift record failed", failureRecord({}, error));
    });
  } catch (error) {
    logFailure(context.logger, "catalog drift record failed", failureRecord({}, error));
  }
}

/** A discrete catalog change, with no catalog names, descriptions or schemas. */
export function recordCatalogChangeActivity(
  context: CatalogDriftActivityContext | undefined,
  input: { connectorId: string; drift: ActivityCatalogChange },
  request?: ActivityRequestContext,
): void {
  if (!context) return;
  recordToolActivity(request ?? {
    ...context, actor: { kind: "system" }, requestId: crypto.randomUUID(),
  }, {
    connectorId: input.connectorId, toolName: "<catalog>", address: `${input.connectorId}.<catalog>`,
    source: "catalog_refresh", outcome: "success", durationMs: 0, attempts: 1,
    kind: "catalog_drift", drift: input.drift,
  });
}

export interface ActivityHistoryOptions {
  store: ActivityStore;
  deploymentId?: string;
  readGate?: ActivityReadGate;
}
/** Attach payload-free history without changing tool results on store failure. */
/** The closed options activityHistory() accepts; see `assertKnownOptions`. */
const ACTIVITY_HISTORY_OPTIONS = optionsOf<ActivityHistoryOptions>()(keys("store", "deploymentId", "readGate"));

export function activityHistory(options: ActivityHistoryOptions): ActivityModule {
  options = assertKnownOptions(options, "activityHistory()", ACTIVITY_HISTORY_OPTIONS);
  if (!options || typeof options.store?.record !== "function") {
    throw new Error("activityHistory.store must implement record(event)");
  }
  return {
    ...options,
    handle: routeActivity,
    recordTool: recordToolActivity,
    recordDrift: recordCatalogDriftActivity,
    recordChange: recordCatalogChangeActivity,
  };
}
