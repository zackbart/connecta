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

## Notion

Every `notion()` call must now name `auth`. 0.30 defaulted to hosted MCP and
selected the REST interface with `surface: "api"`; `surface` is gone:

```ts
connectors: [
  notion("notion", { purpose: "Workspace content as the signed-in user", auth: { type: "oauth" } }),
  notion("notion_bot", { purpose: "Internal integration content", auth: { type: "token" } }),
]
```

| 0.30 configuration                                                                                                                        | Now                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No `surface`, or `surface: "mcp"`                                                                                                         | `auth: { type: "oauth" }`. Same endpoint, reviewed catalog, grant, and optional `callAdmission`.                     |
| `surface: "api"`                                                                                                                          | `auth: { type: "token" }`. The integration token stored for the same connector id carries over; run its Test action. |
| `credentialLabel` or `defaultPageSize`                                                                                                    | Token only, as before. Under OAuth they are refused by name at construction.                                         |
| `integration_search`, `_get_page`, `_get_page_content`, `_get_data_source_schema`, `_query_data_source`, `_create_page`, `_append_blocks` | Unchanged names and contracts. `integration_append_blocks` also takes `checklist`.                                   |
| `integration_get_database`                                                                                                                | `notion_api_read` `GET /v1/databases/{database_id}`.                                                                 |
| `integration_get_page_property`                                                                                                           | `notion_api_read` `GET /v1/pages/{page_id}/properties/{property_id}`; `truncated_properties` names it.               |
| `integration_list_users`, `integration_get_self`                                                                                          | `notion_api_read` `GET /v1/users` or `GET /v1/users/me`.                                                             |
| `integration_list_comments`, `integration_add_comment`                                                                                    | `notion_api_read` `GET /v1/comments`; `notion_api_write` `POST /v1/comments`.                                        |
| `integration_update_page_properties`, `integration_trash_page`                                                                            | `notion_api_write` `PATCH /v1/pages/{page_id}` with `properties`, or `in_trash` to trash or restore.                 |

The token connector gains Connecta's generic REST tools over Notion's pinned
API index (`notion_api_search`, `notion_api_details`, `notion_api_read`,
`notion_api_write`), so every public operation is reachable with the bot's
token: views, page moves and Markdown, meeting notes, custom agents and
sessions, file uploads by `external_url`, and data source changes. Every call
is checked against the index before it is sent, and results arrive as
`{ status, data, page? }`. The read-only POST queries (search, data source,
meeting notes, agents, sessions, and session events) use `notion_api_read`;
`page.in: "body"` says their cursor goes back in the body. Notion's OAuth token
endpoints and multipart file sends are refused. The 0.29 reconciliation table
and the `surface: "api"` complement rules no longer apply to Notion.

Lost per mode. A token connector acts as the integration bot, never as a
person, and has none of the hosted MCP's search across connected apps, page
duplication, team and skill search, attachment downloads, or page-to-skill
conversion. An OAuth connector acts as the user, and has none of the generic
REST tools or the `integration_*` projections and authoring helpers. Configure
both ids when a deployment needs both; a failed call is never retried on the
other. The [Notion skill](https://github.com/zackbart/connecta/blob/main/src/providers/notion/SKILL.md)

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

Value safety follows a reviewed table (`src/providers/vercel/value-safety.ts`).
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
other body as defense in depth, and secret-family failures carry fixed messages
instead of Vercel's text. Read or rotate withheld secrets in the Vercel
dashboard. A domain move-out is refused because its answer is a transfer token.

Lost on the token path: documentation search, runtime error clusters, toolbar
threads, agent runs, web analytics summaries, purchase quotes and guided
purchases, `deploy_to_vercel`, and access grants for protected URLs exist only
on the hosted OAuth connection. Programs calling those tools need an OAuth
connector beside the token connector.

The hosted connection now lists `filter_project_envs`, `get_project_env`,
`create_project_env`, and `edit_project_env`, which 0.29 hid. The two reads can
return decrypted values, so they are reviewed as writes and the pool trust
policy gates them. Vercel admits only reviewed and approved MCP clients to its
hosted server; if authorization is refused for that reason, the deployment
needs Vercel's approval or a token connector. The
[Vercel skill](https://github.com/zackbart/connecta/blob/main/src/providers/vercel/SKILL.md)
owns the conventions for both.

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

Read-only pools: hosted `execute` is always a write, even for a program that
only reads, so a read-only pool on an OAuth connector reaches only `search`.
Use an API-token connector for read-only API access.

Lost on each path. OAuth has no index validation, named tools, GraphQL tool,
upload tool, or pin; Cloudflare's OAuth grant is the only boundary. A key has
no hosted `search` over Cloudflare's live OpenAPI document; the pinned index
replaces it and `providers:check` reports when it falls behind. A Global API
Key cannot reach R2, which accepts API tokens only. The
[Cloudflare skill](https://github.com/zackbart/connecta/blob/main/src/providers/cloudflare/SKILL.md)
owns the conventions for both.

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
  File's links, an event's `previous_attributes`). A guest Checkout Session's
  URL and Identity verification URLs are unchanged; a Checkout Session bound
  to a customer (`customer`, `customer_creation: "always"`, or saved payment
  method options) returns only its scheme and host, because its page can
  show, reuse, or remove the customer's saved payment methods. v2 account
  links and Terminal onboarding links are refused too. Issuing `number` and
  `cvc` expansions are refused on every Issuing path, not only cards.
  Failures of credential-bearing operations keep Stripe's type, code, and
  param but not its message. Create client-side sessions and links from your
  own server code.
- **Notion** results withhold the signature, credential, and security-token
  parameters of pre-signed file URLs, so a returned file URL no longer
  downloads; credential-named fields, including database properties named
  like credentials, read as `"[redacted]"`. Failures of the OAuth, file
  upload, bot user, and agent operations keep Notion's code but not its
  message.
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
