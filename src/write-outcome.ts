// Whether a dispatched write landed, as far as anyone can know. Shared by the
// invocation layer (which attaches recovery facts to every unknown outcome)
// and trusted-program write accounting; it imports one type, so neither
// depends on the other.
import type { CallErrorDetails } from "./errors.js";

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
