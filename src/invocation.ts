import {
  type ActivityCallSource,
  type ActivityRequestContext,
  type AgentFriction,
} from "./activity.js";
import { isCallAdmissionError } from "./call-admission.js";
import {
  CatalogService,
  type ResolvedCatalogTool,
} from "./catalog-service.js";
import {
  boundedEchoText,
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
import { withDeadline } from "./timeout.js";
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
    registry.credentialUiAvailable() && connector.credential &&
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
    boundedEchoText(mcpResult.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("") || "Downstream tool call failed"),
  );
}

export interface InvocationTiming {
  catalogMs: number;
  admissionMs: number;
  connectorMs: number;
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
    const started = Date.now();
    let catalogMs = 0;
    let admissionMs = 0;
    let connectorMs = 0;
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
      this.activity?.recordTool?.(this.activity, {
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
      const target = resolved ?? activityTarget;
      const details = enrich(error, target);
      // Activity rows stay payload-free by construction; the operator's log is
      // where the downstream reason goes, bounded and without arguments.
      if (target && details.code !== "destructive_tool_requires_approval") {
        this.registry
          .contextFor(
            target.connector.id,
            this.catalog.baseUrl,
            this.catalog.requestScope,
          )
          .logger.warn("[connecta] call failed", {
            connector: target.connector.id,
            tool: target.toolName,
            source: context.source,
            code: details.code,
            attempts,
            durationMs: Date.now() - started,
            message: String(details.message ?? "").slice(0, 300),
          });
      }
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

    if (context.requestSignal?.aborted) {
      // Preserve the cancelled admission-attempt count without starting discovery.
      attempts = 1;
      return failed(callerCancelledDetails());
    }
    let result: unknown;
    let observedResult: unknown;
    // One deadline owns discovery, queue admission, and provider dispatch.
    // Only the caller of this function records the final outcome, so a late
    // cancellation cannot append a second activity event after the deadline.
    const dispatch = async (
      callSignal?: AbortSignal,
    ): Promise<CallErrorDetails | undefined> => {
      const resolution = await this.catalog.resolveTool(
        address, defined({ signal: callSignal }),
      );
      catalogMs += resolution.catalogMs;
      if (callSignal?.aborted) throw callSignal.reason;
      if (!resolution.ok) {
        if (resolution.connector && resolution.toolName) {
          activityTarget = {
            connector: resolution.connector,
            toolName: resolution.toolName,
          };
        }
        if (resolution.cause && context.requestSignal?.aborted) {
          return callerCancelledDetails();
        }
        return resolution.error;
      }
      const target = resolution.resolved;
      resolved = target;
      activityTarget = target;

      if (!isExplicitlyReadOnly(target.definition) && !context.allowDestructive) {
        const canonicalAddress = `${target.connector.id}.${target.toolName}`;
        return framingError(
          "destructive_tool_requires_approval",
          `Tool "${canonicalAddress}" is not explicitly read-only. Invoke it through call_destructive_tool so the MCP host can request explicit approval.`,
        );
      }

      // Remote MCP tools advertise their input schema in the catalog. Validate
      // against that same request-local definition before admission or provider
      // dispatch, so a predictable mismatch stays structured instead of being
      // flattened into provider-specific error prose. Unsupported schemas retain
      // validateToolInput's fail-open behavior and reach the downstream normally.
      if (
        target.connector.kind === "mcp" &&
        target.definition.inputSchema
      ) {
        const invalid = validateToolInput(
          target.definition.inputSchema,
          args ?? {},
          {
            address: `${target.connector.id}.${target.toolName}`,
            logger: this.registry.contextFor(
              target.connector.id,
              this.catalog.baseUrl,
              this.catalog.requestScope,
            ).logger,
          },
        );
        if (invalid) return classifyCallError(invalid);
      }

      try {
        context.beforeDispatch?.();
      } catch (error) {
        return error instanceof InvocationFailure
          ? error.details
          : classifyCallError(error);
      }

      if (callSignal?.aborted) throw callSignal.reason;
      attempts = 1;
      let permit: Awaited<ReturnType<RegistryView["admitCall"]>> | undefined;
      let attemptError: unknown;
      let attemptFailed = false;
      try {
        permit = await timed(
          (elapsed) => { admissionMs += elapsed; },
          () => this.registry.admitCall(target.connector.id, {
            toolName: target.toolName,
            args: args ?? {},
            ...defined({ signal: callSignal }),
          }),
        );
        const raw = await timed(
          (elapsed) => { connectorMs += elapsed; },
          () => {
            const call = () => {
              const connectorContext = this.registry.contextFor(
                target.connector.id,
                this.catalog.baseUrl,
                this.catalog.requestScope,
                defined({ signal: callSignal, timeoutMs: context.timeoutMs }),
              );
              if (
                target.connector.credential &&
                !connectorContext.credential
              ) {
                throw new ConnectorCallError(
                  "auth_required",
                  "Operator-managed credential storage is not configured. Call " +
                    `authorize_connector({ connector: "${target.connector.id}" }).`,
                );
              }
              // Cancellation can arrive during admission or context construction.
              if (callSignal?.aborted) throw callSignal.reason;
              return target.connector.callTool(
                target.toolName,
                args ?? {},
                connectorContext,
              );
            };
            // Race cancellation here too, so an uncooperative connector cannot
            // retain its admission permit after the enclosing deadline expires.
            return callSignal
              ? withDeadline(call, {
                  signal: callSignal,
                  timeoutError: new ConnectorCallError("timeout", "Tool call timed out"),
                })
              : call();
          },
        );
        // isError is checked here for BOTH result shapes so every adapter
        // reports the same downstream-failure wording, and the throw lands
        // inside the attempt where it feeds health.
        assertRawMcpSuccess(target.connector.kind, raw);
        observedResult = unwrapMcpResult(target.connector.kind, raw);
        result = context.unwrapResult ? observedResult : raw;
      } catch (error) {
        attemptFailed = true;
        attemptError = error;
      } finally {
        permit?.release();
      }

      if (attemptFailed) {
        if (callSignal?.aborted) throw callSignal.reason;
        const callerCancelled = isCallerCancellation(
          attemptError,
          context.requestSignal,
        );
        const details = callerCancelled
          ? callerCancelledDetails()
          : classifyCallError(attemptError);
        return details;
      }

      return undefined;
    };
    try {
      const error = context.timeoutMs || context.requestSignal
        ? await withDeadline(dispatch, {
            ...defined({
              timeoutMs: context.timeoutMs,
              signal: context.requestSignal,
            }),
            timeoutError: new ConnectorCallError(
              "timeout", `Tool call timed out after ${context.timeoutMs}ms`,
            ),
          })
        : await dispatch();
      if (error) return failed(error);
    } catch (error) {
      return failed(context.requestSignal?.aborted
        ? callerCancelledDetails()
        : classifyCallError(error));
    }
    // A dispatch that returned no refusal resolved a concrete tool.
    const completed = resolved;
    if (!completed) throw new Error("Invocation completed without a resolved tool");

    try {
      const value = await timed(
        (elapsed) => { resultProcessingMs += elapsed; },
        async () => {
          const processed = context.processResult
            ? await context.processResult(result, completed)
            : (result as T);
          try {
            this.registry.observeOutputShape(
              completed.connector.id,
              completed.definition,
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
        resolved: completed,
        durationMs: Date.now() - started,
        attempts,
        timing: diagnostics,
      };
    } catch {
      return failed(
        framingError(
          "result_processing_failed",
          "The downstream call completed, but its result could not be processed. Do not repeat the call to recover its result.",
        ),
      );
    }
  }
}
