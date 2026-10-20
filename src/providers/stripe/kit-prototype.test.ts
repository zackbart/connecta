// Decision 0010's error contract on real code: Stripe's failure mapper,
// expressed as bounded facts, an allowlist of headers, a cross-status rule,
// and a status table, must say exactly what rest.ts says today.
import { describe, expect, it } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { StatusFailure, toConnectorCallError, writeOutcomeOf } from "../../http/errors.js";
import { restCall } from "../_shared/rest/tools.js";
import { stripeErrors } from "./kit-prototype.js";
import { stripeRest } from "./rest.js";

const vendor = stripeRest("sandbox", undefined).vendor;
// A charge read the review lets speak, and an operation it refuses, whose
// failures withhold Stripe's text.
const open = restCall(vendor, "GET", "/v1/charges");
const withheld = restCall(vendor, "POST", "/v1/account_links");

function observed(error: ConnectorCallError) {
  return { code: error.code, message: error.message, retryable: error.retryable, retryAfterMs: error.retryAfterMs };
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

  it("INV-9: a definite own refusal adopts the core contract; raw 5xx still needs non-execution proof", () => {
    for (const [status, body, proved] of [
      [429, bodies["lock timeout"], true],
      [503, bodies["lock timeout"], false],
      [409, bodies["nested param"], false],
      [429, bodies["card decline"], false],
    ] as const) {
      const failure = new StatusFailure({
        status,
        headers: new Headers(),
        body,
        operation: { method: "POST", template: "/v1/charges" },
      });
      const map = (errors: typeof stripeErrors) =>
        toConnectorCallError(failure, errors, {
          classification: "write",
          dispatches: [{ write: true, state: "answered", status, failure }],
        });
      const result = map(stripeErrors);
      if (status === 503)
        expect(result).toMatchObject({ retryable: false, retryAfterMs: undefined, writeOutcome: "unknown" });
      else {
        expect(observed(result)).toEqual(observed(vendor.failure(status, new Headers(), body, open)));
        expect(writeOutcomeOf(result)).toBeUndefined();
        if (proved) expect(result).toMatchObject({ code: "conflict", retryable: true, retryAfterMs: 1000 });
      }
      const { nonExecution: _proof, ...withoutProof } = stripeErrors;
      expect(observed(map(withoutProof))).toEqual(observed(result));
      expect(writeOutcomeOf(map(withoutProof))).toBe(writeOutcomeOf(result));
    }
  });
});
