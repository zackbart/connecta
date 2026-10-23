import { callerSignal } from "./runtime/call.js";
// Whether a dispatched write landed, as far as anyone can know. Shared by the
// invocation layer (which attaches recovery facts to every unknown outcome),
// trusted-program write accounting, and every connector that must tell an
// agent a write it sent once is not safe to repeat (INV-9). It imports only
// classification, errors and operator facts, without depending on a provider.
import { callClassification } from "./call-classification.js";
import type { ConnectorContext } from "./types.js";
import {
  classifyCallError,
  classifyWithoutAdvice,
  ConnectorCallError,
  networkErrorCode,
  WithheldTextError,
  type CallErrorDetails,
} from "./errors.js";
import {
  authorizationFailure,
  explainedUnauthorizedVerdict,
  explainsUnauthorized,
  inLogicalCall,
  settledWrite,
  isKnownProviderFailure,
  knownProviderFailure,
  nestedProviderCall,
  nestedProviderRequests,
  providerRequests,
  readRequest,
  refusalRequest,
  refusedStatus,
  unauthorizedAnswer,
  type ProviderRequest,
} from "./provider-call.js";
import { attachFailureFacts, carryFailureFacts, errorLabel } from "./operator-record.js";

/** How a dispatched write ended, as far as anyone can know. */
export type WriteState = "ok" | "failed" | "unknown";

/**
 * Whether a write landed, as far as anyone can know.
 *
 * `unknown` is the outcome a result must never paper over: the call left
 * connecta and no answer came back, so sending it again could do it twice and
 * not sending it could leave it undone. A dispatched write is `failed` only on
 * positive refusal provenance, recorded where the evidence was observed: (a)
 * the ledger shows a request connecta refused before it left, or (b) the
 * downstream served a refusing status, a 4xx other than 408, that its provider
 * does not read as `unavailable` or a timeout (`servedRefusal`; a 5xx never
 * proves a write unapplied, and a 401 does only with the vendor's reviewed
 * `authBeforeExecution` evidence). The evidence must
 * hold for the whole logical call (`knownCallFailure`, which `answered`
 * reports for a served call): every request the call sent is proven not
 * applied, and the failing request carries the refusal. A downstream tool's
 * `isError` arrives over a 2xx after its handler ran, so it is no such
 * evidence for a write. Nor is an error code by itself: a mapper, parser,
 * output validator, or JSON-RPC error (`-32602` included) can follow a write
 * that applied, so its `rate_limited` or `invalid_args` is `unknown`. So is
 * any failure the connector marked unknown (`writeOutcome`), such as a renewal
 * that failed after a 401. A call that was never dispatched is `failed`:
 * nothing was sent. `result_processing_failed` means the downstream call
 * completed.
 */
export function classifyWriteOutcome(outcome: {
  ok: boolean;
  dispatched: boolean;
  answered?: boolean;
  error?: Pick<CallErrorDetails, "code" | "writeOutcome">;
}): WriteState {
  if (outcome.ok) return "ok";
  if (!outcome.dispatched) return "failed";
  if (outcome.error?.writeOutcome === "unknown") return "unknown";
  if (outcome.answered === true || isKnownProviderFailure(outcome.error)) return "failed";
  if (outcome.error?.code === "result_processing_failed") return "ok";
  return "unknown";
}

/**
 * A write's retryable common failure, told as an unknown outcome (INV-9). A
 * request that is not safe to repeat (a write without an idempotency key)
 * must never be advertised as retryable after it may have reached the vendor:
 * a 5xx, a gateway's 502 to 504, a broken-off reply, or a connection lost
 * after sending. No network failure proves a write unsent: one send can hide
 * several attempts (a 421 or HTTP/2 refused-stream resend, a retrying
 * dispatcher), so a refusal on the last says nothing about the first. Other
 * failures pass through for {@link providerCallFailure} to decide, and
 * timeouts pass through for a served call's invocation to report as
 * `write_outcome_unknown`.
 */
function unknownOutcome(vendor: { title: string }, error: unknown): unknown {
  if (error instanceof WithheldTextError) {
    if (!error.retryable || error.timeout) return error;
  } else {
    if (!(error instanceof ConnectorCallError) || !error.retryable) return error;
    if (error.code !== "unavailable" && error.code !== "connector_call_failed") return error;
    if (isTimeout(error)) return error;
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.title} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
}

/**
 * A call's result, settled as its failure would be ({@link settleWriteResult}):
 * by the invocation for its logical call, and otherwise here, at the
 * outermost boundary, over every ledger beneath it. The verdict to throw in
 * place of the result, or undefined when the result stands.
 */
export function providerCallResult(
  ctx: ConnectorContext,
  fallback: "read" | "write",
  request?: ProviderRequest,
): ConnectorCallError | undefined {
  if ((callClassification(ctx) ?? fallback) !== "write") return undefined;
  // A transport inside a ledger only records; its api() boundary settles.
  if (request && providerRequests(ctx)) return undefined;
  const requests = providerRequests(ctx) ?? (request && [request]);
  if (!requests || inLogicalCall(ctx) || nestedProviderCall(ctx)) return undefined;
  return settleWriteResult([...requests, ...nestedProviderRequests(ctx)]);
}

/**
 * #902's failure decision for a write, and the one place a direct write's
 * failure is finalized (INV-9). Every connector surface hands a write's
 * failure here before it leaves: the `api()` handler boundary, a guarded
 * transport outside a call ledger (inside one, beneath `ctx.fetch`, the
 * shared REST layer, or Google, it defers to the `api()` boundary), and
 * every `remoteMcp().callTool()` write, direct or served. Nothing passes a
 * direct write's failure on ahead of it, the caller's own abort included.
 *
 * The served verdict outranks transport defaults. A remote MCP dispatch's
 * source-write ledger mark additionally requires write outcome accounting.
 * Dispatch facts come from the transport, never from a provider's
 * interpretation of its HTTP method. A write is a known failure only on
 * refusal provenance recorded where the evidence was observed: (a) the
 * ledger shows the request never left connecta, or (b) the downstream served
 * an HTTP refusal, a 4xx other than 408 (`refusedStatus`, `vendorRefusal`),
 * where a 401 also needs the vendor's reviewed `authBeforeExecution`
 * evidence. An error code is never that evidence. A write that may have left
 * and then timed out, was aborted, or failed any other way is an unknown
 * outcome, never retryable, unless a direct caller sent an idempotency key
 * the vendor honors (`repeatable`, or the request's recorded `key`, when it
 * is the only request the call sent; no operation hint counts). A served
 * call's invocation reports its own timeouts and aborts.
 *
 * Q8 is not decided here but once per call, over its whole ledger
 * ({@link settleWrite}): by the invocation that opened a logical call, and
 * otherwise only here, at the outermost boundary, after this decision.
 */
export function providerCallFailure(
  ctx: ConnectorContext,
  vendor: { title: string },
  error: unknown,
  facts: {
    dispatched: boolean;
    status?: number;
    fallback: "read" | "write";
    repeatable?: boolean;
    finalize?: boolean;
    /** The handler ran and may have sent requests the ledger never saw. */
    untracked?: boolean;
    /** `status` is a 401 the vendor's reviewed `authBeforeExecution` evidence covers. */
    authBeforeExecution?: boolean;
    /** Outside a call ledger: the one request the failure is about, as its transport recorded it. */
    request?: ProviderRequest | undefined;
  },
): unknown {
  const served = callClassification(ctx);
  if ((served ?? facts.fallback) !== "write" && facts.request?.sourceWrite !== true) return error;
  const requests = providerRequests(ctx);
  // Guarded transports collect facts; only api() knows when the logical call
  // has ended. Google may add phases or recovery words in the meantime.
  if (requests && !facts.finalize) return error;
  const decided = writeFailure(ctx, vendor, error, facts, served, requests);
  // The invocation settles Q8 over its logical call; without one, the
  // outermost boundary does, over every ledger beneath it.
  if (inLogicalCall(ctx) || nestedProviderCall(ctx)) return decided;
  return settleWrite(
    requests ? [...requests, ...nestedProviderRequests(ctx)] : facts.request ? [facts.request] : [],
    decided,
    isKnownProviderFailure(decided),
  );
}

function writeFailure(
  ctx: ConnectorContext,
  vendor: { title: string },
  error: unknown,
  facts: Parameters<typeof providerCallFailure>[3],
  served: "read" | "write" | undefined,
  requests: readonly ProviderRequest[] | undefined,
): unknown {
  if (requests) {
    // In flight counts as sent. The call is closed, so nothing else leaves.
    const sent = (request: ProviderRequest) => request.dispatched && !request.auxiliary;
    const dispatched = requests.filter(sent);
    // What api() boundaries nested in the handler sent is this call's too.
    const nested = nestedProviderRequests(ctx).filter(sent);
    // An empty or partial ledger is no proof for a handler that can send
    // around it: nothing it saw rules out a request it did not see.
    if (dispatched.length === 0 && nested.length === 0 && !facts.untracked) return knownProviderFailure(error);
    // A refusal or a key speaks for the call only as its one request, sent
    // by this boundary: an inner call's verdict is never this one's.
    const sole = !facts.untracked && dispatched.length === 1 && nested.length === 0 ? dispatched[0] : undefined;
    const refusal = refusalRequest(error);
    // An explicit unknown marker (a renewal after a 401, say) wins.
    const own =
      !(error instanceof ConnectorCallError && error.writeOutcome === "unknown") &&
      refusal !== undefined &&
      sole === refusal;
    if (own && servedRefusal(error, refusal.status, refusal.authBeforeExecution === true))
      return knownProviderFailure(error);
    if (facts.untracked) return uncertainProviderFailure(vendor, error, ctx);
    if (served === undefined && sole?.key !== undefined) return error;
    return uncertainProviderFailure({ title: dispatched[0]?.provider ?? vendor.title }, error, ctx);
  }
  // Provenance (a): the ledger shows the request never left connecta, unless
  // the connector itself could not tell (an explicit unknown marker).
  if (!facts.dispatched)
    return error instanceof ConnectorCallError && error.writeOutcome === "unknown"
      ? error
      : knownProviderFailure(error);
  const status = facts.status ?? facts.request?.status;
  const declared = facts.authBeforeExecution === true || facts.request?.authBeforeExecution === true;
  if (served === undefined) {
    // A direct transport user may prove idempotency with a key the vendor
    // honors. A deployment's served write verdict still requires
    // reconciliation rather than retry advice.
    if (facts.repeatable === true) return error;
    // Read before any code filter: a timeout or an abort, whatever its code
    // or source, is no verdict, and no invocation will report it.
    if (timedOutOrAborted(error, ctx)) return uncertainProviderFailure(vendor, error, ctx);
    if (!(error instanceof ConnectorCallError)) {
      const converted = unknownOutcome(vendor, error);
      return converted === error ? uncertainProviderFailure(vendor, error, ctx) : converted;
    }
    if (error.writeOutcome === "unknown") return uncertainProviderFailure(vendor, error, ctx);
  } else {
    if (!(error instanceof ConnectorCallError)) return unknownOutcome(vendor, error);
    if (error.writeOutcome === "unknown") return error;
    // The served call's invocation reports it as `write_outcome_unknown`.
    if (isTimeout(error)) return error;
  }
  // Provenance (b). An error code alone (a mapper's `rate_limited` after a
  // 2xx, a JSON-RPC `-32602`, an output validator's `invalid_args`) is never
  // this evidence.
  if (servedRefusal(error, status, declared)) return knownProviderFailure(error);
  const serverError = status !== undefined && status >= 500;
  if (facts.repeatable === true && error.retryable) {
    return carryFailureFacts(
      error,
      new ConnectorCallError(
        "connector_call_failed",
        `${error.message} Whether the write took effect at ${vendor.title} is unknown; check the target before repeating it.`,
        { retryable: false, writeOutcome: "unknown" },
      ),
    );
  }
  const converted = unknownOutcome(vendor, error);
  if (converted instanceof ConnectorCallError && converted !== error) return carryFailureFacts(error, converted);
  return carryFailureFacts(
    error,
    new ConnectorCallError(serverError ? "connector_call_failed" : error.code, error.message, {
      retryable: false,
      writeOutcome: "unknown",
    }),
  );
}

/**
 * Provenance (b), the one rule for the ledger and for a transport outside
 * one: the downstream served a refusing HTTP status (`refusedStatus`, a 4xx
 * other than 408), and its provider read that status as a refusal. A
 * provider that reads it as `unavailable` or a timeout (Stripe's 424) says
 * the outcome is not proven. A 401 proves nothing by itself: a server may act
 * on a request before it rejects the credential, so it is a refusal only where
 * the vendor's reviewed `authBeforeExecution` evidence says it authenticates
 * first. Of the maintained providers, only Stripe's API-key connector
 * declares that evidence.
 */
function servedRefusal(error: unknown, status: number | undefined, authBeforeExecution: boolean): boolean {
  if (!refusedStatus(status)) return false;
  if (status === 401 && !authBeforeExecution) return false;
  const code = classifyCallError(error).code;
  return code !== "unavailable" && code !== "timeout";
}

/**
 * Q8, the one decision for a write answered 401, made once per logical call
 * over every request it recorded: nested `api()` calls, remote MCP, guarded
 * transports and the kit alike. The invocation makes it for a served call,
 * whatever failed (a thrown or mapped error, a custom wrapper's, a
 * program's call, its own deadline or the caller's cancellation, as
 * `error` undefined), and `providerCallFailure` for a direct one at its
 * outermost boundary. Boundaries only record what they observed: dispatch,
 * status, a reviewed `authBeforeExecution` match, the 401's mapped verdict
 * (`vendorRefusal`) and a renewal of that request's own credential
 * (`renewedAfterUnauthorized`).
 *
 * A write request answered 401 means a server may have acted before it
 * rejected the credential, so the call's outcome is unknown, never
 * retryable, with no wait and no resend or key-reuse advice (INV-9). While
 * any such 401 is unrenewed, authorization is still needed: the verdict
 * keeps an authorization code, and so the `authorize_connector` handoff,
 * whose words reconcile before any fresh call ({@link unauthorizedVerdict}).
 * Only a renewal of every one drops the handoff ({@link renewedVerdict}).
 * The one exception is reviewed vendor evidence: a 401 matching the
 * vendor's `authBeforeExecution` declaration that is the only request the
 * call sent, whose own refusal is the failure and is known for the whole
 * call (`knownRefusal`: the boundary that sent it proved it, and, served,
 * `knownCallFailure`), stays that refusal. Returns `error` itself when no
 * write request was answered 401.
 */
export function settleWrite(requests: readonly ProviderRequest[], error: unknown, knownRefusal: boolean): unknown {
  const sent = requests.filter((request) => request.dispatched && !request.auxiliary);
  const answers = sent.filter((request) => request.status === 401);
  const [only] = answers;
  if (only === undefined) return error;
  if (knownRefusal && sent.length === 1 && only.authBeforeExecution === true && standingRefusal(error, only))
    return error;
  const unrenewed = answers.find((request) => request.renewed !== true);
  return settledWrite(unrenewed ? unauthorizedVerdict(unrenewed, error) : renewedVerdict(answers, error));
}

/**
 * The same decision for a call that returned a result: any undeclared write
 * 401 blocks success, even after renewal. A positively classified read's 401
 * and a declared refusal do not invalidate the handler's successful result.
 */
export function settleWriteResult(requests: readonly ProviderRequest[]): ConnectorCallError | undefined {
  return settleWrite(
    requests.filter((request) => !readRequest(request) && request.authBeforeExecution !== true),
    undefined,
    false,
  ) as ConnectorCallError | undefined;
}

/**
 * The declared 401's own refusal is the failure, typed and not made unknown;
 * or no failure arrived at all (the invocation's deadline), so nothing after
 * the refusal can have run.
 */
function standingRefusal(error: unknown, request: ProviderRequest): boolean {
  if (error === undefined) return true;
  return (
    error instanceof ConnectorCallError &&
    error.writeOutcome !== "unknown" &&
    refusalRequest(error) === request &&
    servedRefusal(error, 401, true)
  );
}

/**
 * The verdict of a call with an unrenewed write 401: `error` when it is an
 * authorization verdict, else the one that 401's own answer was mapped to,
 * else `auth_required`; never retryable, unknown, without a wait or advice.
 * A verdict that already accounts for the 401 keeps its words; any other
 * gains the sentence that the write was sent before the vendor rejected its
 * credential.
 */
function unauthorizedVerdict(answer: ProviderRequest, error: unknown): ConnectorCallError {
  const base = authorizationFailure(error)
    ? error
    : (unauthorizedAnswer(answer) ??
      attachFailureFacts(
        new ConnectorCallError("auth_required", `${answer.provider} answered this write with HTTP 401.`),
        answer.status === undefined ? {} : { httpStatus: answer.status },
      ));
  if (explainsUnauthorized(base)) return carryFailureFacts(error, withoutRetry(base));
  return explainedUnauthorizedVerdict(
    carryFailureFacts(
      error,
      carryFailureFacts(
        base,
        new ConnectorCallError(
          base.code,
          `${base.message} The write was sent before ${answer.provider} rejected its credential, so whether it ` +
            "took effect is unknown: check the target before repeating it.",
          { retryable: false, writeOutcome: "unknown" },
        ),
      ),
    ),
  );
}

/**
 * Every write 401 the call recorded was renewed: nothing is left to
 * authorize, and the outcome stays unknown. The renewed 401's own verdict,
 * or no failure at all (the invocation's deadline), reads as the renewal
 * did ({@link unsentAfterUnauthorized}); any other failure keeps its words,
 * unknown, without a retry flag or a wait.
 */
function renewedVerdict(answers: readonly ProviderRequest[], error: unknown): ConnectorCallError {
  const own = refusalRequest(error);
  const subject = (own ?? answers[0]!).provider;
  if (error === undefined || (authorizationFailure(error) && own !== undefined && answers.includes(own)))
    return carryFailureFacts(error, unsentAfterUnauthorized(subject));
  // Every failure, typed or not (a raw network error, an abort, a thrown
  // string), reads as #902's unknown outcome, without a retry flag or wait.
  return withoutRetry(uncertainProviderFailure({ title: subject }, error, undefined));
}

/** An unknown outcome as it stands, without a retry flag or a wait. */
function withoutRetry(error: ConnectorCallError): ConnectorCallError {
  if (!error.retryable && error.retryAfterMs === undefined && error.writeOutcome === "unknown") return error;
  return carryFailureFacts(
    error,
    new ConnectorCallError(error.code, error.message, {
      retryable: false,
      writeOutcome: "unknown",
      ...(error.details ? { details: error.details } : {}),
      ...(error.validation ? { validation: error.validation } : {}),
      ...(error.repair ? { repair: error.repair } : {}),
      ...(error.current ? { current: error.current } : {}),
    }),
  );
}

function isTimeoutCode(code: string | undefined): boolean {
  return code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT") === true;
}

/** `code: "timeout"` (an SDK or connecta deadline, an HTTP 408) or a timeout errno. */
function isTimeout(error: ConnectorCallError): boolean {
  return error.code === "timeout" || isTimeoutCode(error.details?.code);
}

/**
 * A direct caller's own abort reason, when its signal had aborted by the time
 * the failure arrived. Node's fetch rejects with that reason itself; workerd's
 * with an error of its own, so identity alone cannot tell. A served call's
 * signal is its invocation's, which reports its own deadline and cancellation.
 */
function callerAbort(ctx: ConnectorContext): { reason: unknown } | undefined {
  const signal = callerSignal(ctx);
  return signal?.aborted === true && callClassification(ctx) === undefined ? { reason: signal.reason } : undefined;
}

/**
 * Every timeout and abort a direct write can meet: the caller's own signal
 * (an `AbortSignal.timeout` included), the SDK's request deadline and
 * connecta's own (`code: "timeout"`), and a runtime's timeout errno
 * (`ETIMEDOUT`, undici's `UND_ERR_*_TIMEOUT`) or `AbortError`.
 */
function timedOutOrAborted(error: unknown, ctx: ConnectorContext): boolean {
  if (callerAbort(ctx) !== undefined) return true;
  if (error instanceof WithheldTextError) return error.timeout;
  if (error instanceof ConnectorCallError) return isTimeout(error);
  return isTimeoutCode(networkErrorCode(error));
}

/** Change recovery wording without rebuilding a provider's shared verdict. */
export function providerFailureMessage(error: ConnectorCallError, message: string): ConnectorCallError {
  return carryFailureFacts(
    error,
    new ConnectorCallError(error.code, message, {
      retryable: error.retryable,
      ...(error.writeOutcome ? { writeOutcome: error.writeOutcome } : {}),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      ...(error.details ? { details: error.details } : {}),
      ...(error.validation ? { validation: error.validation } : {}),
      ...(error.repair ? { repair: error.repair } : {}),
      ...(error.current ? { current: error.current } : {}),
    }),
  );
}

/**
 * Final ambiguous call verdict, including typed handler failures after 2xx
 * and the caller's own abort.
 */
function uncertainProviderFailure(
  vendor: { title: string },
  error: unknown,
  ctx: ConnectorContext | undefined,
): ConnectorCallError {
  if (error instanceof ConnectorCallError && error.writeOutcome === "unknown" && !error.retryable) return error;
  const abort = ctx && callerAbort(ctx);
  if (abort) return callerAborted(vendor, error, abort.reason);
  const details = classifyWithoutAdvice(error);
  const timeout =
    details.code === "timeout" || (details.code === "unavailable" && isTimeoutCode(details.details?.code));
  const common =
    error instanceof ConnectorCallError && (error.code === "unavailable" || error.code === "connector_call_failed");
  const message =
    !timeout && common && error.retryable
      ? `${details.message} Whether the write took effect at ${vendor.title} is unknown; check the target before repeating it.`
      : details.message;
  const code =
    error instanceof ConnectorCallError && (error.code !== "unavailable" || timeout)
      ? error.code
      : timeout
        ? "timeout"
        : "connector_call_failed";
  return carryFailureFacts(
    error,
    new ConnectorCallError(code, message, {
      retryable: false,
      writeOutcome: "unknown",
      // Diagnostics stay with the code they describe.
      ...(error instanceof ConnectorCallError && code === error.code && error.details
        ? { details: error.details }
        : {}),
      ...(error instanceof ConnectorCallError
        ? {
            ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
            ...(error.validation ? { validation: error.validation } : {}),
            ...(error.repair ? { repair: error.repair } : {}),
            ...(error.current ? { current: error.current } : {}),
          }
        : {}),
    }),
  );
}

/**
 * A direct write the caller's own signal aborted after it may have left: a
 * `timeout` when the reason is one (`AbortSignal.timeout`), else
 * `connector_call_failed`. The reason stays the cause, since the caller wrote
 * it, and its class and timeout code stay in `details`, so the caller can
 * still tell its own abort apart on every runtime.
 */
function callerAborted(vendor: { title: string }, error: unknown, reason: unknown): ConnectorCallError {
  const code = networkErrorCode(reason);
  const name = errorLabel(reason);
  return carryFailureFacts(
    error,
    new ConnectorCallError(
      isTimeoutCode(code) ? "timeout" : "connector_call_failed",
      `The caller's signal aborted this call${name ? ` (${name})` : ""} after the write may have reached ` +
        `${vendor.title}. Whether it took effect is unknown; check the target before repeating it.`,
      {
        retryable: false,
        writeOutcome: "unknown",
        cause: reason,
        ...(name || code ? { details: { ...(name ? { name } : {}), ...(code ? { code } : {}) } } : {}),
      },
    ),
  );
}

/**
 * A write the downstream answered with HTTP 401, then credential renewal ran.
 * A server may act on a request before it rejects the token, so the write is
 * never sent again (INV-9), and nothing renewal meets afterwards (a refresh or
 * login that fails, a disconnect, an unreachable token endpoint) may be
 * reported as safe to retry. `renewal` is renewal's failure, or undefined
 * when the credential was renewed and a deliberate repeat will use it.
 *
 * Until renewal succeeds the 401's authorization verdict stands: renewal's
 * own verdict when it reached one, else `code`, the 401's. Either keeps its
 * recovery handoff, which the invocation layer marks `reconciliationRequired`.
 * Only a renewed credential drops the handoff, since nothing is left to
 * recover. Either way the write's outcome is unknown (`writeOutcome`), so a
 * program that catches the failure still reports it.
 */
export function unsentAfterUnauthorized(
  subject: string,
  renewal?: unknown,
  code: "auth_required" | "downstream_oauth_required" = "auth_required",
): ConnectorCallError {
  if (
    renewal instanceof ConnectorCallError &&
    (renewal.code === "auth_required" || renewal.code === "downstream_oauth_required")
  ) {
    return explainedUnauthorizedVerdict(
      carryFailureFacts(
        renewal,
        new ConnectorCallError(renewal.code, renewal.message, { retryable: false, writeOutcome: "unknown" }),
      ),
    );
  }
  // Only the class of what renewal met: its own text may say to try again,
  // which this write must not be told. Operator records keep its facts.
  const renewed =
    renewal === undefined
      ? "The credential is renewed for the next call, but the write"
      : `Renewing the credential failed (${classifyCallError(renewal).code}), and the write`;
  const unsent = new ConnectorCallError(
    renewal === undefined ? "connector_call_failed" : code,
    `${subject} answered this write with HTTP 401. ${renewed} was not sent again, so whether it took effect is ` +
      "unknown: check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
  return explainedUnauthorizedVerdict(renewal === undefined ? unsent : carryFailureFacts(renewal, unsent));
}
