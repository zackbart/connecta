// Decision 0010's error contract on real code: Stripe's failure mapper,
// expressed as bounded facts, an allowlist of headers, a cross-status rule,
// and a status table, must say exactly what rest.ts says today.
import { describe, expect, it } from "vitest";
import { ConnectorCallError, resendAdviceOf } from "../../errors.js";
import { StatusFailure, toConnectorCallError } from "../../http/errors.js";
import { refusalRequest, type ProviderRequest } from "../../provider-call.js";
import { memoryStorage } from "../../storage/memory.js";
import { classifyWriteOutcome, providerCallFailure } from "../../write-outcome.js";
import { silentLogger } from "../../../test/helpers.js";
import { restCall } from "../_shared/rest/tools.js";
import { stripeErrors } from "./kit-prototype.js";
import { stripeRest } from "./rest.js";

const vendor = stripeRest("sandbox", undefined).vendor;
// A charge read the review lets speak, and an operation it refuses, whose
// failures withhold Stripe's text.
const open = restCall(vendor, "GET", "/v1/charges");
const withheld = restCall(vendor, "POST", "/v1/account_links");

function observed(error: ConnectorCallError) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    retryAfterMs: error.retryAfterMs,
    advice: resendAdviceOf(error),
  };
}

const bodies: Record<string, unknown> = {
  "no body": undefined,
  "card decline": {
    error: {
      type: "card_error",
      code: "card_declined",
      decline_code: "insufficient_funds",
      param: "payment_method",
      message: "Your card has insufficient funds.",
    },
  },
  "lock timeout": { error: { type: "invalid_request_error", code: "lock_timeout", message: "Try again." } },
  "nested param": {
    error: { type: "invalid_request_error", param: "line_items[0][price]", message: "No such price." },
  },
  "a URL in the message": {
    error: { type: "api_error", message: "See https://files.stripe.com/x?token=secret-value for detail." },
  },
};

const headerSets: Record<string, Record<string, string>> = {
  none: {},
  "request id and reason": { "Request-Id": "req_123ABC", "Stripe-Rate-Limited-Reason": "global-rate" },
  "retry-after": { "Retry-After": "4" },
};

describe("Stripe's failure mapper on the kit's error contract (decision 0010)", () => {
  const statuses = [400, 401, 402, 403, 404, 409, 418, 422, 424, 429, 500, 503];
  const cases = statuses.flatMap((status) =>
    Object.entries(bodies).flatMap(([body, value]) =>
      Object.entries(headerSets).flatMap(([headers, entries]) =>
        [open, withheld].map((call) => ({ status, body, value, headers, entries, call })),
      ),
    ),
  );

  it("INV-6: classifies every status, code, header set, and value-safety verdict exactly as rest.ts does", () => {
    expect(vendor.valueSafety.withholdsErrors(open.op)).toBe(false);
    expect(vendor.valueSafety.withholdsErrors(withheld.op)).toBe(true);
    for (const { status, body, value, headers, entries, call } of cases) {
      const today = vendor.failure(status, new Headers(entries), value, call);
      const kit = toConnectorCallError(
        new StatusFailure({
          status,
          headers: new Headers(entries),
          body: value,
          operation: { method: call.method, template: call.op.path },
        }),
        stripeErrors,
        { classification: "read", dispatches: [], withholds: () => vendor.valueSafety.withholdsErrors(call.op) },
      );
      expect(observed(kit), `${status} ${body} ${headers} ${call.op.path}`).toEqual(observed(today));
    }
  });

  it("INV-6: drops a fact outside the token grammar instead of letting prose reach a rule", () => {
    const body = { error: { type: "invalid_request_error", param: "a param with spaces", message: "Bad." } };
    const kit = toConnectorCallError(
      new StatusFailure({
        status: 400,
        headers: new Headers(),
        body,
        operation: { method: "GET", template: "/v1/charges" },
      }),
      stripeErrors,
      { classification: "read", dispatches: [] },
    );
    // rest.ts quotes the param whatever it holds; the kit's bound drops it.
    expect(kit.message).toBe("Stripe invalid_request_error: Bad.");
    expect(vendor.failure(400, new Headers(), body, open).message).toContain("(param a param with spaces)");
  });

  it("INV-9: the kit marks only its own answer's provenance, and the core alone decides the write", () => {
    // Stripe's lock-timeout 429 is a refusal because it is a served 4xx other
    // than 408 on the one request the write sent (#902's provenance (b)), not
    // because of any declaration. The same token on a 503 is no refusal, and
    // Stripe's 424 reads as unavailable, which the core takes as unproven.
    const ctx = { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
    for (const [status, body, known] of [
      [429, bodies["lock timeout"], true],
      [503, bodies["lock timeout"], false],
      [409, bodies["nested param"], true],
      [429, bodies["card decline"], true],
      [424, bodies["no body"], false],
    ] as const) {
      const failure = new StatusFailure({
        status,
        headers: new Headers(),
        body,
        operation: { method: "POST", template: "/v1/charges" },
      });
      const request: ProviderRequest = {
        dispatched: true,
        status,
        auxiliary: false,
        provider: "Stripe",
        method: "POST",
      };
      const mapped = toConnectorCallError(failure, stripeErrors, {
        classification: "write",
        dispatches: [{ write: true, state: "answered", status, failure, request }],
      });
      // The kit adds no outcome of its own: rest.ts's fields, advice included.
      expect(observed(mapped), `${status}`).toEqual(observed(vendor.failure(status, new Headers(), body, open)));
      expect(mapped.writeOutcome).toBeUndefined();
      expect(refusalRequest(mapped) === request, `${status}`).toBe(status !== 503);
      // The core's decision for a transport outside a ledger, as guarded-fetch hands it the same facts.
      const decided = providerCallFailure(ctx, { title: "Stripe" }, mapped, {
        dispatched: true,
        status,
        fallback: "write",
      });
      expect(classifyWriteOutcome({ ok: false, dispatched: true, error: decided as never }), `${status}`).toBe(
        known ? "failed" : "unknown",
      );
    }
  });
});
