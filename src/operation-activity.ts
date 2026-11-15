// The root graph calls the optional recorder, never the /activity implementation.
import { Cause, Effect, Exit } from "effect";
import { InvocationFailure } from "./invocation-failure.js";
import { ExecutorAdmissionError } from "./executor-admission.js";
import { DiscoveryPolicyError } from "./catalog-service.js";
import { classificationCode, classifyCallError } from "./errors.js";
import { usesCallerIdentity } from "./connector-caller.js";
import type {
  ActivityEventInput,
  ActivityOperation,
  ActivityRequestContext,
  OperationRecordInput,
} from "./activity.js";
import type { RegistryView } from "./registry.js";

export interface OperationActivityOptions {
  counts?: () => NonNullable<ActivityOperation["hostCalls"]>;
  writes?: () => NonNullable<ActivityOperation["writes"]>;
  source?: "execute_read_code" | undefined;
  /** A terminal budget stop is recorded even when operation history is off. */
  budgetStopped?: () => boolean;
}

export function operationActivity<A, E, R>(
  context: ActivityRequestContext | undefined,
  registry: RegistryView,
  name: ActivityOperation["name"],
  work: Effect.Effect<A, E, R>,
  options: OperationActivityOptions = {},
): Effect.Effect<A, E, R> {
  const { counts, writes, source, budgetStopped } = options;
  if (!context?.recordOperation && !(budgetStopped && context?.recordTool)) return work;
  return Effect.suspend(() => {
    const started = performance.now();
    const connectors = registry.listConnectors();
    // Human operations stay owner-only, including discovery of private catalogs.
    let personal = Boolean(context.principalActor);
    try {
      personal ||= connectors.some(
        (connector) =>
          connector.authScope === "personal" ||
          !connector.staticTools ||
          usesCallerIdentity(connector) ||
          connector.describe?.().auth?.mode === "request",
      );
    } catch {
      personal = true;
    }
    return work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const stopped = budgetStopped?.() === true;
          if (!context.recordOperation && !stopped) return;
          const result = Exit.isSuccess(exit)
            ? (exit.value as { isError?: boolean; structuredContent?: { error?: { code?: unknown } } })
            : undefined;
          const failed = stopped || Exit.isFailure(exit) || result?.isError === true;
          const interrupted = Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason);
          const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          const errorCode = stopped
            ? "budget_exceeded"
            : interrupted
              ? "cancelled"
              : classificationCode(
                  Exit.isFailure(exit)
                    ? failure instanceof InvocationFailure ||
                      failure instanceof ExecutorAdmissionError ||
                      failure instanceof DiscoveryPolicyError
                      ? failure.code
                      : classifyCallError(failure).code
                    : result?.structuredContent?.error?.code,
                );
          try {
            // Result pages already measure their payload. Other operations have no
            // reusable measurement: never serialize discovery or media for telemetry.
            const page =
              name === "result" && Exit.isSuccess(exit)
                ? (exit.value as { bytes?: unknown; structuredContent?: { bytes?: unknown } } | undefined)
                : undefined;
            const bytes = page?.structuredContent?.bytes ?? page?.bytes;
            const resultBytes =
              typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
            const input: OperationRecordInput = {
              operation: {
                name,
                connectors: connectors.map((connector) => connector.id),
                personal,
                ...(counts ? { hostCalls: counts() } : {}),
                ...(writes ? { writes: writes() } : {}),
              },
              ...(source ? { source } : {}),
              durationMs: performance.now() - started,
              resultBytes,
              outcome: !failed
                ? "success"
                : errorCode === "timeout"
                  ? "timeout"
                  : errorCode === "cancelled" || errorCode === "executor_cancelled"
                    ? "cancelled"
                    : "error",
              errorCode,
            };
            if (context.recordOperation) context.recordOperation(context, input);
            else {
              const event = operationEvent(input);
              if (event) context.recordTool!(context, event);
            }
          } catch {
            /* Optional recording cannot replace the operation's result. */
          }
        }),
      ),
    );
  });
}

/** The payload-free row for one operation; undefined when its metadata fails the check. */
export function operationEvent(input: OperationRecordInput): ActivityEventInput | undefined {
  const operation = checkedActivityOperation(input.operation);
  if (!operation) return undefined;
  const connectorId = operation.connectors.length === 1 ? operation.connectors[0]! : "$operation";
  return {
    kind: "operation",
    operation,
    connectorId,
    toolName: operation.name,
    address: `${connectorId}.${operation.name}`,
    source: input.source ?? "execute_code",
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.resultBytes !== undefined ? { resultBytes: input.resultBytes } : {}),
    attempts: 1,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(operation.personal ? { privateCatalog: true } : {}),
  };
}

const countsValid = (counts: object | undefined, keys: readonly string[]) =>
  !counts ||
  keys.every((key) => {
    const n = (counts as Record<string, unknown>)[key];
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  });
const HOST_CALL_KEYS = ["attempted", "admitted", "succeeded", "failed"] as const;
const WRITE_KEYS = ["succeeded", "failed", "unknown"] as const;

const OPERATION_NAMES = new Set(["search", "describe", "result", "skill", "program", "authorize"]);
export function checkedActivityOperation(value: unknown): ActivityOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as ActivityOperation;
  if (
    !OPERATION_NAMES.has(input.name) ||
    typeof input.personal !== "boolean" ||
    !Array.isArray(input.connectors) ||
    input.connectors.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
  )
    return undefined;
  const counts = input.hostCalls;
  const writes = input.writes;
  if (!countsValid(counts, HOST_CALL_KEYS) || !countsValid(writes, WRITE_KEYS)) return undefined;
  return {
    name: input.name,
    connectors: [...new Set(input.connectors)],
    personal: input.personal,
    ...(counts
      ? {
          hostCalls: {
            attempted: counts.attempted,
            admitted: counts.admitted,
            succeeded: counts.succeeded,
            failed: counts.failed,
          },
        }
      : {}),
    ...(writes ? { writes: { succeeded: writes.succeeded, failed: writes.failed, unknown: writes.unknown } } : {}),
  };
}
