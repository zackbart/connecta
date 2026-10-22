import { withAuthorizationHandoff } from "./authorization-handoff.js";
import { hasControlCharacters } from "./tool-name.js";
import { writeRefusal } from "./tool-safety.js";
import { Cause, Effect, Exit, type Scope } from "effect";
import { type ActivityCallSource, type ActivityRequestContext, type AgentFriction } from "./activity.js";
import { CallAdmissionError, isCallAdmissionError, type CallAdmissionPermit } from "./call-admission.js";
import { CatalogService, type ResolvedCatalogTool } from "./catalog-service.js";
import {
  boundedEchoText,
  classificationCode,
  classifyCallError,
  classifyWithoutAdvice,
  ConnectorCallError,
  echoedCallArgs,
  framingError,
  keyResendAdviceOf,
  resendAdviceOf,
  withResendAdvice,
  type AuthRecoveryMode,
  type CallErrorDetails,
  type ClassificationCode,
  type KeyResendAdvice,
} from "./errors.js";
import { downstreamValue } from "./mcp-result.js";
import {
  carryFailureFacts,
  classifiedFailure,
  failureRecord,
  logFailure,
  recordedToolName,
} from "./operator-record.js";
import { splitAddress, type RegistryView } from "./registry.js";
import { runEdge, withDeadlineEffect } from "./runtime/run.js";
import { validateCatalogToolInput } from "./validate.js";
import { sentSecretsFor, sentSecretsForRequest, type SentSecrets } from "./sent-secrets.js";
import { recoveryRecord, recordRecoveryFacts } from "./call-recovery.js";
import { callFromContext, contextView, viewServices } from "./runtime/call.js";
import { chargeCallBudget } from "./runtime/call-admission.js";
import { callEntry } from "./runtime/call-entry.js";
import {
  forgetProviderFailure,
  isKnownProviderFailure,
  isSettledWrite,
  keyProtectsCall,
  knownCallFailure,
  type LogicalCall,
  knownProviderFailure,
  openLogicalCall,
} from "./provider-call.js";
import { classifyWriteOutcome, settleWrite, settleWriteResult } from "./write-outcome.js";
import {
  classificationDigest,
  recordAuthFailure,
  recordCallEntry,
  replayClassificationDigest,
  resolveInvocationAuth,
} from "./invocation-auth.js";
import {
  downstreamContinuation,
  recordDownstreamArgumentEcho,
  isDownstreamInputResult,
  assertDownstreamOutputSafe,
  type DownstreamInputResult,
} from "./downstream-input-context.js";
import { keepErrorName } from "./redaction-identity.js";

function defined<T extends object>(values: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
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
      return Effect.tryPromise({ try: () => pending, catch: (error) => error }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            pending.then(
              (permit) => permit.release(),
              () => {},
            );
          }),
        ),
      );
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
    registry.credentialUiAvailable() &&
    connector.credential &&
    registry.contextFor(connector.id, baseUrl).credential
  ) {
    return "operator_config";
  }
  return "unavailable";
}

function isCallerCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (isCallAdmissionError(error) && error.admissionKind === "cancelled");
}

/**
 * A downstream MCP tool answered with `isError`. Classified exactly as the
 * plain `Error`: untyped and non-retryable. It is a read's answer; for a
 * write it is a 2xx reply after which the handler may have applied it.
 */
class DownstreamToolError extends Error {}

function isTimeoutFailure(error: CallErrorDetails): boolean {
  const code = error.details?.code;
  return (
    error.code === "timeout" ||
    (error.code === "unavailable" &&
      (code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT") === true))
  );
}

function assertRawMcpSuccess(kind: ResolvedCatalogTool["connector"]["kind"], result: unknown): void {
  if (kind !== "mcp" || result == null || typeof result !== "object") return;
  const mcpResult = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (!mcpResult.isError) return;
  throw new DownstreamToolError(
    boundedEchoText(
      mcpResult.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("") || "Downstream tool call failed",
    ),
  );
}

/**
 * Whether a failed attempt is the downstream tool's own answer. For a read:
 * an MCP `isError`, or a boundary's known refusal/unsent failure. For a
 * write, only refusal provenance that holds for the whole logical call
 * (`knownCallFailure`); an `isError` arrives over a 2xx after the handler
 * ran. A typed error alone is not proof: a body ceiling, refused redirect, or
 * handler error may follow execution. Boundaries supply provenance, never
 * wording.
 */
function answeredFailure(error: unknown, write: boolean, call: LogicalCall | undefined): boolean {
  if (!write) return error instanceof DownstreamToolError || isKnownProviderFailure(error);
  return knownCallFailure(call, error);
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
  | (InvocationBase & { ok: true; value: T; format: "json" | "text"; resolved: ResolvedCatalogTool })
  | (InvocationBase & {
      ok: false;
      error: CallErrorDetails;
      /**
       * The dispatched attempt failed with the downstream tool's own answer
       * (an MCP `isError`). Absent when nothing was dispatched.
       */
      answered?: boolean;
    });

/**
 * What a write gate decided about one consequential call. A dispatch goes on
 * to admission and the connector; a refusal ends the call with `error`,
 * recorded as an ordinary failed attempt unless `unrecorded` — a write
 * refused only because its program already returned was never an attempt.
 */
export type WriteDecision =
  | { kind: "dispatch" }
  | {
      kind: "refuse";
      error: CallErrorDetails;
      unrecorded?: true;
    };

export interface InvocationContext<T> {
  source: ActivityCallSource;
  /** The owning program retains these credentials only until its run ends. */
  sentSecrets?: SentSecrets;
  /** The endpoint refuses every write. Resolved by the host route; default writable. */
  readOnly?: boolean | undefined;
  timeoutMs?: number;
  requestSignal?: AbortSignal;
  /** Run ended: cancel resolution/admission, but spare a dispatched write. */
  dispatchSignal?: AbortSignal;
  unwrapResult?: boolean;
  /** MCP direct calls capture a suspension before redaction and value shaping. */
  processInputRequired?: (
    value: DownstreamInputResult,
    resolved: ResolvedCatalogTool,
    secrets: SentSecrets,
  ) => T | Promise<T>;
  /**
   * Caller-owned result policy. Direct and program calls apply their shared
   * stash policy here, after unwrapping and before reporting completion.
   */
  processResult?: (
    value: unknown,
    resolved: ResolvedCatalogTool,
    sentSecrets: SentSecrets,
    format: "json" | "text",
    raw: unknown,
  ) => T | Promise<T>;
  /**
   * Optional payload-free friction class derived from a *successful* result —
   * today only an oversized one that had to be paged. It is deliberately not an
   * `errorCode`: the call succeeded, and a consumer that keys its dashboards on
   * "has an error code" must not count a truncation as a failure.
   */
  activityFriction?: (value: T) => AgentFriction | undefined;
  /** Account for an admitted write after validation and before admission. */
  beforeWrite?: (target: ResolvedCatalogTool, args: unknown) => Effect.Effect<WriteDecision>;
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
  readonly data: CallErrorDetails;

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
    this.data = details;
  }
}
keepErrorName(InvocationFailure, "InvocationFailure");

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

  invoke<T = unknown>(address: string, args: unknown, context: InvocationContext<T>): Promise<InvocationOutcome<T>> {
    return runEdge(this.pipeline(address, args, context));
  }

  /**
   * `invoke` without the Promise, for a caller already running a fiber —
   * code mode's host calls yield it rather than crossing a second edge. It
   * never fails: every outcome, refusals included, is its success value.
   */
  pipeline<T>(address: string, args: unknown, context: InvocationContext<T>): Effect.Effect<InvocationOutcome<T>> {
    return Effect.gen({ self: this }, function* () {
      const started = Date.now();
      let argumentEcho: ReturnType<typeof echoedCallArgs> = {};
      let catalogMs = 0;
      let admissionMs = 0;
      let connectorMs = 0;
      let resultProcessingMs = 0;
      let attempts = 0;
      let resultBytes: number | undefined;
      let dispatchedToConnector = false;
      // The logical call bridge; recovery is a separate invocation-owned record.
      let logicalCall: LogicalCall | undefined;
      const recoveryState = recoveryRecord();
      let preInvocationAuthFailure = false;
      let answered = false;
      // A dispatched failure's advice to send it again, composed by enrich
      // only once the outcome allows it (resendAdvice), and its advice to
      // reuse an idempotency key, only where that key protects the whole
      // logical call (keyResendAdvice, keyProtectsCall).
      let failureAdvice: string | undefined;
      let failureKeyAdvice: KeyResendAdvice | undefined;
      const sentSecrets = sentSecretsForRequest(this.catalog.requestScope);
      context.sentSecrets?.include(sentSecrets);
      // A write gate's refusal that is no attempt; see WriteGateDecision.
      let unrecorded = false;
      let resolved: ResolvedCatalogTool | undefined;
      let activityTarget: Pick<ResolvedCatalogTool, "connector" | "toolName"> | undefined;
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
        classification: { errorCode?: ClassificationCode; friction?: AgentFriction } = {},
      ) => {
        const identity = activityTarget
          ? {
              connectorId: activityTarget.connector.id,
              // A resolved tool's name is the downstream's choice, recorded
              // only when it fits the tool-name grammar (INV-6).
              toolName: resolved ? recordedToolName(resolved.definition) : activityTarget.toolName,
            }
          : attempted;
        if (!identity) return;
        const toolName = hasControlCharacters(identity.toolName) ? "<unlisted>" : identity.toolName;
        this.activity?.recordTool?.(this.activity, {
          connectorId: identity.connectorId,
          toolName,
          address: `${identity.connectorId}.${toolName}`,
          source: context.source,
          outcome,
          ...(activityTarget?.connector.authScope === "personal" ? { personal: true } : {}),
          durationMs: Date.now() - started,
          attempts,
          ...defined({
            classification: resolved?.definition.classification,
            resultBytes,
            errorCode: classification.errorCode,
            friction: classification.friction,
          }),
        });
      };
      const enrich = (error: CallErrorDetails, target: typeof activityTarget, settled: boolean): CallErrorDetails => {
        if (!target) return error;
        const recovery = recoveryState.facts;
        // A recorded key is a diagnostic; advice to reuse it needs proof that
        // it protects the whole logical call, not one request inside it. Q8's
        // settled verdict is final: no enricher adds advice to it.
        const recoveryRetry =
          !settled && keyProtectsCall(logicalCall, recovery?.["idempotencyKey"])
            ? " A deliberate retry with uncertainCall.recovery.idempotencyKey and the exact original arguments cannot repeat the write while the vendor retains that key (Stripe keeps v1 keys at least 24 hours); after that, look the object up before retrying."
            : "";
        if (isTimeoutFailure(error) && dispatchedToConnector && resolved?.definition.classification === "write") {
          const echoed = argumentEcho;
          return {
            ...error,
            code: "write_outcome_unknown",
            message: `${error.message} Its outcome is unknown. Check the target before repeating this call.`,
            retryable: false,
            connector: target.connector.id,
            operation: `${target.connector.id}.${target.toolName}`,
            uncertainCall: {
              address: `${target.connector.id}.${target.toolName}`,
              ...echoed,
              ...("args" in echoed ? {} : { argsOmitted: true as const }),
              ...(recovery ? { recovery } : {}),
            },
            retry:
              "Do not retry automatically. Check whether the write took effect first." +
              recoveryRetry +
              (echoed.argsRedacted
                ? " Sensitive fields are omitted; use the original arguments if reconciliation requires another call."
                : "args" in echoed
                  ? ""
                  : " The arguments could not be echoed safely; use the exact arguments you sent."),
          };
        }
        const enteredWrite =
          dispatchedToConnector && resolved !== undefined && resolved.definition.classification !== "read";
        // A dispatched write without refusal provenance is unknown whatever
        // its connector's code says, a custom connector's included: never
        // retryable, and no advice below may tell the agent to retry it.
        const unknownWrite =
          enteredWrite && classifyWriteOutcome({ ok: false, dispatched: true, answered, error }) === "unknown";
        if (unknownWrite) error = { ...error, retryable: false, writeOutcome: "unknown" };
        // The failure's advice to send it again was kept apart until now, and
        // joins its message only where the outcome allows it: never on a write
        // whose outcome is unknown, whatever redaction did to the message.
        // Key-reuse advice also needs its key to protect the logical call.
        else if (!settled) {
          if (failureKeyAdvice && keyProtectsCall(logicalCall, failureKeyAdvice.key))
            error = { ...error, message: withResendAdvice(error.message, failureKeyAdvice.advice) };
          if (failureAdvice !== undefined)
            error = { ...error, message: withResendAdvice(error.message, failureAdvice) };
        }
        // Any other dispatched write whose outcome is unknown (a lost response
        // body, a 5xx, an unreadable reply) keeps the facts its connector
        // recorded before dispatch, here and through program write accounting.
        if (recovery && !error.uncertainCall && unknownWrite) {
          const echoed = argumentEcho;
          error = {
            ...error,
            uncertainCall: {
              address: `${target.connector.id}.${target.toolName}`,
              ...echoed,
              ...("args" in echoed ? {} : { argsOmitted: true as const }),
              recovery,
            },
            retry:
              error.retry ?? `Do not retry automatically. Check whether the write took effect first.${recoveryRetry}`,
          };
        }
        if (error.code === "auth_required" && target.connector.startAuth) {
          error = { ...error, code: "downstream_oauth_required" };
        }
        switch (error.code) {
          case "input_required_unsupported":
            if (context.processInputRequired) return error;
            // Resending could apply the write twice: reconcile first.
            if (unknownWrite)
              return {
                ...error,
                retry:
                  "Do not resend this write. Re-read its target to check whether it took effect before any fresh call.",
              };
            return {
              ...error,
              nextAction: {
                tool: resolved?.definition.classification === "read" ? "call_tool" : "call_destructive_tool",
                arguments: { address: `${target.connector.id}.${target.toolName}`, ...argumentEcho },
                purpose:
                  "Use this direct call so the host can fulfill the downstream input request." +
                  (argumentEcho.argsRedacted
                    ? " Re-send the original arguments; sensitive fields are omitted."
                    : "args" in argumentEcho
                      ? ""
                      : " Re-send the original arguments; they could not be echoed safely."),
              },
            };
          case "destructive_tool_requires_approval": {
            if (settled) return error;
            const echoed = argumentEcho;
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
                  (echoed.argsRedacted
                    ? "Re-send the original arguments; sensitive fields are omitted from this hint. Add a short reason for the human reviewer."
                    : "args" in echoed
                      ? "Re-send these arguments and add a short reason for the human reviewer."
                      : "Re-send the arguments you just sent; they could not be echoed safely. Add a short reason for the human reviewer."),
              },
            };
          }
          case "auth_required":
          case "downstream_oauth_required":
            return {
              ...error,
              connector: target.connector.id,
              operation: `${target.connector.id}.${target.toolName}`,
              recovery: recoveryMode(this.registry, target.connector, this.catalog.baseUrl),
              ...(enteredWrite ? { reconciliationRequired: true as const, retryable: false } : {}),
              nextAction: {
                tool: "authorize_connector" as const,
                arguments: { connector: target.connector.id },
                operatorHandoff: "Give the URL and instructions it returns to the operator.",
              },
              retry: enteredWrite
                ? "This write may have partially run. Reconcile its target before retrying after the operator completes recovery."
                : `Retry ${target.connector.id}.${target.toolName} after the operator completes recovery.`,
            };
          case "provider_permission_denied":
            // A write whose outcome is unknown is never told to retry.
            if (error.writeOutcome === "unknown") return error;
            return {
              ...error,
              connector: target.connector.id,
              operation: `${target.connector.id}.${target.toolName}`,
              retry:
                "Ask the provider's resource owner or administrator to grant the required permission or scope, then retry. Repeating the call or reconnecting alone will not grant access.",
            };
          case "invalid_args":
            if (!error.validation || error.writeOutcome === "unknown") return error;
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
              retry: `Correct the listed arguments and retry ` + `${target.connector.id}.${target.toolName}.`,
            };
          default:
            return error;
        }
      };
      let stage = "catalog";
      const failed = (error: CallErrorDetails): InvocationOutcome<T> => {
        // Q8 (settleWrite): this invocation's deadline or its caller cut off
        // a write. No connector failure arrives, so the logical call's
        // recorded requests alone decide whether a 401 left it unknown.
        if (
          dispatchedToConnector &&
          resolved?.definition.classification !== "read" &&
          (error.code === "cancelled" || isTimeoutFailure(error))
        ) {
          const departed = settleWrite(logicalCall?.sent ?? [], undefined, true);
          if (departed !== undefined) {
            failureAdvice = failureKeyAdvice = undefined;
            error = carryFailureFacts(departed, classifyWithoutAdvice(sentSecrets.redact(departed)));
          }
        }
        const diagnostics = timing();
        const target = resolved ?? activityTarget;
        if (target && (error.code === "auth_required" || error.code === "downstream_oauth_required")) {
          recordAuthFailure(
            this.catalog.requestScope,
            target.connector.id,
            (resolved?.definition.classification === "read" && resolved.classificationFresh === true) ||
              preInvocationAuthFailure ||
              (!resolved && context.source === "call_tool"),
          );
        }
        // Read before any step below rebuilds the details: Q8's verdict is final.
        const settled = isSettledWrite(error);
        // Attach host deadline facts before write recovery changes the code.
        if (isTimeoutFailure(error)) {
          const elapsedMs = Date.now() - started;
          const operation = boundedEchoText(address, 512);
          error = {
            ...error,
            message: `Operation "${operation}" timed out during ${stage} after ${elapsedMs}ms (effective deadline ${context.timeoutMs}ms).`,
            details: { ...error.details, operation, stage, elapsedMs, ...defined({ deadlineMs: context.timeoutMs }) },
          };
        }
        // Downstream diagnostics were redacted under payload rules where they entered.
        const details = carryFailureFacts(error, sentSecrets.redact(enrich(error, target, settled), "envelope"));
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
        // A write refused only because its program had already returned
        // leaves no event and nothing in the operator's log.
        if (unrecorded) return outcome();
        // Activity rows and this log line are both payload-free by
        // construction: the line is the failure's typed record, never its
        // message, which may be the downstream's own words (INV-6).
        if (target && details.code !== "destructive_tool_requires_approval" && details.code !== "read_only_endpoint") {
          logFailure(
            this.registry.contextFor(target.connector.id, this.catalog.baseUrl, this.catalog.requestScope).logger,
            "call failed",
            failureRecord(
              {
                connector: target.connector.id,
                // Named only when the catalog listed it (src/operator-record.ts).
                tool: resolved?.definition,
                source: context.source,
                attempts,
                durationMs: Date.now() - started,
                // Every refusal reaching `failed` is one connecta built: a
                // thrown value's classification, a framing refusal, or a
                // cancellation. Nothing else is read as a classification.
              },
              classifiedFailure(error),
            ),
          );
        }
        record(
          details.code === "timeout" ? "timeout" : details.code === "cancelled" ? "cancelled" : "error",
          defined({ errorCode: classificationCode(details.code) }),
        );
        return outcome();
      };

      if (context.requestSignal?.aborted || context.dispatchSignal?.aborted) {
        // Preserve the cancelled admission-attempt count without starting discovery.
        attempts = 1;
        return failed(callerCancelledDetails());
      }
      let result: unknown;
      let rawResult: unknown;
      let inputRequiredValue: { value: T } | undefined;
      let observedResult: unknown;
      let valueFormat: "json" | "text" = "json";
      // Everything up to the downstream result: resolution, the safety and
      // schema refusals, admission, and the one attempt. A refusal is its
      // success value. Its failure is an abort reason or something nobody
      // expected, and a throw anywhere in it — a defect, to Effect — is
      // classified like a failure, as the async body this replaced did.
      const dispatch = (callSignal?: AbortSignal): Effect.Effect<CallErrorDetails | undefined, unknown> =>
        Effect.gen({ self: this }, function* () {
          const admissionSignal = context.dispatchSignal
            ? AbortSignal.any([context.dispatchSignal, ...(callSignal ? [callSignal] : [])])
            : callSignal;
          const resolution = yield* this.catalog.resolve(address, defined({ signal: admissionSignal }));
          catalogMs += resolution.catalogMs;
          if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
          if (admissionSignal?.aborted) return callerCancelledDetails();
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
          argumentEcho = echoedCallArgs(args ?? {}, target.definition.inputSchema);
          sentSecrets.arguments(args ?? {}, target.definition.inputSchema);

          const write = target.definition.classification !== "read";
          const canonicalAddress = `${target.connector.id}.${target.toolName}`;
          const input =
            context.source !== "execute_code"
              ? downstreamContinuation(this.catalog.requestScope, target.connector.id, canonicalAddress)
              : undefined;
          if (input) recordDownstreamArgumentEcho(this.catalog.requestScope, argumentEcho);
          const expectedDigest = replayClassificationDigest(this.catalog.requestScope, canonicalAddress);
          if (
            expectedDigest !== undefined &&
            (target.classificationFresh !== true ||
              (yield* Effect.promise(() => classificationDigest(target.definition))) !== expectedDigest)
          ) {
            return {
              ...framingError(
                "auth_replay_refused",
                "An entered read no longer has the same fresh classification. Reconcile its target before starting a new request.",
              ),
              reconciliationRequired: true as const,
            };
          }
          const connectorReadOnly = target.connector.readOnly === true;
          const refusal = writeRefusal(
            target.definition.classification,
            context.source,
            context.readOnly || connectorReadOnly,
          );
          if (refusal === "read_only_endpoint") {
            return framingError(
              "read_only_endpoint",
              `Tool "${canonicalAddress}" is a write, and ${connectorReadOnly ? `connector "${target.connector.id}"` : "this endpoint"} is read-only. Nothing here can send it.`,
            );
          }
          if (refusal === "destructive_tool_requires_approval") {
            return framingError(
              "destructive_tool_requires_approval",
              `Tool "${canonicalAddress}" is a write. Invoke it through call_destructive_tool so the MCP host can request approval.`,
            );
          }
          // Remote MCP tools advertise their input schema in the catalog. Validate
          // against that same request-local definition before admission or provider
          // dispatch, so a predictable mismatch stays structured instead of being
          // flattened into provider-specific error prose. Unsupported schemas retain
          // validateToolInput's fail-open behavior and reach the downstream normally.
          if (target.connector.kind === "mcp" && target.definition.inputSchema) {
            const invalid = validateCatalogToolInput(
              target.definition.inputSchema,
              args ?? {},
              {
                address: `${target.connector.id}.${target.toolName}`,
                logger: this.registry.contextFor(target.connector.id, this.catalog.baseUrl, this.catalog.requestScope)
                  .logger,
              },
              { connector: target.connector.id, tool: target.definition },
            );
            if (invalid) return classifyCallError(invalid);
          }

          if (write && context.beforeWrite) {
            const decision = yield* context.beforeWrite(target, args ?? {});
            if (decision.kind === "refuse") {
              unrecorded = decision.unrecorded === true;
              return decision.error;
            }
          }

          if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
          attempts = 1;
          const call = (permit: CallAdmissionPermit) =>
            Effect.gen({ self: this }, function* () {
              const operationContext = this.registry.contextFor(
                target.connector.id,
                this.catalog.baseUrl,
                this.catalog.requestScope,
                defined({ signal: callSignal, timeoutMs: context.timeoutMs, defer: this.catalog.defer }),
              );
              const lease = callFromContext(operationContext, write ? "write" : "read", {
                served: write ? "write" : "read",
                charge: (signal) => runEdge(chargeCallBudget(permit, signal)),
                chargeClosed: () =>
                  new CallAdmissionError(
                    "closed",
                    "connector_call_failed",
                    "This call has ended; its admission permit can no longer be charged.",
                  ),
                record: (facts) => recordRecoveryFacts(recoveryState, facts),
              });
              yield* Effect.addFinalizer(() => Effect.sync(lease.close));
              const connectorContext = contextView(lease, operationContext);
              sentSecrets.include(sentSecretsFor(connectorContext));
              // The one object and function this call invokes, read once: its
              // logical call, auth check, and dispatch all name them, so a
              // connector that reassigns its own callTool mid-call changes none.
              const connector = target.connector;
              const callTool = connector.callTool;
              logicalCall = openLogicalCall(connectorContext, connector, callTool);
              yield* Effect.tryPromise({
                try: async () => {
                  try {
                    if (target.connector.credential) {
                      if (!connectorContext.credential) {
                        throw new ConnectorCallError(
                          "auth_required",
                          "Operator-managed credential storage is not configured. Call " +
                            `authorize_connector({ connector: "${target.connector.id}" }).`,
                        );
                      }
                      if (!(await connectorContext.credential.getAll())) {
                        throw new ConnectorCallError(
                          "auth_required",
                          `Connector "${target.connector.id}" has no stored credential. Call authorize_connector.`,
                        );
                      }
                    }
                    await resolveInvocationAuth(connector, callTool, connectorContext);
                  } catch (error) {
                    const code = classifyCallError(error).code;
                    preInvocationAuthFailure = code === "auth_required" || code === "downstream_oauth_required";
                    throw error;
                  }
                },
                catch: (error) => error,
              });
              // Cancellation can arrive during admission or context construction.
              if (admissionSignal?.aborted) throw admissionSignal.reason;
              dispatchedToConnector = true;
              recordCallEntry(
                this.catalog.requestScope,
                {
                  address: canonicalAddress,
                  classification: write ? "write" : "read",
                  fresh: target.classificationFresh === true,
                },
                target.definition,
              );
              // Reflect.apply, never the function's own `call` or `apply`
              // property, which anyone holding the function could replace.
              const options = { definition: structuredClone(target.definition), ...defined({ input }) };
              const entry = callEntry(connector, callTool);
              if (entry)
                return yield* entry(target.toolName, args ?? {}, options).pipe(
                  Effect.provideContext(viewServices(connectorContext)),
                );
              return yield* Effect.tryPromise({
                try: () =>
                  Reflect.apply(callTool, connector, [
                    target.toolName,
                    args ?? {},
                    connectorContext,
                    // The connector may retain or mutate its definition. Keep the
                    // invocation's classification and schema private, even during
                    // this call, and give every dispatch its own deep copy.
                    options,
                  ]),
                catch: (error) => error,
              });
            });
          // The permit belongs to this scope, so success, failure, and the
          // deadline's interruption all release it. Interruption stops the
          // wait instead of waiting for the connector, so an uncooperative one
          // cannot hold its permit past the deadline.
          const attempt = yield* Effect.exit(
            Effect.scoped(
              Effect.gen({ self: this }, function* () {
                stage = "admission";
                const permit = yield* timed(
                  (elapsed) => {
                    admissionMs += elapsed;
                  },
                  admitted(this.registry, target, args, admissionSignal),
                );
                stage = "downstream";
                const reply = yield* timed((elapsed) => {
                  connectorMs += elapsed;
                }, call(permit));
                if (target.connector.kind === "mcp" && isDownstreamInputResult(reply)) {
                  // The downstream suspended for input. A handler asks for
                  // input from inside its run, so a write may already have
                  // applied: only a read's suspension is a known answer.
                  if (!context.processInputRequired)
                    throw write
                      ? new ConnectorCallError(
                          "input_required_unsupported",
                          "The downstream returned input_required after this write was sent, and this call cannot provide input. Whether the write took effect is unknown.",
                          { writeOutcome: "unknown" },
                        )
                      : knownProviderFailure(
                          new ConnectorCallError(
                            "input_required_unsupported",
                            "The downstream returned input_required. Use the equivalent direct MCP call to provide input.",
                          ),
                        );
                  const value = yield* Effect.tryPromise({
                    try: () => Promise.resolve(context.processInputRequired!(reply, target, sentSecrets)),
                    catch: (error) => error,
                  });
                  return { inputRequired: true as const, value };
                }
                assertDownstreamOutputSafe(this.catalog.requestScope, reply);
                const raw = sentSecrets.redact(reply);
                // isError is checked here for BOTH result shapes so every adapter
                // reports the same downstream-failure wording, and the throw lands
                // inside the attempt where it feeds health.
                assertRawMcpSuccess(target.connector.kind, raw);
                return { raw, observed: sentSecrets.redact(downstreamValue(target.connector.kind, raw)) };
              }),
            ),
          );
          if (Exit.isFailure(attempt)) {
            if (callSignal?.aborted) return yield* Effect.fail(callSignal.reason);
            if (!dispatchedToConnector && admissionSignal?.aborted) return callerCancelledDetails();
            const thrown = Cause.squash(attempt.cause);
            if (isCallerCancellation(thrown, context.requestSignal)) return callerCancelledDetails();
            answered = answeredFailure(thrown, write, logicalCall);
            // Q8 is decided here for every served write, whatever its
            // connector made of the 401: over the logical call's whole ledger.
            const attemptError = write ? settleWrite(logicalCall?.sent ?? [], thrown, answered) : thrown;
            if (attemptError !== thrown) answered = false;
            failureAdvice = resendAdviceOf(attemptError);
            failureKeyAdvice = keyResendAdviceOf(attemptError);
            const details = carryFailureFacts(attemptError, classifyWithoutAdvice(sentSecrets.redact(attemptError)));
            // An inner call's verdict that does not hold for this one is withdrawn.
            if (write && !answered) forgetProviderFailure(details);
            return details;
          }
          if ("inputRequired" in attempt.value) {
            inputRequiredValue = { value: attempt.value.value as T };
            return undefined;
          }
          observedResult = attempt.value.observed.data;
          try {
            const serialized =
              attempt.value.observed.format === "text" && typeof observedResult === "string"
                ? observedResult
                : JSON.stringify(observedResult);
            if (serialized !== undefined) resultBytes = new TextEncoder().encode(serialized).byteLength;
          } catch {
            /* Unserializable values have no measurable byte count. */
          }
          valueFormat = attempt.value.observed.format;
          rawResult = attempt.value.raw;
          result = context.unwrapResult ? observedResult : rawResult;
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
              timeoutError: new ConnectorCallError("timeout", `Tool call timed out after ${context.timeoutMs}ms`),
            })
          : dispatch(),
      );
      if (Exit.isFailure(dispatched)) {
        const failure = Cause.squash(dispatched.cause);
        failureAdvice = resendAdviceOf(failure);
        failureKeyAdvice = keyResendAdviceOf(failure);
        const details = context.requestSignal?.aborted
          ? callerCancelledDetails()
          : carryFailureFacts(failure, classifyWithoutAdvice(sentSecrets.redact(failure)));
        return failed(details);
      }
      if (dispatched.value) return failed(dispatched.value);
      // A dispatch that returned no refusal resolved a concrete tool.
      const completed = resolved;
      if (!completed) {
        return yield* Effect.die(new Error("Invocation completed without a resolved tool"));
      }
      // Q8 settles a result too: a write an undeclared 401 left unknown is no
      // success, whatever its handler made of the 401, and its result is not
      // processed.
      if (dispatchedToConnector && completed.definition.classification !== "read") {
        const unknown = settleWriteResult(logicalCall?.sent ?? []);
        if (unknown) {
          failureAdvice = failureKeyAdvice = undefined;
          return failed(carryFailureFacts(unknown, classifyWithoutAdvice(sentSecrets.redact(unknown))));
        }
      }

      const processResult = context.processResult;
      const processing: Effect.Effect<T, unknown> = inputRequiredValue
        ? Effect.succeed(inputRequiredValue.value)
        : processResult
          ? Effect.tryPromise({
              try: () =>
                Promise.resolve(
                  processResult(sentSecrets.redact(result), completed, sentSecrets, valueFormat, rawResult),
                ) as Promise<T>,
              catch: (error) => error,
            })
          : Effect.succeed(result as T);
      const processed = yield* Effect.exit(
        timed(
          (elapsed) => {
            resultProcessingMs += elapsed;
          },
          Effect.tap(processing, () =>
            Effect.sync(() => {
              if (inputRequiredValue) return;
              try {
                this.registry.observeOutputShape(completed.connector.id, completed.definition, observedResult);
              } catch {
                // Shape learning is advisory. It cannot change a completed call.
              }
            }),
          ),
        ),
      );
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
        const value = sentSecrets.redact(processed.value, "envelope");
        const diagnostics = timing();
        const friction = context.activityFriction?.(value);
        record("success", friction ? { friction } : {});
        return {
          ok: true as const,
          value,
          format: valueFormat,
          resolved: completed,
          durationMs: Date.now() - started,
          attempts,
          timing: diagnostics,
          dispatched: dispatchedToConnector,
        };
      } catch {
        return unprocessable();
      }
    }).pipe(
      Effect.flatMap((outcome: InvocationOutcome<T>): Effect.Effect<InvocationOutcome<T>> =>
        outcome.ok
          ? Effect.succeed(outcome)
          : Effect.promise(async () => ({
              ...outcome,
              error: await withAuthorizationHandoff(this.catalog.requestScope, outcome.error),
            })),
      ),
    );
  }
}
