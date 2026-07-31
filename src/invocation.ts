import {
  recordToolActivity,
  type ActivityCallSource,
  type ActivityRequestContext,
} from "./activity.js";
import { isCallAdmissionError } from "./call-admission.js";
import {
  CatalogService,
  type CatalogResolution,
  type ResolvedCatalogTool,
} from "./catalog-service.js";
import {
  classifyCallError,
  ConnectorCallError,
  framingError,
  type AuthRecoveryMode,
  type CallErrorDetails,
} from "./errors.js";
import { unwrapMcpResult } from "./mcp-result.js";
import type { RegistryView } from "./registry.js";
import { isExplicitlyReadOnly } from "./tool-safety.js";
import type { ToolDef } from "./types.js";
import { validateToolInput } from "./validate.js";

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

function retrySafe(definition: ToolDef): boolean {
  return (
    definition.annotations?.readOnlyHint === true ||
    definition.annotations?.idempotentHint === true
  );
}

function callerCancelledDetails(): CallErrorDetails {
  return {
    code: "cancelled",
    message: "Tool call was cancelled by the caller.",
    retryable: false,
  };
}

function recoveryMode(
  registry: RegistryView,
  connector: ResolvedCatalogTool["connector"],
  baseUrl: string,
): AuthRecoveryMode {
  if (connector.startAuth) return "oauth";
  if (
    connector.credential &&
    registry.contextFor(connector.id, baseUrl).credential
  ) {
    return "operator_config";
  }
  return "unavailable";
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
  /** Optional payload-free classification derived from the processed result. */
  activityCode?: (value: T) => string | undefined;
  /**
   * Called after address/catalog/safety admission and before the first provider
   * attempt. Code mode uses it for its host-call budget.
   */
  beforeDispatch?: () => void;
}

export class InvocationFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly connector: string | undefined;
  readonly operation: string | undefined;
  readonly recovery: CallErrorDetails["recovery"];
  readonly nextAction: CallErrorDetails["nextAction"];
  readonly retry: string | undefined;

  constructor(readonly details: CallErrorDetails) {
    super(details.message);
    this.name = "InvocationFailure";
    this.code = details.code;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
    this.connector = details.connector;
    this.operation = details.operation;
    this.recovery = details.recovery;
    this.nextAction = details.nextAction;
    this.retry = details.retry;
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
    return this.invokeWithResolution(address, args, context, () =>
      this.catalog.resolveTool(
        address,
        context.requestSignal !== undefined
          ? { signal: context.requestSignal }
          : {},
      ),
    );
  }

  /**
   * Code-mode namespace dispatch preserves JavaScript-safe tool aliases while
   * still feeding the resolved catalog entry through the one invocation path.
   */
  async invokeToolAlias<T = unknown>(
    connectorId: string,
    toolAlias: string,
    aliasFor: (toolName: string) => string,
    args: unknown,
    context: InvocationContext<T>,
  ): Promise<InvocationOutcome<T>> {
    return this.invokeWithResolution(
      `${connectorId}.${toolAlias}`,
      args,
      context,
      () =>
        this.catalog.resolveToolAlias(
          connectorId,
          toolAlias,
          aliasFor,
          context.requestSignal !== undefined
            ? { signal: context.requestSignal }
            : {},
        ),
    );
  }

  private async invokeWithResolution<T>(
    address: string,
    args: unknown,
    context: InvocationContext<T>,
    resolve: () => Promise<CatalogResolution>,
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
      const target = resolved ?? activityTarget;
      const details =
        error.code === "destructive_tool_requires_approval" && target
          ? {
              ...error,
              nextAction: {
                tool: "call_destructive_tool" as const,
                arguments: {
                  address: `${target.connector.id}.${target.toolName}`,
                  args,
                },
                purpose:
                  "Ask the MCP host to approve this consequential call. Add a short reason for the human reviewer.",
              },
            }
          : error.code === "auth_required" && target
          ? {
              ...error,
              connector: target.connector.id,
              operation: `${target.connector.id}.${target.toolName}`,
              recovery: recoveryMode(
                this.registry,
                target.connector,
                this.catalog.baseUrl,
              ),
              nextAction: {
                tool: "authorize_connector" as const,
                arguments: { connector: target.connector.id },
                operatorHandoff:
                  "Give the URL and instructions it returns to the operator.",
              },
              retry:
                `Retry ${target.connector.id}.${target.toolName} after ` +
                "the operator completes recovery.",
            }
          : error.code === "invalid_args" && error.validation && target
            ? {
                ...error,
                connector: target.connector.id,
                operation: `${target.connector.id}.${target.toolName}`,
                nextAction: {
                  tool: "search_tools" as const,
                  arguments: {
                    query: target.toolName,
                    connector: target.connector.id,
                    includeSchemas: "compact" as const,
                  },
                  purpose:
                    "Inspect the current input shape if the validation findings are not sufficient.",
                },
                retry:
                  `Correct the listed arguments and retry ` +
                  `${target.connector.id}.${target.toolName}.`,
              }
          : error;
      record(
        details.code === "timeout"
          ? "timeout"
          : details.code === "cancelled"
            ? "cancelled"
            : "error",
        details.code,
      );
      return {
        ok: false,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
        ...(resolved ? { resolved } : {}),
        error: details,
      };
    };

    const resolution = await resolve();
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
        // Recorded HERE rather than inside the registry's catalog fetch because
        // a cache hit that avoids a live listTools call records nothing — it is
        // not evidence of health. Success stays what it has always been: an
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
      const canonicalAddress = `${resolved.connector.id}.${resolved.toolName}`;
      return failed(
        framingError(
          "destructive_tool_requires_approval",
          `Tool "${canonicalAddress}" is not explicitly read-only. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
        ),
      );
    }

    // Remote MCP tools advertise their input schema in the catalog. Validate
    // against that same request-local definition before admission or provider
    // dispatch, so a predictable mismatch stays structured instead of being
    // flattened into provider-specific error prose. Unsupported schemas retain
    // validateToolInput's fail-open behavior and reach the downstream normally.
    if (
      resolved.connector.kind === "mcp" &&
      resolved.definition.inputSchema
    ) {
      const invalid = validateToolInput(
        resolved.definition.inputSchema,
        args ?? {},
        {
          address: `${resolved.connector.id}.${resolved.toolName}`,
          logger: this.registry.contextFor(
            resolved.connector.id,
            this.catalog.baseUrl,
            this.catalog.requestScope,
          ).logger,
        },
      );
      if (invalid) return failed(classifyCallError(invalid));
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
            ...(context.requestSignal !== undefined
              ? { signal: context.requestSignal }
              : {}),
          });
        } finally {
          admissionMs += Date.now() - admissionStarted;
        }
        const connectorContext = this.registry.contextFor(
          resolved.connector.id,
          this.catalog.baseUrl,
          this.catalog.requestScope,
          {
            ...(controller?.signal !== undefined
              ? { signal: controller.signal }
              : {}),
            ...(context.timeoutMs !== undefined
              ? { timeoutMs: context.timeoutMs }
              : {}),
          },
        );
        if (resolved.connector.credential && !connectorContext.credential) {
          throw new ConnectorCallError(
            "auth_required",
            "Operator-managed credential storage is not configured. Call " +
              `authorize_connector({ connector: "${resolved.connector.id}" }).`,
          );
        }
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
      record("success", context.activityCode?.(value));
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
