import { boundedEchoText } from "./errors.js";
import type { Logger } from "./types.js";

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

/** Two names and the dot between them. */
const MAX_ACTIVITY_ADDRESS_BYTES = MAX_ACTIVITY_NAME_BYTES * 2 + 1;

export type ActivityCallSource =
  | "call_tool"
  | "call_destructive_tool"
  | "batch_call"
  | "execute_code";

export type ActivityOutcome =
  | "success"
  | "error"
  | "timeout"
  | "cancelled";

export type AgentFriction =
  | "tool_not_found"
  | "schema_retry"
  | "destructive_reroute"
  | "auth_required"
  | "result_too_large";

/** Coarse recovery class derived without inspecting payloads or error prose. */
export function agentFrictionForCode(
  code: string | undefined,
): AgentFriction | undefined {
  switch (code) {
    case "unknown_address":
    case "unknown_tool":
    case "ambiguous_tool_alias":
      return "tool_not_found";
    case "invalid_args":
      return "schema_retry";
    case "destructive_tool_requires_approval":
      return "destructive_reroute";
    case "auth_required":
      return "auth_required";
    case "result_too_large":
      return "result_too_large";
    default:
      return undefined;
  }
}

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
export interface ToolCallActivityEvent {
  schemaVersion: 1;
  id: string;
  occurredAt: string;
  requestId: string;
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
  serverName: string;
  serverVersion: string;
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
}

/** Optional read side used by Connecta's authenticated Activity UI. */
export interface ActivityReader {
  list(options: { cursor?: string; limit: number }): Promise<ActivityPage>;
}

export interface ActivityStore extends ActivitySink {
  list?: ActivityReader["list"];
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

/** Request-scoped context shared by direct, batch, and code-mode call paths. */
export interface ActivityRequestContext {
  sink: ActivitySink;
  actor: ActivityActor;
  requestId: string;
  serverInfo: { name: string; version: string };
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
  | "errorCode"
  | "friction"
>;

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
  const friction = input.friction ?? agentFrictionForCode(input.errorCode);
  const event: ToolCallActivityEvent = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    requestId: context.requestId,
    actor: context.actor,
    connectorId: boundedEchoText(input.connectorId, MAX_ACTIVITY_NAME_BYTES),
    toolName: boundedEchoText(input.toolName, MAX_ACTIVITY_NAME_BYTES),
    address: boundedEchoText(input.address, MAX_ACTIVITY_ADDRESS_BYTES),
    source: input.source,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    attempts: Math.max(1, Math.trunc(input.attempts)),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(friction ? { friction } : {}),
    serverName: context.serverInfo.name,
    serverVersion: context.serverInfo.version,
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
      context.logger.warn("[connecta] activity record failed", error);
    });
    if (context.defer) context.defer(pending);
  } catch (error) {
    context.logger.warn("[connecta] activity record failed", error);
  }
}
