// Node-only: the shared value-safety harness reads the maintainer detection script in scripts/.
import candidates from "./value-safety.candidates.json";
import source from "./openapi.source.json";
import { openapi } from "./openapi.generated.js";
import { STRIPE_VALUE_SAFETY } from "./value-safety.js";
import { OperationIndex } from "../_shared/rest/operation-index.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { describeValueSafety } from "../../../test/fixtures/value-safety.js";
import { stripe } from "./index.js";

const KEY = "sk_test_value_safety";

describeValueSafety("Stripe", {
  table: STRIPE_VALUE_SAFETY,
  index: new OperationIndex(openapi, { vendor: "stripe", title: "Stripe" }),
  source,
  candidates,
  // A Checkout Session bound to a customer withholds its page.
  resourceExamples: { "checkout.session": { customer: "cus_1" } },
  counts: { refuse: 13, redact: 106, safe: 228 },
  connector: () => stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, mode: "sandbox" }),
  ctx: () => ({ ...connectorContext(), credential: { get: async () => KEY, getAll: async () => ({ value: KEY }) } }),
  echo: {
    tool: "stripe_api_read",
    args: { path: "/v1/webhook_endpoints/we_1" },
    respond: (marker) =>
      Response.json(
        { error: { type: "invalid_request_error", code: "parameter_invalid", message: `secret ${marker} exists` } },
        { status: 400 },
      ),
  },
});
