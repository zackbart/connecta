# Notion, Vercel and Cloudflare migration for 0.29

This guide records the 0.29 Notion, Vercel and Cloudflare option changes.
For upgrades to current versions, use [deployment upgrades](./deploying.md#upgrade-an-existing-deployment)
and [hosted MCP migration](./hosted-mcp-migration.md); the hosted selectors below
are historical and cannot be used in current configuration.

Cloudflare's part of this guide is superseded: `cloudflare()` now selects its
implementation by `auth` and its key connector is complete on its own. Follow
the [provider auth migration](./provider-auth-migration.md#cloudflare) for
Cloudflare; the Cloudflare lines below record the transition shipped in 0.29.0 only.

All three providers now default to hosted MCP. `surface: "api"` explicitly
selects a REST complement and accepts only its API-specific options. The old
Vercel/Cloudflare API modes are no longer complete alternatives; Notion retains
all operations required by its distinct integration identity. Adding `surface: "api"` keeps
REST reads/gaps but does not restore removed duplicates. For both sets of
capabilities, configure both connectors under distinct ids and authorize each.

```ts
connectors: [
  notion("notion", { purpose: "Workspace content" }),
  notion("notion_rest", { surface: "api", purpose: "Internal integration content and exact REST operations" }),
  cloudflare("cloudflare", { purpose: "Estate mutations", auth: { type: "credential" } }),
  cloudflare("cloudflare_rest", { surface: "api", purpose: "Estate reads and byte/header operations", accountId: "account-id", zoneId: "zone-id" }),
]
```

Notion has since moved to auth-selected implementations: `surface` is gone,
and `auth: { type: "oauth" }` or `{ type: "token" }` selects hosted MCP or the
REST connector. Upgrade with the
[provider auth migration](./provider-auth-migration.md#notion); the rest of
this paragraph records the rules shipped in 0.29.0.
Notion preserves headless/internal-integration capabilities. Add explicit
`surface: "api"` to retain that identity and migrate old REST names to
`integration_*`, for example `search` to `integration_search`, `create_page`
to `integration_create_page`, and `query_data_source` to
`integration_query_data_source`. Its token/sharing boundary stays intact.
Hosted MCP acts as an OAuth user, has its own grant, and cannot adopt an internal
token. Use it for user-owned work and hosted-only capabilities; authorize it
explicitly if those are needed. Do not replace a bot with a user as an auth fix.
All REST pagination, exact JSON blocks/properties, trash/restore and bot-owned
content writes remain available.

For Cloudflare, migrate ordinary JSON writes to hosted `search` then `execute`.
A scoped API token can authorize hosted MCP without interactive OAuth; configure
that credential independently even if it has the same value as the REST token.
Keep REST reads in read-only programs. Global API Key/email and R2 jurisdiction/storage-class
JSON mutations, plus byte/header-compatible uploads, stay in the explicit REST
complement. Replace `update_r2_bucket` with `cloudflare_api_mutate` using
`PATCH /accounts/{accountId}/r2/buckets/{bucketName}` and the header
`cf-r2-storage-class` set to `Standard` or `InfrequentAccess`. Omit the body;
include `cf-r2-jurisdiction` only when the bucket needs it. This remains a write.
`execute` remains a write even when its program only calls GET.
Writable endpoints may run `execute`; `readOnly` endpoints refuse it.

Vercel's `surface` and ownership rules were later replaced: `auth` now selects
the implementation. See the [provider auth migration](./provider-auth-migration.md#vercel).
The Vercel guidance shipped in 0.29.0 follows for history. For Vercel, authorize the owning teams in hosted OAuth, migrate discovery/logs,
domain listing/adding, deployment cancellation and file uploads to live MCP
schemas, and keep the independently authorized REST complement for value-safe
project environment variables (including `upsert: false` create-only writes), domain verification/removal and deployment
deletion. Promotion now uses hosted `request_promote` from the rolling-releases
category. Raw hatches refuse all published REST counterparts, including project
creation/update. Do not copy REST argument
shapes into vendor tools, even when a tool name is unchanged.

Every provider's table is retired with `surface`; the provider auth migration
maps their names ([Notion](./provider-auth-migration.md#notion),
[Cloudflare](./provider-auth-migration.md#cloudflare),
[Vercel](./provider-auth-migration.md#vercel)).
