# Provider auth migration

Use this upgrade guide when a maintained provider moves to auth-selected
implementations ([#801](https://github.com/zackbart/connecta/issues/801)).
[Deployment upgrades](./deploying.md#upgrade-an-existing-deployment) cover other
version changes; [integrating services](./integrating.md) covers new connectors.

A dual provider requires `auth`. `{ type: "oauth" }` connects the vendor's
hosted MCP server, OAuth only. A key type connects Connecta's REST connector
with an operator-managed credential. There is no default, and one connector id
uses one implementation: configure two ids for both. The
[decision record](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)
explains why.

## Stripe

Stripe's hosted MCP server stops accepting secret keys and untagged
restricted keys on 2026-10-31. Every `stripe()` call must now name `auth`:

```ts
connectors: [
  stripe("stripe", { purpose: "Organization billing", auth: { type: "oauth" } }),
  stripe("stripe_live", { purpose: "Live billing", auth: { type: "apiKey" }, mode: "production" }),
  stripe("stripe_sandbox", { purpose: "Rehearsal", auth: { type: "apiKey" }, mode: "sandbox" }),
  stripe("stripe_merchant", {
    purpose: "One connected merchant",
    auth: { type: "apiKey" },
    mode: "production",
    connectedAccount: "acct_…",
  }),
]
```

| 0.30 configuration                               | Now                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| No `auth`, or `auth: { type: "oauth" }`          | `auth: { type: "oauth" }`. Same endpoint, reviewed catalog, guide conventions, and grant.                            |
| `auth: { type: "headers", headers }` with `mode` | `auth: { type: "apiKey" }` with `mode`. Paste the key into the connection in the operator UI; literal keys are gone. |
| `auth: { type: "credential" }` with `mode`       | `auth: { type: "apiKey" }` with `mode`. A key stored for the same connector id carries over; run its Test action.    |
| `connectedAccount` with `headers` auth           | `connectedAccount` with `auth: { type: "apiKey" }`; it now works with an operator-managed key.                       |
| `mode` or `connectedAccount` with OAuth          | Refused by name at construction, as before.                                                                          |

The key connector keeps Stripe's tool names (`stripe_api_search`,
`stripe_api_details`, `stripe_api_read`, `stripe_api_write`,
`get_stripe_account_info`, and `get_balance_summary`) with Connecta's own
contracts: search finds operations in a pinned API index, every call is
checked against that index before it is sent, results arrive as
`{ status, data, page? }`, and writes return the `Idempotency-Key` they sent.
A key whose `sk_live_`/`rk_live_` or `sk_test_`/`rk_test_` prefix contradicts
`mode` is refused before any request. Organization keys (`sk_org_…`) need a
`Stripe-Context` header the connector does not send; use an account key.

Lost on the key path: natural-language Sigma (`stripe_analytics`), metrics,
documentation search, the implementation planner, reports, and feedback exist
only on the hosted OAuth connection. Programs calling those tools on a key
connector need an OAuth connector beside it. The
[Stripe skill](https://github.com/zackbart/connecta/blob/main/src/providers/stripe/SKILL.md)
owns the conventions for both.
