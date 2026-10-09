import { withAuthorizationHandoff } from "./authorization-handoff.js";
import { hasControlCharacters } from "./tool-name.js";
import { surfaceAllowsTool, type PoolTrust } from "./tool-safety.js";
import { Cause, Effect, Exit, type Scope } from "effect";
import { type ActivityCallSource, type ActivityRequestContext, type AgentFriction } from "./activity.js";
import { isCallAdmissionError, type CallAdmissionPermit } from "./call-admission.js";
import { CatalogService, type ResolvedCatalogTool } from "./catalog-service.js";
import {
  boundedEchoText,
  classificationCode,
  classifyCallError,
  ConnectorCallError,
  echoedCallArgs,
  framingError,
  type AuthRecoveryMode,
  type CallErrorDetails,
  type ClassificationCode,
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
import { sentSecretsFor, sentSecretsForRequest, trackCredentialReads, type SentSecrets } from "./sent-secrets.js";
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
 * plain `Error`: untyped, non-retryable, and marked so
 * a write's outcome can tell "the service said no" from "nobody answered".
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
 * Whether a failed attempt is the downstream tool's own answer: an MCP
 * `isError`. A connector's typed error is not, by itself, one — a response
 * too large to read or a refused redirect comes after the request was acted
 * on — so its code decides instead (`classifyWriteOutcome`).
 */
function answeredFailure(error: unknown): boolean {
  return error instanceof DownstreamToolError;
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
  trust?: PoolTrust | undefined;
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
      let preInvocationAuthFailure = false;
      let answered = false;
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
      const enrich = (error: CallErrorDetails, target: typeof activityTarget): CallErrorDetails => {
        if (!target) return error;
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
            },
            retry:
              "Do not retry automatically. Check whether the write took effect first." +
              (echoed.argsRedacted
                ? " Sensitive fields are omitted; use the original arguments if reconciliation requires another call."
                : "args" in echoed
                  ? ""
                  : " The arguments could not be echoed safely; use the exact arguments you sent."),
          };
        }
        if (error.code === "auth_required" && target.connector.startAuth) {
          error = { ...error, code: "downstream_oauth_required" };
        }
        const enteredWrite = resolved?.definition.classification === "write" && dispatchedToConnector;
        switch (error.code) {
          case "input_required_unsupported":
            if (context.processInputRequired) return error;
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
            return {
              ...error,
              connector: target.connector.id,
              operation: `${target.connector.id}.${target.toolName}`,
              retry:
                "Ask the provider's resource owner or administrator to grant the required permission or scope, then retry. Repeating the call or reconnecting alone will not grant access.",
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
              retry: `Correct the listed arguments and retry ` + `${target.connector.id}.${target.toolName}.`,
            };
          default:
            return error;
        }
      };
      let stage = "catalog";
      const failed = (error: CallErrorDetails): InvocationOutcome<T> => {
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
        const details = sentSecrets.redact(enrich(error, target), "envelope");
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
        if (target && details.code !== "destructive_tool_requires_approval") {
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
          if (!surfaceAllowsTool(target.definition.classification, context.source, context.trust)) {
            const canonicalAddress = `${target.connector.id}.${target.toolName}`;
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
          const call = async () => {
            const connectorContext = this.registry.contextFor(
              target.connector.id,
              this.catalog.baseUrl,
              this.catalog.requestScope,
              defined({ signal: callSignal, timeoutMs: context.timeoutMs, defer: this.catalog.defer }),
            );
            trackCredentialReads(connectorContext);
            sentSecrets.include(sentSecretsFor(connectorContext));
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
              await resolveInvocationAuth(target.connector, connectorContext);
            } catch (error) {
              const code = classifyCallError(error).code;
              preInvocationAuthFailure = code === "auth_required" || code === "downstream_oauth_required";
              throw error;
            }
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
            return await target.connector.callTool(
              target.toolName,
              args ?? {},
              connectorContext,
              // The connector may retain or mutate its definition. Keep the
              // invocation's classification and schema private, even during
              // this call, and give every dispatch its own deep copy.
              { definition: structuredClone(target.definition), ...defined({ input }) },
            );
          };
          // The permit belongs to this scope, so success, failure, and the
          // deadline's interruption all release it. Interruption stops the
          // wait instead of waiting for the connector, so an uncooperative one
          // cannot hold its permit past the deadline.
          const attempt = yield* Effect.exit(
            Effect.scoped(
              Effect.gen({ self: this }, function* () {
                stage = "admission";
                yield* timed(
                  (elapsed) => {
                    admissionMs += elapsed;
                  },
                  admitted(this.registry, target, args, admissionSignal),
                );
                stage = "downstream";
                const reply = yield* timed(
                  (elapsed) => {
                    connectorMs += elapsed;
                  },
                  Effect.tryPromise({
                    try: () => Promise.resolve(call()),
                    catch: (error) => error,
                  }),
                );
                if (target.connector.kind === "mcp" && isDownstreamInputResult(reply)) {
                  if (!context.processInputRequired)
                    throw new ConnectorCallError(
                      "input_required_unsupported",
                      "The downstream returned input_required. Use the equivalent direct MCP call to provide input.",
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
            const attemptError = Cause.squash(attempt.cause);
            answered = answeredFailure(attemptError);
            return isCallerCancellation(attemptError, context.requestSignal)
              ? callerCancelledDetails()
              : carryFailureFacts(attemptError, classifyCallError(sentSecrets.redact(attemptError)));
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
        const details = context.requestSignal?.aborted
          ? callerCancelledDetails()
          : carryFailureFacts(failure, classifyCallError(sentSecrets.redact(failure)));
        return failed(details);
      }
      if (dispatched.value) return failed(dispatched.value);
      // A dispatch that returned no refusal resolved a concrete tool.
      const completed = resolved;
      if (!completed) {
        return yield* Effect.die(new Error("Invocation completed without a resolved tool"));
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
