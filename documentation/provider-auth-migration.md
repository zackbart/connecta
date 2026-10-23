# Provider auth migration

Hosted selections described in this historical migration are now removed.
For Stripe, Vercel, Cloudflare, Notion, Mixpanel, and GitHub hosted connections,
use the [current hosted MCP migration guide](./hosted-mcp-migration.md).
The API migrations below remain applicable.

Use this upgrade guide when moving a Stripe, Vercel, or Cloudflare
deployment from 0.30 to 0.31, where `auth` selects each provider's
implementation.
[Deployment upgrades](./deploying.md#upgrade-an-existing-deployment) cover other
version changes; [integrating services](./integrating.md) covers new connectors.

A dual provider requires `auth`. `{ type: "oauth" }` connects the vendor's
hosted MCP server, OAuth only. A key type connects Connecta's REST connector
with an operator-managed credential. There is no default, and one connector id
uses one implementation: configure two ids for both.

## Stripe

## Choose OAuth or an API key

Import `stripe` from `@zackbart/connecta/providers/stripe`. Choose one of two setup paths:

```ts
// OAuth: Stripe's hosted MCP. Authorize the connection with Stripe.
stripe("billing", { purpose: "Payments", auth: { type: "oauth" } });
stripe("billing", { purpose: "Revenue reports", auth: { type: "oauth" }, readOnly: true });

// API key: Connecta's REST connector. Paste the key into this connection in the operator UI.
stripe("billing", { purpose: "Payments", auth: { type: "apiKey" }, mode: "production" });
stripe("billing", { purpose: "Revenue reports", auth: { type: "apiKey" }, mode: "production", readOnly: true });
```

For an API key, set `mode` to `"production"` or `"sandbox"` to match the key.
Use a secret (`sk_`) or restricted (`rk_`) key. For read-only access, prefer a
restricted `rk_` key configured with only read permissions: Stripe enforces
those permissions too. Connecta's `readOnly: true` omits non-read tools and
refuses their calls on every endpoint. Omit it for the default writable connector;
endpoint restrictions still apply. OAuth needs no `mode` and can reach both live
and sandbox accounts through Stripe's account selectors.

Stripe's hosted MCP server stops accepting secret keys and untagged
restricted keys on 2026-10-31; Stripe still documents agent-tagged restricted
keys for it. Connecta's hosted Stripe connection is OAuth only either way, and
every key, tagged or not, uses the REST connector. Every `stripe()` call must
now name `auth`:

```ts
connectors: [
  stripe("stripe", {
    purpose: "Organization billing",
    auth: { type: "oauth" },
  }),
  stripe("stripe_live", {
    purpose: "Live billing",
    auth: { type: "apiKey" },
    mode: "production",
  }),
  stripe("stripe_sandbox", {
    purpose: "Rehearsal",
    auth: { type: "apiKey" },
    mode: "sandbox",
  }),
  stripe("stripe_merchant", {
    purpose: "One connected merchant",
    auth: { type: "apiKey" },
    mode: "production",
    connectedAccount: "acct_…",
  }),
];
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
`{ status, data, page? }`, and POST writes send the caller's `idempotencyKey`
or a generated one as `Idempotency-Key` and return it (DELETE sends none).
Caller-supplied keys may contain up to 255 characters. An ambiguous POST write
also returns the key in `uncertainCall.recovery.idempotencyKey`, including when
the call deadline interrupts it. See [argument recovery](./meta-tools.md#argument-recovery)
before retrying: a custom connector that wraps or composes Stripe calls gets
the key as a diagnostic only, never advice to reuse it.
Every request, v1 and v2, sends `Stripe-Version: 2026-09-30.endive`, the
version of the pinned index, whatever the account's default API version, so
response shapes and accepted parameters follow that version. Check fields
your programs rely on with `stripe_api_details`.
A key whose `sk_live_`/`rk_live_` or `sk_test_`/`rk_test_` prefix contradicts
`mode` is refused before any request. Organization keys (`sk_org_…`) need a
`Stripe-Context` header the connector does not send; use an account key.

Lost on the key path: natural-language Sigma (`stripe_analytics`), metrics,
documentation search, the implementation planner, reports, and feedback exist
only on the hosted OAuth connection. Programs calling those tools on a key
connector need an OAuth connector beside it. Read the connector runtime guide with `connecta.skill("connector:<id>")` in `execute_code` for its usage conventions.

## Cloudflare

Every `cloudflare()` call must now name `auth`. 0.30 defaulted to hosted MCP
when `surface` was omitted; that default is gone with `surface` itself:

```ts
connectors: [
  cloudflare("cloudflare", {
    purpose: "Estate changes",
    auth: { type: "oauth" },
  }),
  cloudflare("cloudflare_api", {
    purpose: "Production DNS and Workers",
    auth: { type: "apiToken" },
    accountId: "<account id>",
    zoneId: "<zone id>",
    pin: { accountIds: ["<account id>"] },
  }),
  cloudflare("cloudflare_legacy", {
    purpose: "Legacy zones behind a user key",
    auth: { type: "globalApiKey" },
    pin: { zoneIds: ["<zone id>"] },
  }),
];
```

| 0.30 configuration                                   | Now                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No `surface`, or `surface: "mcp"`, with OAuth        | `auth: { type: "oauth" }`. Same endpoint, catalog, and grant.                                                                            |
| `surface: "mcp"` with `auth: { type: "credential" }` | `auth: { type: "apiToken" }`: bearer tokens no longer reach `mcp.cloudflare.com`. A token stored for the same connector id carries over. |
| `surface: "api"` (API token)                         | `auth: { type: "apiToken" }` with the same `accountId`, `zoneId`, `baseUrl`, and `maxConcurrency`.                                       |
| `surface: "api"`, `authentication: "globalApiKey"`   | `auth: { type: "globalApiKey" }` plus `pin: { accountIds, zoneIds }`, or `unpinned: true` to accept the user's whole estate.             |
| `credential` override                                | Removed; the credential slot's copy is fixed.                                                                                            |
| `callAdmission` with hosted MCP                      | Unchanged under `auth: { type: "oauth" }`.                                                                                               |

The key connector is complete on its own. JSON writes that 0.30 refused on an
API token (they belonged to hosted `execute`) go through
`cloudflare_api_write`, checked against a pinned API index before they are
sent. The 23 hand-written reads (`get_zone`, `list_dns_records`,
`list_r2_objects`, `list_pages_deployments`, and the rest) are replaced by
`cloudflare_api_read` on the same paths; results are Cloudflare's own
`result`, unprojected, so programs pass `select` instead of reading the old
projections. `list_accounts`, `list_zones`, and `cloudflare_api_upload` keep
their names (upload now takes `parts` for multipart); `verify_api_token` and
`verify_global_api_key` become `verify_credential`; `cloudflare_api_get` and
`cloudflare_api_mutate` become `cloudflare_api_read` and `cloudflare_api_write`.
`graphql_query` is new.

Credentials stay in the dashboard. The key connector refuses every operation
that mints, rotates, or returns a credential (API tokens, Access service
tokens, R2 temporary credentials, signing keys, direct-upload URLs, deploy
hooks) and redacts stored secrets on every result. A pinned connector refuses
operations that name no account or zone unless they are reviewed safe, such
as `/certificates` and `/memberships/{id}`.

Read-only endpoints: hosted `execute` is always a write, even for a program
that only reads, so a `readOnly` endpoint on an OAuth connector reaches only
`search`.
Use an API-token connector for read-only API access.

Lost on each path. OAuth has no index validation, named tools, GraphQL tool,
upload tool, or pin; Cloudflare's OAuth grant is the only boundary. A key has
no hosted `search` over Cloudflare's live OpenAPI document; the pinned index
replaces it and `providers:check` reports when it falls behind. A Global API
Key cannot reach R2, which accepts API tokens only. Read the connector runtime guide with `connecta.skill("connector:<id>")` in `execute_code` for its usage conventions.

## Value safety on every key connector

All four key connectors now share one value-safety mechanism: a reviewed
table per vendor over every operation the detector flags in the pinned spec,
one redaction pass on every result, and one error policy
([architecture](./architecture.md#value-safety-for-rest-vendors)). Results
lose fields they returned before. A `"[redacted]"` value is never the real
one; read or rotate withheld secrets in the vendor's dashboard.

- **Stripe** refuses operations that hand out a credential: ephemeral keys,
  Terminal connection tokens, account links, Express login links, account and
  customer sessions, billing portal sessions, file link creation, Financial
  Connections session creation, and the meter event session. Results redact
  client secrets (PaymentIntents, SetupIntents, Checkout and Identity
  sessions, Sources, Financial Connections, invoice confirmation secrets),
  webhook and event destination signing secrets, Apps secret payloads,
  app-install authorization codes, Terminal Wi-Fi passwords, forwarded
  request header values, and Issuing card numbers and CVCs; webhook, file
  link, and pre-signed import URLs keep only their scheme and host, and the
  rules follow each object into expansions, lists, and events (an expanded
  File's links, an event's `previous_attributes`). Identity verification
  URLs are unchanged. A Checkout Session's URL is returned whole only for a
  guest payment session (`mode: "payment"`, no `customer` or
  `customer_account`, no customer creation, no saved payment method options);
  any other session returns only its scheme and host, because its page can
  show, reuse, or remove a customer's saved payment methods. v2 account
  links and Terminal onboarding links are refused too. Issuing `number` and
  `cvc` expansions are refused on every Issuing path, not only cards.
  Failures of credential-bearing operations keep Stripe's type, code, and
  param but not its message. Create client-side sessions and links from your
  own server code.

- **Vercel** replaces environment values with `"[redacted]"` instead of
  dropping the field, and withholds Vercel's error text for every reviewed
  operation and every operation whose request takes a credential-named
  field, not only secret families. Audit event invite codes, integration
  drain headers, and route header values are redacted too.
- **Cloudflare** redacts Hyperdrive database passwords, RealtimeKit storage
  credentials, transform-rule header values, and dispatch binding values,
  and reduces notification, RealtimeKit, and data security webhook
  destinations to their scheme and host. A credential-named field now loses
  its whole value, not only its strings (a `cookies` list, a variable named
  `API_KEY`).

## Contributor reference

[Decision 0005](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)
explains why auth selects the implementation. Maintained provider source
skills and review tables live under `src/providers/` in the repository;
`src/providers/vercel/value-safety.ts` owns Vercel's reviewed table.
