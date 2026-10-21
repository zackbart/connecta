// Whether a dispatched write landed, as far as anyone can know. Shared by the
// invocation layer (which attaches recovery facts to every unknown outcome),
// trusted-program write accounting, and every connector that must tell an
// agent a write it sent once is not safe to repeat (INV-9). It imports only
// classification, errors and operator facts, without depending on a provider.
import { callClassification } from "./call-classification.js";
import type { ConnectorContext } from "./types.js";
import { classifyCallError, ConnectorCallError, WithheldTextError, type CallErrorDetails } from "./errors.js";
import { isKnownProviderFailure, knownProviderFailure, providerRequests, refusalRequest } from "./provider-call.js";
import { carryFailureFacts } from "./operator-record.js";

/** How a dispatched write ended, as far as anyone can know. */
export type WriteState = "ok" | "failed" | "unknown";

/**
 * Whether a write landed, as far as anyone can know.
 *
 * `unknown` is the outcome a result must never paper over: the call left
 * connecta and no answer came back, so sending it again could do it twice and
 * not sending it could leave it undone. That is a dispatched call that timed
 * out, was cancelled, found the service unavailable, or failed any way that
 * is not a verdict. A refusal code (`REFUSALS`) or a downstream tool's own
 * `isError` is an answer, so it is `failed`, unless the connector said the
 * outcome is unknown (`writeOutcome`): a verdict reached only after the
 * downstream had the write, such as a renewal that failed after a 401, keeps
 * its code for the handoff but proves nothing about the write. Response text
 * does not decide whether an outcome is unknown. A call that was never
 * dispatched is `failed`: nothing was sent.
 * `result_processing_failed` means the downstream call completed.
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
  if (isKnownProviderFailure(outcome.error)) return "failed";
  const code = outcome.error?.code;
  if (code === "result_processing_failed") return "ok";
  if (code === "timeout" || code === "cancelled" || code === "unavailable") {
    return "unknown";
  }
  if (code !== undefined && REFUSALS.has(code)) return "failed";
  return outcome.answered === true ? "failed" : "unknown";
}

/**
 * Codes that say the other side refused the call rather than acted on it:
 * the credential, the arguments, the resource, the rate, or a base version
 * someone else already moved past (`conflict`). Anything else a
 * connector reports after dispatch — `connector_call_failed` from a response
 * too large to read, a redirect it would not follow, a body it could not
 * parse, a 5xx — may come after the write landed, so only a downstream
 * tool's own `isError` answer makes it a known failure.
 */
const REFUSALS = new Set([
  "auth_required",
  "downstream_oauth_required",
  "provider_permission_denied",
  "invalid_args",
  "not_found",
  "rate_limited",
  "input_required_unsupported",
  "conflict",
]);

/**
 * Network failures that prove nothing was sent, but only when `fetch` itself
 * rejected before any response existed: no connection was ever established,
 * so the vendor cannot have acted. Once a response arrived, the same codes
 * while reading its body prove nothing of the kind. Nor do they when a body
 * producer outside the runtime may have raised one after bytes left: the
 * guarded transport accepts the errno only for a request it saw stream no
 * body bytes of its own (`neverConnected`).
 */
export const NEVER_CONNECTED: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EHOSTUNREACH",
]);

/**
 * A request that is not safe to repeat (a write without an idempotency key)
 * must never be advertised as retryable after it may have reached the vendor
 * (INV-9): a 5xx, a gateway's 502 to 504, a broken-off reply, or a connection
 * lost after sending. Definite answers pass through: refusals and 4xx
 * verdicts (a 429 or a lock conflict included), a failure proven to precede
 * any connection, and timeouts (`timeout`, `ETIMEDOUT`, `*_TIMEOUT`), which
 * the invocation layer already reports as `write_outcome_unknown`.
 * `contacted` is whether the vendor may have been reached: any HTTP answer
 * arrived, or the transport could not prove it never connected.
 */
export function unknownOutcome(vendor: { title: string }, error: unknown, contacted: boolean): unknown {
  if (error instanceof WithheldTextError) {
    if (!error.retryable || error.timeout) return error;
  } else {
    if (!(error instanceof ConnectorCallError) || !error.retryable) return error;
    if (error.code !== "unavailable" && error.code !== "connector_call_failed") return error;
    const code = error.details?.code;
    if (code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT")) return error;
    if (!contacted && code !== undefined && NEVER_CONNECTED.has(code)) return error;
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.title} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
}

/**
 * One failure decision for API providers. The served verdict outranks every
 * transport default and replay-safety hint. Dispatch facts come from the
 * transport, never from a provider's interpretation of its HTTP method.
 * Definite refusals and proven pre-connection failures remain known failures;
 * a write is a known failure only on that positive evidence.
 */
export function providerCallFailure(
  ctx: ConnectorContext,
  vendor: { title: string },
  error: unknown,
  facts: {
    dispatched: boolean;
    responded: boolean;
    /** The transport's own proof, when it gathered any; else an errno with no answer is accepted. */
    neverConnected?: boolean;
    status?: number;
    fallback: "read" | "write";
    repeatable?: boolean;
    finalize?: boolean;
    /** The handler ran and may have sent requests the ledger never saw. */
    untracked?: boolean;
  },
): unknown {
  const served = callClassification(ctx);
  if ((served ?? facts.fallback) !== "write") return error;
  const requests = providerRequests(ctx);
  // Guarded transports collect facts; only api() knows when the logical call
  // has ended. Google may add phases or recovery words in the meantime.
  if (requests && !facts.finalize) return error;
  if (requests) {
    // An empty or partial ledger is no proof for a handler that can send
    // around it: nothing it saw rules out a request it did not see.
    if (facts.untracked) return uncertainProviderFailure(vendor, error);
    // In flight counts as sent. The call is closed, so nothing else leaves.
    const dispatched = requests.filter(
      (request) => request.dispatched && !request.auxiliary && !request.neverConnected,
    );
    if (dispatched.length === 0) return knownProviderFailure(error);
    const refusal = refusalRequest(error);
    // An explicit unknown marker (notably the existing 401 handoff) wins.
    if (
      !(error instanceof ConnectorCallError && error.writeOutcome === "unknown") &&
      dispatched.length === 1 &&
      dispatched[0] === refusal
    )
      return knownProviderFailure(error);
    if (served === undefined && dispatched.length === 1 && dispatched[0]?.repeatable) return error;
    return uncertainProviderFailure({ title: dispatched[0]?.provider ?? vendor.title }, error);
  }
  if (!facts.dispatched) return error;
  // A direct transport user may prove idempotency. A deployment's served
  // write verdict still requires reconciliation rather than retry advice.
  if (served === undefined && facts.repeatable === true) return error;
  // Whether the vendor may have been reached: a transport's own evidence
  // decides, so an errno it could not trust counts as possible contact.
  const contact = facts.responded || facts.neverConnected === false;
  if (!(error instanceof ConnectorCallError)) return unknownOutcome(vendor, error, contact);
  if (error.writeOutcome === "unknown") return error;
  const code = error.details?.code;
  if (!contact && code !== undefined && NEVER_CONNECTED.has(code)) return error;
  if (error.code === "timeout" || code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT")) {
    return error; // The invocation owns timeout/cancellation outcomes.
  }
  // A 5xx cannot prove refusal, even when its body names a quota/auth reason.
  const serverError = facts.status !== undefined && facts.status >= 500;
  if (
    !serverError &&
    (REFUSALS.has(error.code) || (facts.status !== undefined && facts.status >= 400 && error.code !== "unavailable"))
  )
    return knownProviderFailure(error);
  if (error.code !== "unavailable" && error.code !== "connector_call_failed" && !serverError) return error;
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
  const converted = unknownOutcome(vendor, error, contact);
  if (converted instanceof ConnectorCallError && converted !== error) return carryFailureFacts(error, converted);
  return carryFailureFacts(
    error,
    new ConnectorCallError(serverError ? "connector_call_failed" : error.code, error.message, {
      retryable: false,
      writeOutcome: "unknown",
    }),
  );
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

/** Final ambiguous call verdict, including typed handler failures after 2xx. */
function uncertainProviderFailure(vendor: { title: string }, error: unknown): ConnectorCallError {
  if (error instanceof ConnectorCallError && error.writeOutcome === "unknown" && !error.retryable) return error;
  const details = classifyCallError(error);
  const networkCode = details.details?.code;
  const timeout =
    details.code === "timeout" ||
    (details.code === "unavailable" &&
      (networkCode === "timeout" || networkCode === "ETIMEDOUT" || networkCode?.endsWith("_TIMEOUT") === true));
  const common =
    error instanceof ConnectorCallError && (error.code === "unavailable" || error.code === "connector_call_failed");
  const message =
    !timeout && common && error.retryable
      ? `${error.message} Whether the write took effect at ${vendor.title} is unknown; check the target before repeating it.`
      : details.message;
  return carryFailureFacts(
    error,
    new ConnectorCallError(
      error instanceof ConnectorCallError && (error.code !== "unavailable" || timeout)
        ? error.code
        : timeout
          ? "timeout"
          : "connector_call_failed",
      message,
      {
        retryable: false,
        writeOutcome: "unknown",
        ...(error instanceof ConnectorCallError
          ? {
              ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
              ...(error.details ? { details: error.details } : {}),
              ...(error.validation ? { validation: error.validation } : {}),
              ...(error.repair ? { repair: error.repair } : {}),
              ...(error.current ? { current: error.current } : {}),
            }
          : {}),
      },
    ),
  );
}

/**
 * A write the downstream answered with HTTP 401. A server may act on a
 * request before it rejects the token, so the write is never sent again
 * (INV-9), and nothing credential renewal meets afterwards (a refresh or
 * login that fails, a disconnect, an unreachable token endpoint) may be
 * reported as safe to retry. `renewal` is renewal's failure, or undefined
 * when the credential was renewed and a deliberate repeat will use it.
 *
 * An authorization verdict keeps its code, never retryable, so its recovery
 * handoff survives: the invocation layer marks it `reconciliationRequired`.
 * Either way the write's outcome is unknown (`writeOutcome`), so a program
 * that catches the failure still reports it.
 */
export function unsentAfterUnauthorized(subject: string, renewal?: unknown): ConnectorCallError {
  if (
    renewal instanceof ConnectorCallError &&
    (renewal.code === "auth_required" || renewal.code === "downstream_oauth_required")
  ) {
    return carryFailureFacts(
      renewal,
      new ConnectorCallError(renewal.code, renewal.message, { retryable: false, writeOutcome: "unknown" }),
    );
  }
  // Only the class of what renewal met: its own text may say to try again,
  // which this write must not be told. Operator records keep its facts.
  const renewed =
    renewal === undefined
      ? "The credential is renewed for the next call, but the write"
      : `Renewing the credential failed (${classifyCallError(renewal).code}), and the write`;
  const unsent = new ConnectorCallError(
    "connector_call_failed",
    `${subject} answered this write with HTTP 401. ${renewed} was not sent again, so whether it took effect is ` +
      "unknown: check the target before repeating it.",
    { retryable: false, writeOutcome: "unknown" },
  );
  return renewal === undefined ? unsent : carryFailureFacts(renewal, unsent);
}
