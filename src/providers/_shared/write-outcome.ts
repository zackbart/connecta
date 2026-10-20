// A write sent once must never come back advertised as safe to repeat (INV-9).
// Shared by the REST family's `callRest` and every hand-written provider
// whose writes go through a guarded transport.
import type { GuardedTransport } from "../../connectors/guarded-fetch.js";
import { ConnectorCallError } from "../../errors.js";

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
 * (INV-9). Definite answers pass through: refusals and 4xx verdicts, a failure
 * proven to precede any connection, and timeouts, which the invocation layer
 * already reports as `write_outcome_unknown`. Exported so a named write tool
 * with its own transport (an upload) applies the same rule.
 */
export function unknownOutcome(vendor: { title: string }, error: unknown, responded: boolean): unknown {
  if (!(error instanceof ConnectorCallError) || error.code !== "unavailable" || !error.retryable) return error;
  const code = error.details?.code;
  if (code === "timeout" || (!responded && code !== undefined && NEVER_CONNECTED.has(code))) return error;
  return new ConnectorCallError(
    "connector_call_failed",
    `${error.message} Whether the write took effect at ${vendor.title} is unknown: it carried no idempotency key, ` +
      "so check the target before repeating it.",
    { retryable: false },
  );
}

/**
 * The same transport for a write it must send once: a 5xx, a broken-off
 * reply, or a connection lost after sending leaves the outcome unknown, so
 * {@link unknownOutcome} turns the retryable `unavailable` it would have
 * raised into a failure that is not retried. Which requests are writes is the
 * provider's call, by tool, never by HTTP method alone: Breeze writes with
 * GET, and CCB searches with POST.
 */
export function sendingOnce(send: GuardedTransport, vendor: { title: string }): GuardedTransport {
  return async (request, ctx, map) => {
    let responded = false;
    try {
      return await send(request, ctx, (response, mapCtx) => {
        responded = true;
        return map(response, mapCtx);
      });
    } catch (error) {
      throw unknownOutcome(vendor, error, responded);
    }
  };
}
