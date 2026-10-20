// A write sent once must never come back advertised as safe to repeat (INV-9).
// Every hand-written provider whose writes go through a guarded transport
// sends them through `sendingOnce`; the rule itself is core's.
import type { GuardedTransport } from "../../connectors/guarded-fetch.js";
import { unknownOutcome } from "../../write-outcome.js";

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
