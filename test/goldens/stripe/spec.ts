import { stripe } from "../../../src/providers/stripe/index.js";
import { defineGoldenSpec } from "../harness.js";

const CUSTOMER = {
  id: "cus_1",
  object: "customer",
  email: "alice@example.com",
  name: "Alice",
  livemode: false,
  metadata: { tier: "gold" },
};

const CHARGE = (id: string, amount: number) => ({
  id,
  object: "charge",
  amount,
  currency: "usd",
  customer: "cus_1",
  status: "succeeded",
  billing_details: { name: "Alice" },
});

export default defineGoldenSpec({
  provider: "stripe",
  create: () => stripe("billing", { purpose: "Rehearsing billing changes", auth: { type: "apiKey" }, mode: "sandbox" }),
  credential: "sk_test_sK3x8Qm1Vz5/123+456=",
  failureReply: (status, message) => ({
    status,
    headers: { "request-id": "req_golden" },
    body: {
      error: {
        type: status >= 500 ? "api_error" : "invalid_request_error",
        code: `golden_${status}`,
        message: `${message}.`,
      },
    },
  }),
  calls: [
    { tool: "stripe_api_search", args: { query: "refund", method: "POST", limit: 3 } },
    { tool: "stripe_api_details", args: { method: "GET", path: "/v1/payment_intents/pi_123", param: "expand" } },
    {
      tool: "stripe_api_read",
      args: {
        path: "/v1/charges",
        query: { customer: "cus_1", expand: ["data.customer"], created: { gte: 10 }, limit: 2 },
        fields: ["data.id", "data.amount"],
      },
      replies: [
        {
          headers: { "request-id": "req_list" },
          body: {
            object: "list",
            url: "/v1/charges",
            has_more: true,
            data: [CHARGE("ch_1", 500), CHARGE("ch_2", 600)],
          },
        },
      ],
    },
    {
      label: "stripe_api_read reviewed POST",
      tool: "stripe_api_read",
      args: { method: "POST", path: "/v1/invoices/create_preview", body: { customer: "cus_1" } },
      replies: [
        {
          body: {
            object: "invoice",
            customer: "cus_1",
            amount_due: 2500,
            currency: "usd",
            lines: { object: "list", data: [{ id: "il_1", amount: 2500, description: "Gold plan" }], has_more: false },
          },
        },
      ],
    },
    {
      tool: "stripe_api_write",
      args: {
        method: "POST",
        path: "/v1/customers/cus_1",
        body: {
          email: "alice@example.com",
          metadata: { tier: "gold", stale: "" },
          invoice_settings: { custom_fields: [{ name: "PO", value: "42" }], default_payment_method: null },
          preferred_locales: [],
        },
      },
      replies: [{ body: CUSTOMER }],
    },
    {
      label: "stripe_api_write DELETE",
      tool: "stripe_api_write",
      args: { method: "DELETE", path: "/v1/customers/cus_1" },
      replies: [{ body: { id: "cus_1", object: "customer", deleted: true } }],
    },
    {
      tool: "get_stripe_account_info",
      replies: [
        {
          body: {
            id: "acct_1",
            object: "account",
            business_profile: { name: "Grace Co" },
            country: "US",
            default_currency: "usd",
            charges_enabled: true,
            payouts_enabled: false,
            settings: { dashboard: { display_name: "Grace" } },
          },
        },
      ],
    },
    {
      tool: "get_balance_summary",
      replies: [
        {
          body: {
            object: "balance",
            livemode: false,
            available: [{ amount: 1099, currency: "usd", source_types: { card: 1099 } }],
            pending: [{ amount: 0, currency: "usd" }],
            instant_available: [{ amount: 500, currency: "usd" }],
          },
        },
      ],
    },
  ],
  echo: {
    tool: "stripe_api_read",
    args: { path: "/v1/customers/cus_1" },
    replies: (text) => [{ body: { id: "cus_1", object: "customer", description: text } }],
  },
  failures: {
    read: { tool: "stripe_api_read", args: { path: "/v1/customers/cus_1" } },
    write: {
      tool: "stripe_api_write",
      args: { method: "POST", path: "/v1/customers", body: { email: "bob@example.com", name: "Bob" } },
    },
  },
});
