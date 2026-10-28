# Provider auth migration

This guide covers the 0.30-to-0.31 change to auth-selected implementations.
For current versions, follow [deployment upgrades](./deploying.md#upgrade-an-existing-deployment)
and [hosted MCP migration](./hosted-mcp-migration.md); hosted selectors below
are historical.

A dual provider requires `auth`. `{ type: "oauth" }` connects the vendor's
hosted MCP server, OAuth only. A key type connects Connecta's REST connector
with an operator-managed credential. There is no default, and one connector id
uses one implementation: configure two ids for both.

## Stripe

For current API-key setup, use [Maintained provider setup](./providers.md#stripe).
For the 0.35 argument and paging changes, use [Stripe surface migration](./provider-migration-0.35.md#stripe).

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

## Notion

The maintained Notion API provider is removed in 0.35. See the
[provider removal migration](./provider-migration-0.35.md#remove-infisical-notion-and-mixpanel)
and use generic `remoteMcp()` for the hosted server.

## Vercel

Every `vercel()` call must now name `auth`. `surface` is gone, and so are the
0.29 ownership rules that made the REST complement refuse whatever the hosted
server also covered: each implementation is complete on its own.

```ts
connectors: [
  vercel("vercel", { purpose: "Deployment diagnosis", auth: { type: "oauth" } }),
  vercel("vercel_rest", { purpose: "Production apps", auth: { type: "token" }, teamId: "team_…" }),
]
```

| 0.30 configuration                                                    | Now                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `surface`, or `surface: "mcp"`                                     | `auth: { type: "oauth" }`. Same endpoint, reviewed catalog, and grant.                                                                                        |
| `surface: "api"` with `teamId` or `baseUrl`                           | `auth: { type: "token" }` with the same options. A token stored for the same connector id carries over; run its Test action.                                  |
| `defaultPageSize`                                                     | Removed (it already had no effect). Pass `limit` in `query`, and follow `page.next` as `page.param`.                                                          |
| `teamId` or `baseUrl` with OAuth                                      | Refused by name at construction.                                                                                                                              |
| `vercel_api_get`, `vercel_api_mutate`                                 | `vercel_api_read` and `vercel_api_write`: `query` is a JSON object, not name/value pairs, and `teamId: null` replaces `personalAccount: true`.                |
| `verify_project_domain`, `remove_project_domain`, `delete_deployment` | `vercel_api_write` with the operation from `vercel_api_search`, such as `DELETE /v13/deployments/{id}`.                                                       |
| `vercel_api_upload` with any path and headers                         | `vercel_api_upload` on octet-stream operations in the index (`POST /v2/files`, project avatars, Remote Cache artifacts); Connecta computes `x-vercel-digest`. |

The token connector serves `vercel_api_search`, `vercel_api_details`,
`vercel_api_read`, and `vercel_api_write` over Vercel's OpenAPI document,
pinned by content hash because Vercel does not version it. Every call is
checked against the pinned index before it is sent, and results arrive as
`{ status, data, page? }`. It adds `list_teams`, the value-safe environment
variable tools (`list_project_env_vars`, `upsert_project_env_var`,
`update_project_env_var`, `delete_project_env_var`),
`get_deployment_build_logs` (build events, never following), `get_runtime_logs`
(the runtime stream, stopped after `waitMs` or `maxRows`), and
`vercel_api_upload`.

Value safety follows a reviewed table bundled with the connector.
Every operation whose response schema in the pinned spec may carry a credential
or a stored secret has a verdict: refused (credential minting, Connect
authorization, decrypted environment values, Global Config items and tokens,
domain transfer codes, KMS signing), redacted at reviewed field paths
(environment values, protection-bypass secrets, deploy hook URLs, drain and
webhook headers and destination URLs beyond their origin, external route and
redirect destinations beyond their origin, the args and values of every header,
cookie, and query rule (route transforms and conditions, firewall conditions), team invite codes, synced Global Config items, URL credentials, and signing
secrets, including the one a new webhook or drain returns at creation), or
safe with a reason. Detection reads field names, field descriptions, and
operation descriptions, so a project transfer request (whose code lets another
team claim the project) is refused too. A test fails when
a newly flagged operation has no verdict. A key-name heuristic covers every
other body as defense in depth. Secret-family failures carry fixed messages
instead of Vercel's text, and every other reviewed operation also withholds that
text ([value safety](#value-safety-on-every-key-connector)). Read or rotate withheld secrets in the Vercel
dashboard. A domain move-out is refused because its answer is a transfer token.

Lost on the token path: documentation search, runtime error clusters, toolbar
threads, agent runs, web analytics summaries, purchase quotes and guided
purchases, `deploy_to_vercel`, and access grants for protected URLs exist only
on the hosted OAuth connection. Programs calling those tools need an OAuth
connector beside the token connector.

The hosted connection now lists `filter_project_envs`, `get_project_env`,
`create_project_env`, and `edit_project_env`, which 0.29 hid. The two reads can
return decrypted values, so they are reviewed as writes, and a `readOnly`
endpoint refuses them. Vercel admits only reviewed and approved MCP clients to its
hosted server; if authorization is refused for that reason, the deployment
needs Vercel's approval or a token connector. Read the connector runtime guide with `connecta.skill("connector:<id>")` in `execute_code` for its usage conventions.

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
`src/providers/vercel/safety.ts` owns Vercel's reviewed table.
