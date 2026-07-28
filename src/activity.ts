import type { Logger } from "./types.js";

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
  errorCode?: string;
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
  const event: ToolCallActivityEvent = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    requestId: context.requestId,
    actor: context.actor,
    connectorId: input.connectorId,
    toolName: input.toolName,
    address: input.address,
    source: input.source,
    outcome: input.outcome,
    durationMs: Math.max(0, Math.trunc(input.durationMs)),
    attempts: Math.max(1, Math.trunc(input.attempts)),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
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
