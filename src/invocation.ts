import { Cause, Effect, Exit, type Scope } from "effect";
import {
  type ActivityCallSource,
  type ActivityRequestContext,
  type AgentFriction,
} from "./activity.js";
import {
  isCallAdmissionError,
  type CallAdmissionPermit,
} from "./call-admission.js";
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
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { isExplicitlyReadOnly } from "./tool-safety.js";
import { validateToolInput } from "./validate.js";

function defined<T extends object>(
  values: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** Add the effect's wall time to `bucket` however it ends, interruption included. */
export function timed<A, E, R>(
  bucket: (elapsed: number) => void,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const started = Date.now();
    return Effect.ensuring(
      effect,
      Effect.sync(() => bucket(Date.now() - started)),
    );
  });
}

/**
 * The connector's call permit, owned by the enclosing Scope.
 *
 * Admission goes through `registry.admitCall`, a Promise, on purpose. The
 * permit queue is shared by every request in the isolate, and a queued
 * waiter is resumed from inside the request that released the slot. Were
 * this fiber to wait on the controller's Effect program itself
 * (`acquireCallScoped`), it would be resumed there and run this call's
 * downstream I/O in the releasing request, which workerd refuses. Awaiting
 * admitCall's promise resumes it in its own request instead.
 *
 * The wait stays interruptible, so a deadline ends it. A permit granted just
 * as the wait was interrupted still arrives, later, and is released on
 * arrival rather than holding its slot forever.
 */
function admitted(
  registry: RegistryView,
  target: ResolvedCatalogTool,
  args: unknown,
  signal: AbortSignal | undefined,
): Effect.Effect<CallAdmissionPermit, unknown, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.suspend(() => {
      const pending = registry.admitCall(target.connector.id, {
        toolName: target.toolName,
        args: args ?? {},
        ...defined({ signal }),
      });
      return Effect.tryPromise({ try: () => pending, catch: (error) => error })
        .pipe(Effect.onInterrupt(() => Effect.sync(() => {
          pending.then((permit) => permit.release(), () => {});
        })));
    }),
    (permit) => Effect.sync(() => permit.release()),
    { interruptible: true },
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

/**
 * A downstream MCP tool answered with `isError`. Classified exactly as the
 * plain `Error` it used to be — same message, same heuristics — and marked so
 * a write's outcome can tell "the service said no" from "nobody answered".
 */
class DownstreamToolError extends Error {}

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
  throw new DownstreamToolError(
    boundedEchoText(mcpResult.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("") || "Downstream tool call failed"),
  );
}

/**
 * Whether a failed attempt carries an answer from the other side: a typed
 * `ConnectorCallError` (a connector classifies what it was told) or a
 * downstream `isError`. An untyped throw is a transport or programming
 * failure, and says nothing about whether the call landed.
 */
function answeredFailure(error: unknown): boolean {
  return error instanceof ConnectorCallError ||
    error instanceof DownstreamToolError;
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
  /**
   * `Connector.callTool` was actually invoked. `attempts` counts an admission
   * attempt, which is not the same thing: a call refused at admission, or
   * cancelled while queued, reached nothing downstream.
   */
  dispatched: boolean;
}

export type InvocationOutcome<T> =
  | (InvocationBase & { ok: true; value: T; resolved: ResolvedCatalogTool })
  | (InvocationBase & {
      ok: false;
      error: CallErrorDetails;
      /**
       * The dispatched attempt failed with an answer from the other side (a
       * typed connector error or a downstream `isError`) rather than with
       * silence. Absent when nothing was dispatched.
       */
      answered?: boolean;
    });

/**
 * What a write gate decided about one consequential call. A dispatch goes on
 * to admission and the connector; a refusal ends the call with `error`.
 * `activity` says how the refusal is recorded: as an ordinary failed attempt
 * (the default), as the payload-free `paused` event a pause leaves, or not at
 * all — a call refused only because its run already stopped is not an attempt.
 */
export type WriteGateDecision =
  | { kind: "dispatch" }
  | {
      kind: "refuse";
      error: CallErrorDetails;
      activity?: "paused" | "none";
    };

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
   * attempt. Code mode uses it to mark a read's gate decision as made.
   */
  beforeDispatch?: () => void;
  /**
   * Decides a call that is not explicitly read-only, in place of the flat
   * `destructive_tool_requires_approval` refusal. Only code mode with
   * resumable writes supplies one. It runs after argument validation — a
   * human is never asked to approve arguments the schema already rejects —
   * and before admission, so a pause costs no permit.
   */
  writeGate?: (
    target: ResolvedCatalogTool,
    args: unknown,
  ) => Effect.Effect<WriteGateDecision>;
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
 *
 * One call is one fiber: resolve, refuse or validate, admit, dispatch, then
 * process the result, with every way the call can go wrong turned into an
 * outcome. Only a throw while recording that outcome, or a bug, rejects
 * `invoke`.
 */
export class InvocationService {
  constructor(
    private readonly registry: RegistryView,
    private readonly catalog: CatalogService,
    private readonly activity?: ActivityRequestContext,
  ) {}

  invoke<T = unknown>(
    address: string,
    args: unknown,
    context: InvocationContext<T>,
  ): Promise<InvocationOutcome<T>> {
    return runEdge(this.pipeline(address, args, context));
  }

  /**
   * `invoke` without the Promise, for a caller already running a fiber —
   * code mode's host calls yield it rather than crossing a second edge. It
   * never fails: every outcome, refusals included, is its success value.
   */
  pipeline<T>(
    address: string,
    args: unknown,
    context: InvocationContext<T>,
  ): Effect.Effect<InvocationOutcome<T>> {
    return Effect.gen({ self: this }, function* () {
      const started = Date.now();
      let catalogMs = 0;
      let admissionMs = 0;
      let connectorMs = 0;
      let resultProcessingMs = 0;
      let attempts = 0;
      let dispatchedToConnector = false;
      let answered = false;
      // How a write gate's refusal is recorded; see WriteGateDecision.
      let gateActivity: "paused" | "none" | undefined;
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
        outcome: "success" | "error" | "timeout" | "cancelled" | "paused",
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
        const outcome = (): InvocationOutcome<T> => ({
          ok: false,
          durationMs: Date.now() - started,
          attempts,
          timing: diagnostics,
          ...defined({ resolved }),
          dispatched: dispatchedToConnector,
          ...(dispatchedToConnector ? { answered } : {}),
          error: details,
        });
        // A pause is not a failure: it leaves one payload-free `paused` event
        // naming the call that waits, and nothing in the operator's log. A call
        // refused only because its run had already stopped leaves neither.
        if (gateActivity === "none") return outcome();
        if (gateActivity === "paused") {
          record("paused");
          return outcome();
        }
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
              // Sanitized transport diagnostics (origin and errno only, #539).
              ...(details.details ? { details: details.details } : {}),
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
        return outcome();
      };

      if (context.requestSignal?.aborted) {
        // Preserve the cancelled admission-attempt count without starting discovery.
        attempts = 1;
        return failed(callerCancelledDetails());
      }
      let result: unknown;
      let observedResult: unknown;
      // Everything up to the downstream result: resolution, the safety and
      // schema refusals, admission, and the one attempt. A refusal is its
      // success value. Its failure is an abort reason or something nobody
      // expected, and a throw anywhere in it — a defect, to Effect — is
      // classified like a failure, as the async body this replaced did.
      const dispatch = (
        callSignal?: AbortSignal,
      ): Effect.Effect<CallErrorDetails | undefined, unknown> =>
        Effect.gen({ self: this }, function* () {
          const resolution = yield* this.catalog.resolve(
            address, defined({ signal: callSignal }),
          );
          catalogMs += resolution.catalogMs;
          if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
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

          const consequential =
            !isExplicitlyReadOnly(target.definition) && !context.allowDestructive;
          if (consequential && !context.writeGate) {
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

          if (consequential && context.writeGate) {
            const decision = yield* context.writeGate(target, args ?? {});
            if (decision.kind === "refuse") {
              gateActivity = decision.activity;
              return decision.error;
            }
          }

          try {
            context.beforeDispatch?.();
          } catch (error) {
            return error instanceof InvocationFailure
              ? error.details
              : classifyCallError(error);
          }

          if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
          attempts = 1;
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
            dispatchedToConnector = true;
            return target.connector.callTool(
              target.toolName,
              args ?? {},
              connectorContext,
            );
          };
          // The permit belongs to this scope, so success, failure, and the
          // deadline's interruption all release it. Interruption stops the
          // wait instead of waiting for the connector, so an uncooperative one
          // cannot hold its permit past the deadline.
          const attempt = yield* Effect.exit(Effect.scoped(
            Effect.gen({ self: this }, function* () {
              yield* timed(
                (elapsed) => { admissionMs += elapsed; },
                admitted(this.registry, target, args, callSignal),
              );
              const raw = yield* timed(
                (elapsed) => { connectorMs += elapsed; },
                Effect.tryPromise({
                  try: () => Promise.resolve(call()),
                  catch: (error) => error,
                }),
              );
              // isError is checked here for BOTH result shapes so every adapter
              // reports the same downstream-failure wording, and the throw lands
              // inside the attempt where it feeds health.
              assertRawMcpSuccess(target.connector.kind, raw);
              return { raw, observed: unwrapMcpResult(target.connector.kind, raw) };
            }),
          ));
          if (Exit.isFailure(attempt)) {
            if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
            const attemptError = Cause.squash(attempt.cause);
            answered = answeredFailure(attemptError);
            return isCallerCancellation(attemptError, context.requestSignal)
              ? callerCancelledDetails()
              : classifyCallError(attemptError);
          }
          observedResult = attempt.value.observed;
          result = context.unwrapResult ? observedResult : attempt.value.raw;
          return undefined;
        });

      // One deadline owns discovery, queue admission, and provider dispatch.
      // Expiry interrupts dispatch wherever it is, so nothing it started runs
      // on afterwards, and only this fiber records the outcome: a late
      // cancellation cannot append a second activity event.
      const dispatched = yield* Effect.exit(
        context.timeoutMs || context.requestSignal
          ? withDeadlineEffect(dispatch, {
              ...defined({
                timeoutMs: context.timeoutMs,
                signal: context.requestSignal,
              }),
              timeoutError: new ConnectorCallError(
                "timeout", `Tool call timed out after ${context.timeoutMs}ms`,
              ),
            })
          : dispatch(),
      );
      if (Exit.isFailure(dispatched)) {
        return failed(context.requestSignal?.aborted
          ? callerCancelledDetails()
          : classifyCallError(Cause.squash(dispatched.cause)));
      }
      if (dispatched.value) return failed(dispatched.value);
      // A dispatch that returned no refusal resolved a concrete tool.
      const completed = resolved;
      if (!completed) {
        return yield* Effect.die(
          new Error("Invocation completed without a resolved tool"),
        );
      }

      const processResult = context.processResult;
      const processing: Effect.Effect<T, unknown> = processResult
        ? Effect.tryPromise({
            try: () => Promise.resolve(processResult(result, completed)) as Promise<T>,
            catch: (error) => error,
          })
        : Effect.succeed(result as T);
      const processed = yield* Effect.exit(timed(
        (elapsed) => { resultProcessingMs += elapsed; },
        Effect.tap(processing, () => Effect.sync(() => {
          try {
            this.registry.observeOutputShape(
              completed.connector.id,
              completed.definition,
              observedResult,
            );
          } catch {
            // Shape learning is advisory. It cannot change a completed call.
          }
        })),
      ));
      // Past this point the call has happened, so nothing may invite a retry.
      const unprocessable = () =>
        failed(
          framingError(
            "result_processing_failed",
            "The downstream call completed, but its result could not be processed. Do not repeat the call to recover its result.",
          ),
        );
      if (Exit.isFailure(processed)) return unprocessable();
      try {
        const value = processed.value;
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
          dispatched: dispatchedToConnector,
        };
      } catch {
        return unprocessable();
      }
    });
  }
}
