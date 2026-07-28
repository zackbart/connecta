import {
  recordToolActivity,
  type ActivityCallSource,
  type ActivityRequestContext,
} from "./activity.js";
import { isCallAdmissionError } from "./call-admission.js";
import {
  CatalogService,
  type ResolvedCatalogTool,
} from "./catalog-service.js";
import {
  classifyCallError,
  ConnectorCallError,
  messageLooksRetryable,
  type CallErrorDetails,
} from "./errors.js";
import { unwrapMcpResult } from "./mcp-result.js";
import type { RegistryView } from "./registry.js";
import type { ToolDef } from "./types.js";

/**
 * The longest the engine will park a synchronous inbound request in *waiting
 * alone*. The engine already treats ~15 s as the outer bound of one reasonable
 * connector call (EXECUTE_HOST_CALL_TIMEOUT_MS), so sleeping for minutes trades
 * a fast, informative failure for a hung one. A connector-reported window this
 * long isn't truncated — it's declined (see `retryBackoffMs`) and reported
 * verbatim as `error.retryAfterMs`, so the agent, which can afford to wait,
 * decides when to re-issue.
 */
export const MAX_RETRY_BACKOFF_MS = 10_000;

/**
 * How long to wait before the next attempt, or `undefined` for "don't retry".
 *
 * A connector that read a `Retry-After` header knows the window exactly, so it
 * is honoured **exactly or not at all**: truncating an exponential *guess* is
 * harmless, but truncating a *known* window means deliberately retrying inside
 * a rate limit — the harm this channel exists to prevent. A window longer than
 * `MAX_RETRY_BACKOFF_MS` therefore declines the retry rather than shortening
 * it. (`retryAfterMs` is normalized non-negative, so `0` means "retry now".)
 * Connectors that report no window keep the historical exponential guess.
 *
 * Waits are per attempt, matching the per-attempt `timeoutMs` race in
 * `InvocationService.invoke`. Exported for direct testing.
 */
export function retryBackoffMs(
  attempt: number,
  retryAfterMs: number | undefined,
): number | undefined {
  if (retryAfterMs === undefined) {
    return Math.min(250 * 2 ** (attempt - 1), 1_000);
  }
  return retryAfterMs <= MAX_RETRY_BACKOFF_MS ? retryAfterMs : undefined;
}

/** The one fail-closed admission predicate for every invocation adapter. */
export function isExplicitlyReadOnly(definition: ToolDef): boolean {
  return (
    definition.annotations?.readOnlyHint === true &&
    definition.annotations?.destructiveHint !== true
  );
}

function retrySafe(definition: ToolDef): boolean {
  return (
    definition.annotations?.readOnlyHint === true ||
    definition.annotations?.idempotentHint === true
  );
}

function framingError(code: string, message: string): CallErrorDetails {
  return { code, message, retryable: messageLooksRetryable(message) };
}

function callerCancelledDetails(): CallErrorDetails {
  return {
    code: "cancelled",
    message: "Tool call was cancelled by the caller.",
    retryable: false,
  };
}

function isCallerCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.aborted === true ||
    (isCallAdmissionError(error) && error.admissionKind === "cancelled")
  );
}

function assertRawMcpSuccess(
  kind: ResolvedCatalogTool["connector"]["kind"],
  result: unknown,
): void {
  if (kind !== "mcp" || result == null || typeof result !== "object") return;
  const mcpResult = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (!mcpResult.isError) return;
  throw new Error(
    mcpResult.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("") || "Downstream tool call failed",
  );
}

export interface InvocationTiming {
  catalogMs: number;
  admissionMs: number;
  connectorMs: number;
  backoffMs: number;
  resultProcessingMs: number;
  totalMs: number;
}

interface InvocationBase {
  durationMs: number;
  attempts: number;
  timing: InvocationTiming;
  resolved?: ResolvedCatalogTool;
}

export type InvocationOutcome<T> =
  | (InvocationBase & { ok: true; value: T; resolved: ResolvedCatalogTool })
  | (InvocationBase & { ok: false; error: CallErrorDetails });

export interface InvocationContext<T> {
  source: ActivityCallSource;
  allowDestructive?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  requestSignal?: AbortSignal;
  unwrapResult?: boolean;
  /**
   * Caller-owned result policy. MCP passes fields + paging here; code mode
   * normally accepts the already-unwrapped value unchanged.
   */
  processResult?: (
    value: unknown,
    resolved: ResolvedCatalogTool,
  ) => T | Promise<T>;
  /**
   * Called after address/catalog/safety admission and before the first provider
   * attempt. Code mode uses it for its host-call budget.
   */
  beforeDispatch?: () => void;
}

export class InvocationFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(readonly details: CallErrorDetails) {
    super(details.message);
    this.name = "InvocationFailure";
    this.code = details.code;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
  }
}

/**
 * Shared downstream invocation engine. Address/catalog resolution is delegated
 * to the request-local CatalogService; every remaining call semantic lives
 * here so MCP and code mode cannot drift independently.
 */
export class InvocationService {
  constructor(
    private readonly registry: RegistryView,
    private readonly catalog: CatalogService,
    private readonly activity?: ActivityRequestContext,
  ) {}

  async invoke<T = unknown>(
    address: string,
    args: unknown,
    context: InvocationContext<T>,
  ): Promise<InvocationOutcome<T>> {
    const started = Date.now();
    let catalogMs = 0;
    let admissionMs = 0;
    let connectorMs = 0;
    let backoffMs = 0;
    let resultProcessingMs = 0;
    let attempts = 0;
    let resolved: ResolvedCatalogTool | undefined;
    let activityTarget:
      | Pick<ResolvedCatalogTool, "connector" | "toolName">
      | undefined;
    const timing = (): InvocationTiming => ({
      catalogMs,
      admissionMs,
      connectorMs,
      backoffMs,
      resultProcessingMs,
      totalMs: Date.now() - started,
    });
    const record = (
      outcome: "success" | "error" | "timeout" | "cancelled",
      errorCode?: string,
    ) => {
      if (!activityTarget) return;
      recordToolActivity(this.activity, {
        connectorId: activityTarget.connector.id,
        toolName: activityTarget.toolName,
        address: `${activityTarget.connector.id}.${activityTarget.toolName}`,
        source: context.source,
        outcome,
        durationMs: Date.now() - started,
        attempts,
        ...(errorCode ? { errorCode } : {}),
      });
    };
    const failed = (error: CallErrorDetails): InvocationOutcome<T> => {
      const diagnostics = timing();
      record(
        error.code === "timeout"
          ? "timeout"
          : error.code === "cancelled"
            ? "cancelled"
            : "error",
        error.code,
      );
      return {
        ok: false,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
        ...(resolved ? { resolved } : {}),
        error,
      };
    };

    const resolution = await this.catalog.resolveTool(address, {
      signal: context.requestSignal,
    });
    catalogMs += resolution.catalogMs;
    if (!resolution.ok) {
      if (resolution.connector && resolution.toolName) {
        activityTarget = {
          connector: resolution.connector,
          toolName: resolution.toolName,
        };
      }
      if (resolution.cause && resolution.connector) {
        if (context.requestSignal?.aborted) {
          return failed(callerCancelledDetails());
        }
        // A connector whose catalog cannot be fetched is as unusable as one
        // whose execution fails, so it feeds health accounting the same way the
        // attempt catch below does — otherwise a connector every call fails
        // against (a revoked downstream grant, say) still reads clean from the
        // cheap `list_connectors({ probe: false })` signal.
        //
        // Recorded HERE rather than inside the registry's catalog fetch on
        // purpose: `registry` is this connection's VIEW, so a toolkit-scoped
        // session records into its own log as well as the deployment-wide one,
        // which `Registry.refreshTools` could not reach. A cache hit that
        // avoids a live listTools call records nothing either way — it is not
        // evidence of health, and success stays what it has always been: an
        // actual downstream call that returned.
        this.registry.recordFailure(
          resolution.connector.id,
          Date.now() - started,
          resolution.cause,
        );
      }
      return failed(resolution.error);
    }
    resolved = resolution.resolved;
    activityTarget = resolved;

    if (!isExplicitlyReadOnly(resolved.definition) && !context.allowDestructive) {
      return failed(
        framingError(
          "destructive_tool_requires_approval",
          `Tool "${address}" is not explicitly read-only. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
        ),
      );
    }

    try {
      context.beforeDispatch?.();
    } catch (error) {
      return failed(classifyCallError(error));
    }

    const maxRetries = Math.min(
      2,
      Math.max(0, Math.trunc(context.maxRetries ?? 0)),
    );
    let result: unknown;
    while (true) {
      attempts++;
      let permit: Awaited<ReturnType<RegistryView["admitCall"]>> | undefined;
      const controller =
        context.timeoutMs || context.requestSignal
          ? new AbortController()
          : undefined;
      const forwardAbort = () =>
        controller?.abort(context.requestSignal?.reason);
      if (context.requestSignal?.aborted) forwardAbort();
      else {
        context.requestSignal?.addEventListener("abort", forwardAbort, {
          once: true,
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let attemptError: unknown;
      let attemptFailed = false;
      try {
        const admissionStarted = Date.now();
        try {
          permit = await this.registry.admitCall(resolved.connector.id, {
            toolName: resolved.toolName,
            args: args ?? {},
            signal: context.requestSignal,
          });
        } finally {
          admissionMs += Date.now() - admissionStarted;
        }
        const connectorContext = this.registry.contextFor(
          resolved.connector.id,
          this.catalog.baseUrl,
          this.catalog.requestScope,
          { signal: controller?.signal, timeoutMs: context.timeoutMs },
        );
        let rejectCancelled!: (reason: unknown) => void;
        const cancelled = controller
          ? new Promise<never>((_, reject) => {
              rejectCancelled = reject;
            })
          : undefined;
        onAbort = () => {
          rejectCancelled(
            controller?.signal.reason ??
              new ConnectorCallError("timeout", "Tool call was cancelled"),
          );
        };
        controller?.signal.addEventListener("abort", onAbort, { once: true });
        if (controller?.signal.aborted) onAbort();
        if (controller?.signal.aborted) await cancelled;
        if (context.timeoutMs) {
          timer = setTimeout(() => {
            controller?.abort(
              new ConnectorCallError(
                "timeout",
                `Tool call timed out after ${context.timeoutMs}ms`,
              ),
            );
          }, context.timeoutMs);
        }
        const connectorStarted = Date.now();
        try {
          const pending = resolved.connector.callTool(
            resolved.toolName,
            args ?? {},
            connectorContext,
          );
          const raw = cancelled
            ? await Promise.race([pending, cancelled])
            : await pending;
          // isError is checked here for BOTH result shapes so every adapter
          // reports the same downstream-failure wording, and the throw lands
          // inside the attempt where it stays retry-eligible and feeds health.
          assertRawMcpSuccess(resolved.connector.kind, raw);
          result = context.unwrapResult
            ? unwrapMcpResult(resolved.connector.kind, raw)
            : raw;
        } finally {
          connectorMs += Date.now() - connectorStarted;
        }
      } catch (error) {
        attemptFailed = true;
        attemptError = error;
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) {
          controller?.signal.removeEventListener("abort", onAbort);
        }
        context.requestSignal?.removeEventListener("abort", forwardAbort);
        permit?.release();
      }

      if (attemptFailed) {
        const callerCancelled = isCallerCancellation(
          attemptError,
          context.requestSignal,
        );
        const details = callerCancelled
          ? callerCancelledDetails()
          : classifyCallError(attemptError);
        if (
          !callerCancelled &&
          attempts <= maxRetries &&
          retrySafe(resolved.definition) &&
          details.retryable
        ) {
          const wait = retryBackoffMs(attempts, details.retryAfterMs);
          if (wait !== undefined) {
            const backoffStarted = Date.now();
            if (wait > 0) {
              const completed = await new Promise<boolean>((resolve) => {
                let settled = false;
                const finish = (value: boolean) => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  context.requestSignal?.removeEventListener("abort", cancel);
                  resolve(value);
                };
                const timer = setTimeout(() => finish(true), wait);
                const cancel = () => finish(false);
                context.requestSignal?.addEventListener("abort", cancel, {
                  once: true,
                });
                if (context.requestSignal?.aborted) cancel();
              });
              backoffMs += Date.now() - backoffStarted;
              if (!completed) return failed(callerCancelledDetails());
            } else {
              backoffMs += Date.now() - backoffStarted;
            }
            continue;
          }
          // The reported window is longer than the engine will park a
          // synchronous request for. Fall through to failure with
          // retryAfterMs reported verbatim so the agent can re-issue.
        }
        if (!callerCancelled && !isCallAdmissionError(attemptError)) {
          this.registry.recordFailure(
            resolved.connector.id,
            Date.now() - started,
            attemptError,
          );
        }
        return failed(details);
      }
      break;
    }

    this.registry.recordSuccess(resolved.connector.id, Date.now() - started);
    const processingStarted = Date.now();
    try {
      const value = context.processResult
        ? await context.processResult(result, resolved)
        : (result as T);
      resultProcessingMs += Date.now() - processingStarted;
      const diagnostics = timing();
      record("success");
      return {
        ok: true,
        value,
        resolved,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
      };
    } catch (error) {
      resultProcessingMs += Date.now() - processingStarted;
      return failed(
        framingError(
          "result_processing_failed",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}
