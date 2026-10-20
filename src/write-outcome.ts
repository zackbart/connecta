// Whether a dispatched write landed, as far as anyone can know. Shared by the
// invocation layer (which attaches recovery facts to every unknown outcome),
// trusted-program write accounting, and every connector that must tell an
// agent a write it sent once is not safe to repeat (INV-9). It imports only
// errors and operator facts, so none of them depends on another.
import { classifyCallError, ConnectorCallError, WithheldTextError, type CallErrorDetails } from "./errors.js";
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
 * `isError` is an answer, so it is `failed`. Response text does not decide
 * whether an outcome is unknown. A call that was never dispatched is
 * `failed`: nothing was sent.
 * `result_processing_failed` means the downstream call completed.
 */
export function classifyWriteOutcome(outcome: {
  ok: boolean;
  dispatched: boolean;
  answered?: boolean;
  error?: Pick<CallErrorDetails, "code">;
}): WriteState {
  if (outcome.ok) return "ok";
  if (!outcome.dispatched) return "failed";
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
 * while reading its body prove nothing of the kind.
 */
const NEVER_CONNECTED: ReadonlySet<string> = new Set([
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
 * `responded` is whether any HTTP answer arrived.
 */
export function unknownOutcome(vendor: { title: string }, error: unknown, responded: boolean): unknown {
  if (error instanceof WithheldTextError) {
    if (!error.retryable || error.timeout) return error;
  } else {
    if (!(error instanceof ConnectorCallError) || !error.retryable) return error;
    if (error.code !== "unavailable" && error.code !== "connector_call_failed") return error;
    const code = error.details?.code;
    if (code === "timeout" || code === "ETIMEDOUT" || code?.endsWith("_TIMEOUT")) return error;
    if (!responded && code !== undefined && NEVER_CONNECTED.has(code)) return error;
  }
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.title} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false },
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
 * An authorization verdict stays one, never retryable, so its recovery
 * handoff survives: the invocation layer marks it `reconciliationRequired`
 * for a write that was dispatched. Anything else leaves the outcome unknown.
 */
export function unsentAfterUnauthorized(subject: string, renewal?: unknown): ConnectorCallError {
  if (
    renewal instanceof ConnectorCallError &&
    (renewal.code === "auth_required" || renewal.code === "downstream_oauth_required")
  ) {
    return renewal.retryable ? new ConnectorCallError(renewal.code, renewal.message, { retryable: false }) : renewal;
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
    { retryable: false },
  );
  return renewal === undefined ? unsent : carryFailureFacts(renewal, unsent);
}
