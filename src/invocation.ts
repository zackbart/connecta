import {
  recordToolActivity,
  type ActivityCallSource,
  type ActivityRequestContext,
  type AgentFriction,
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
  echoedCallArgs,
  framingError,
  type AuthRecoveryMode,
  type CallErrorDetails,
} from "./errors.js";
import { unwrapMcpResult } from "./mcp-result.js";
import { splitAddress, type RegistryView } from "./registry.js";
import { isExplicitlyReadOnly } from "./tool-safety.js";
import { sleep, withDeadline } from "./timeout.js";
import type { ToolDef } from "./types.js";
import { validateToolInput } from "./validate.js";

function defined<T extends object>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

async function timed<T>(
  bucket: (elapsed: number) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    bucket(Date.now() - started);
  }
}

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
   * Caller-owned result policy. MCP applies result paging here; code mode
   * normally accepts the already-unwrapped value unchanged.
   */
  processResult?: (
    value: unknown,
    resolved: ResolvedCatalogTool,
  ) => T | Promise<T>;
  /**
   * Optional payload-free friction class derived from a *successful* result —
   * today only an oversized one that had to be paged. It is deliberately not an
   * `errorCode`: the call succeeded, and a consumer that keys its dashboards on
   * "has an error code" must not count a truncation as a failure.
   */
  activityFriction?: (value: T) => AgentFriction | undefined;
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
    const options = defined({ signal: context.requestSignal });
    return this.invokeWithResolution(address, args, context, () =>
      this.catalog.resolveTool(address, options),
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
    const options = defined({ signal: context.requestSignal });
    return this.invokeWithResolution(
      `${connectorId}.${toolAlias}`,
      args,
      context,
      () =>
        this.catalog.resolveToolAlias(
          connectorId,
          toolAlias,
          aliasFor,
          options,
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
    // The address as written, used for activity when resolution never reached
    // a connector. Only its two halves are recorded — the same fields activity
    // has always carried — so no new class of payload enters the log.
    const attempted = splitAddress(address);
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
      classification: { errorCode?: string; friction?: AgentFriction } = {},
    ) => {
      const identity = activityTarget
        ? {
            connectorId: activityTarget.connector.id,
            toolName: activityTarget.toolName,
          }
        : attempted;
      if (!identity) return;
      recordToolActivity(this.activity, {
        connectorId: identity.connectorId,
        toolName: identity.toolName,
        address: `${identity.connectorId}.${identity.toolName}`,
        source: context.source,
        outcome,
        durationMs: Date.now() - started,
        attempts,
        ...defined({
          errorCode: classification.errorCode,
          friction: classification.friction,
        }),
      });
    };
    const enrich = (
      error: CallErrorDetails,
      target: typeof activityTarget,
    ): CallErrorDetails => {
      if (!target) return error;
      switch (error.code) {
        case "destructive_tool_requires_approval": {
          const echoed = echoedCallArgs(args);
          return {
              ...error,
              nextAction: {
                tool: "call_destructive_tool" as const,
                arguments: {
                  address: `${target.connector.id}.${target.toolName}`,
                  ...echoed,
                },
                purpose:
                  "Ask the MCP host to approve this consequential call. " +
                  ("args" in echoed
                    ? "Re-send these arguments and add a short reason for the human reviewer."
                    : "Re-send the arguments you just sent — they are too large to echo back — and add a short reason for the human reviewer."),
              },
            };
        }
        case "auth_required":
          return {
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
            };
        case "invalid_args":
          if (!error.validation) return error;
          return {
                ...error,
                connector: target.connector.id,
                operation: `${target.connector.id}.${target.toolName}`,
                nextAction: this.catalog.searchRecovery(
                  {
                    query: target.toolName,
                    connector: target.connector.id,
                  },
                  "Inspect the current input shape if the validation findings are not sufficient.",
                ),
                retry:
                  `Correct the listed arguments and retry ` +
                  `${target.connector.id}.${target.toolName}.`,
              };
        default:
          return error;
      }
    };
    const failed = (error: CallErrorDetails): InvocationOutcome<T> => {
      const diagnostics = timing();
      const details = enrich(error, resolved ?? activityTarget);
      record(
        details.code === "timeout"
          ? "timeout"
          : details.code === "cancelled"
            ? "cancelled"
            : "error",
        { errorCode: details.code },
      );
      return {
        ok: false,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
        ...defined({ resolved }),
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
      if (resolution.cause && context.requestSignal?.aborted) {
        return failed(callerCancelledDetails());
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
      return failed(
        error instanceof InvocationFailure
          ? error.details
          : classifyCallError(error),
      );
    }

    const maxRetries = Math.min(
      2,
      Math.max(0, Math.trunc(context.maxRetries ?? 0)),
    );
    let result: unknown;
    let observedResult: unknown;
    while (true) {
      attempts++;
      let permit: Awaited<ReturnType<RegistryView["admitCall"]>> | undefined;
      let attemptError: unknown;
      let attemptFailed = false;
      try {
        permit = await timed(
          (elapsed) => { admissionMs += elapsed; },
          () => this.registry.admitCall(resolved.connector.id, {
            toolName: resolved.toolName,
            args: args ?? {},
            ...defined({ signal: context.requestSignal }),
          }),
        );
        const raw = await timed(
          (elapsed) => { connectorMs += elapsed; },
          () => {
            const call = (callSignal?: AbortSignal) => {
              const connectorContext = this.registry.contextFor(
                resolved.connector.id,
                this.catalog.baseUrl,
                this.catalog.requestScope,
                defined({ signal: callSignal, timeoutMs: context.timeoutMs }),
              );
              if (
                resolved.connector.credential &&
                !connectorContext.credential
              ) {
                throw new ConnectorCallError(
                  "auth_required",
                  "Operator-managed credential storage is not configured. Call " +
                    `authorize_connector({ connector: "${resolved.connector.id}" }).`,
                );
              }
              // Cancellation can arrive during admission or context construction.
              if (callSignal?.aborted) throw callSignal.reason;
              return resolved.connector.callTool(
                resolved.toolName,
                args ?? {},
                connectorContext,
              );
            };
            if (!context.timeoutMs && !context.requestSignal) return call();
            return withDeadline(call, {
              ...defined({
                timeoutMs: context.timeoutMs,
                signal: context.requestSignal,
              }),
              timeoutError: new ConnectorCallError(
                "timeout",
                `Tool call timed out after ${context.timeoutMs}ms`,
              ),
            });
          },
        );
        // isError is checked here for BOTH result shapes so every adapter
        // reports the same downstream-failure wording, and the throw lands
        // inside the attempt where it stays retry-eligible and feeds health.
        assertRawMcpSuccess(resolved.connector.kind, raw);
        observedResult = unwrapMcpResult(resolved.connector.kind, raw);
        result = context.unwrapResult ? observedResult : raw;
      } catch (error) {
        attemptFailed = true;
        attemptError = error;
      } finally {
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
            const completed = await timed(
              (elapsed) => { backoffMs += elapsed; },
              () => sleep(wait, context.requestSignal),
            );
            if (!completed) return failed(callerCancelledDetails());
            continue;
          }
          // The reported window is longer than the engine will park a
          // synchronous request for. Fall through to failure with
          // retryAfterMs reported verbatim so the agent can re-issue.
        }
        return failed(details);
      }
      break;
    }

    try {
      const value = await timed(
        (elapsed) => { resultProcessingMs += elapsed; },
        async () => {
          const processed = context.processResult
            ? await context.processResult(result, resolved)
            : (result as T);
          try {
            this.registry.observeOutputShape(
              resolved.connector.id,
              resolved.definition,
              observedResult,
            );
          } catch {
            // Shape learning is advisory. It cannot change a completed call.
          }
          return processed;
        },
      );
      const diagnostics = timing();
      const friction = context.activityFriction?.(value);
      record("success", friction ? { friction } : {});
      return {
        ok: true,
        value,
        resolved,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
      };
    } catch (error) {
      return failed(
        framingError(
          "result_processing_failed",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}
