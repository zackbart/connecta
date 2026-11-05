// The root graph calls the optional recorder, never the /activity implementation.
import { Cause, Effect, Exit } from "effect";
import { InvocationFailure } from "./invocation-failure.js";
import { ExecutorAdmissionError } from "./executor-admission.js";
import { DiscoveryPolicyError } from "./catalog-service.js";
import { classificationCode, classifyCallError } from "./errors.js";
import { usesCallerIdentity } from "./connector-caller.js";
import type { ActivityOperation, ActivityRequestContext } from "./activity.js";
import type { RegistryView } from "./registry.js";

export function operationActivity<A, E, R>(
  context: ActivityRequestContext | undefined,
  registry: RegistryView,
  name: ActivityOperation["name"],
  work: Effect.Effect<A, E, R>,
  counts?: () => NonNullable<ActivityOperation["hostCalls"]>,
  source?: "execute_read_code",
): Effect.Effect<A, E, R> {
  if (!context?.recordOperation) return work;
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
          const result = Exit.isSuccess(exit)
            ? (exit.value as { isError?: boolean; structuredContent?: { error?: { code?: unknown } } })
            : undefined;
          const failed = Exit.isFailure(exit) || result?.isError === true;
          const interrupted = Exit.isFailure(exit) && exit.cause.reasons.some(Cause.isInterruptReason);
          const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          const errorCode = interrupted
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
            context.recordOperation!(context, {
              operation: {
                name,
                connectors: connectors.map((connector) => connector.id),
                personal,
                ...(counts ? { hostCalls: counts() } : {}),
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
            });
          } catch {
            /* Optional recording cannot replace the operation's result. */
          }
        }),
      ),
    );
  });
}

const OPERATION_NAMES = new Set(["search", "describe", "result", "skill", "program"]);
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
  if (
    counts &&
    [counts.attempted, counts.admitted, counts.succeeded, counts.failed].some(
      (n) => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0,
    )
  )
    return undefined;
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
  };
}
