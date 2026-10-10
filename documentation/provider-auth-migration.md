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
