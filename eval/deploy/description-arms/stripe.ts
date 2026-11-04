import { hatchDiscovery, type ProviderTable } from "./types.js";

const READ_RULES =
  "Pass page.nextCursor as cursor; starting_after or ending_before only on a first request. v1 parameters use bracketed form encoding; v2 bodies are JSON.";
const WRITE_RULES =
  "POST sends an Idempotency-Key, DELETE none. v1 bodies are form-encoded, v2 JSON. Upload files in the Stripe Dashboard.";

export const STRIPE: ProviderTable = {
  tools: {
    get_stripe_account_info: {
      terse: "Read the Stripe account this key reaches: id, name, mode and connected account.",
      disambiguation:
        "Confirm which Stripe account and mode this key reaches before other calls; get_balance_summary reads money.",
      example: 'Read the Stripe account this key reaches. Example: {"fields":["accountId","mode"]}.',
    },
    get_balance_summary: {
      terse: "Read available and pending Stripe balance per currency, in minor units.",
      disambiguation:
        "Read available and pending balance per currency, in minor units. For balance transactions use stripe_api_read.",
      example:
        'Read available and pending balance per currency, in minor units. Example: {"fields":["available","pending"]}.',
    },
    ...hatchDiscovery(
      "Stripe",
      '{"query":"refund charge","method":"POST"}',
      '{"method":"POST","path":"/v1/refunds"}',
      "stripe",
    ),
    stripe_api_read: {
      terse: `Read a reviewed Stripe API operation. ${READ_RULES}`,
      disambiguation: `Read a Stripe operation no named tool covers, after stripe_api_search finds its path. ${READ_RULES}`,
      example: `Read a reviewed Stripe API operation. Example: {"path":"/v1/customers","query":{"email":"ada@example.com","limit":5},"fields":["id"]}. ${READ_RULES}`,
    },
    stripe_api_write: {
      terse: `Send a reviewed Stripe API write. ${WRITE_RULES}`,
      disambiguation: `Change Stripe state through an operation stripe_api_search found; reconcile with stripe_api_read before any retry. ${WRITE_RULES}`,
      example: `Send a reviewed Stripe API write. Example: {"method":"POST","path":"/v1/refunds","body":{"charge":"ch_123","amount":1250}}. ${WRITE_RULES}`,
    },
  },
};
