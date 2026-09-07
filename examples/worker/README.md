# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector, guarded by Cloudflare Access, with state in a KV namespace. Its
required Worker Loader binding backs the seven-tool surface and requires the
Workers Paid plan.

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets. See [the Cloudflare guide](../../documentation/cloudflare.md).

## Files

| File | What it is |
| --- | --- |
| `src/index.ts` | the Worker entrypoint — connector and auth configuration |
| `src/cloudflare-kv.ts` | `KVStorage` over Workers KV (deployment-owned, not a package export) |
| `src/d1-activity.ts` | `ActivityStore` over D1 (deployment-owned; see below) |
| `wrangler.jsonc` | Worker name, vars, bindings, `compatibility_flags` |

`cloudflare-kv.ts` and `d1-activity.ts` deliberately live here rather than in
the package: storage backends are deployment-owned, so the package ships only
the generic `KVStorage` and `ActivityStore` contracts. Workers KV is eventually
consistent across locations; use a strongly consistent `KVStorage` adapter when
OAuth disconnect, credential rotation, or access-token issuance/revocation must
become globally visible immediately.

## Deploy

This example has no `package.json` of its own — it resolves the installed
package from the repository root.

```sh
npm install                                    # from the package root

wrangler kv namespace create CONNECTA_KV       # paste the id into wrangler.jsonc

cd examples/worker
wrangler secret put DOWNSTREAM_TOKEN
wrangler secret put CREDENTIAL_ENCRYPTION_KEY   # base64 32-byte AES key
wrangler deploy
```

`PUBLIC_URL` is a plain var in `wrangler.jsonc`. After the first deploy, attach
Cloudflare Access to the Worker itself (the API destination type is `worker`,
not a hostname application) and choose the account, email-domain, or
advanced Zero Trust policy that owns admission. Enable **Managed OAuth** on
that Access application for interactive MCP clients, turn on Dynamic Client
Registration, and add these three entries under **Allowed redirect URIs**:

```text
https://claude.ai/api/mcp/auth_callback
https://chatgpt.com/connector_platform_oauth_redirect
https://chatgpt.com/connector/oauth/*
```

The Claude entry is its fixed hosted-MCP callback. ChatGPT may register either
its stable callback or a callback-id URL, so both forms are intentional. These
are Managed OAuth application settings, represented by
`oauth_configuration.dynamic_client_registration.allowed_uris` in the Access
API; they do not belong in the Access Allow policy that decides who may sign
in. Leaving the list empty is a footgun: discovery still works, then Dynamic
Client Registration fails because the callback is not allowed. If either
client presents a new redirect URI, copy that exact value from the registration
attempt and add the narrowest matching entry rather than allowing its entire
origin.

Access then serves OAuth discovery and turns the client's opaque token into the
trusted `ctx.access` identity connecta reads. A cron job or CI client uses an
Access service token instead.

Through the API, the relevant part of the application is:

```json
{
  "oauth_configuration": {
    "enabled": true,
    "dynamic_client_registration": {
      "enabled": true,
      "allowed_uris": [
        "https://claude.ai/api/mcp/auth_callback",
        "https://chatgpt.com/connector_platform_oauth_redirect",
        "https://chatgpt.com/connector/oauth/*"
      ]
    }
  }
}
```

Cloudflare's [Worker Access guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
owns the dashboard/API steps; its [Managed OAuth guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
owns client registration, redirect allowlists, and token lifetimes.

[`AGENTS.md`](./AGENTS.md) repeats the callback invariant for coding agents
working in a copied deployment. Do not remove the entries there when changing
the Access policy or application.

The checked-in `access.dev` block gives `wrangler dev` a local operator
identity. Remove the block to test the missing-Access refusal. It has no effect
on a deployed Worker's production identity.

### Copied into its own repository

The `npm install` above is the connecta repository's, which already has every
dependency this file imports. A copy with its own `package.json` installs three
things, because two of them are not part of connecta and never install with it:

```sh
npm install @zackbart/connecta @cloudflare/codemode
```

`@cloudflare/codemode` is the optional peer behind `execute_code`, declared in
connecta's manifest but never installed with it, and published as
`^0.4.4 || ^0.5.0`: install a version inside that and npm stays quiet, install
one outside and npm says so at install time instead of leaving a Worker to
discover the skew in production ([#376](https://github.com/zackbart/connecta/issues/376)).

`cloudflareAccessAuth()` has no dependency of its own. This Worker example has
no Clerk import, secret, package, or fallback provider. Docker deployments keep
the Clerk path in the Node template.

Then point an MCP client at `<PUBLIC_URL>/mcp`. The example explicitly enables
`ui: operatorUi()`; open `<PUBLIC_URL>/` for Connections and each connection's
authentication controls. There is no separate Credentials or Tokens tab.

## Select optional modules

`cloudflareAccessAuth()` reads trusted identity after Access admits the Worker
request. Humans may use their code-derived connector view; service identities
can use MCP but cannot manage personal or shared auth as an interactive human.
Keep users, groups, and admission in Access. Connector visibility and management
permissions belong in `src/index.ts`.

`identity.connectorAccess` selects discoverable and callable connectors.
`credentialAdministration` separately allows shared credential and OAuth
management, while `personalConnection` allows a human to connect their own
account. Both management permissions default to none. Grant the intended
owner's shared permissions explicitly, and grant users personal permissions
only for connectors configured with `authScope: "personal"`. Static headers
remain deployment configuration. `activityAccess` governs global history reads.
See [inbound identity](../../documentation/auth.md#principals-visibility-and-operators).

### UI and encrypted credentials

Import `operatorUi` from `@zackbart/connecta/ui` and set `ui: operatorUi()`.
Branding belongs in `operatorUi({ branding })`. Omit the import and option to
serve no UI routes; OAuth callbacks still work in core for authorized
interactive MCP callers.

Import `encryptedCredentialVault` from `@zackbart/connecta/credentials` and set
`vault: encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY)` when
the secret is configured. Keep this base64 32-byte key in Worker secrets:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Reuse the same key and KV namespace during upgrades. Without the secret, omit
the vault; declared credential slots remain unmanageable. Keep the key outside
KV because it protects a copied namespace. Credential replacement takes effect
on the next call without redeploying; no liveness probe runs in the background.

The shipped Notion connector uses a deployment-owned static header and echo
needs no secret. To exercise vault controls, declare a `credential` slot on an
`api()` connector or use a provider such as `notion()` that declares its own.
Authorized users manage that slot inside the connection. Configuring a vault
does not create credentials or permissions by itself.

### Client authentication and activity

Interactive MCP clients use Access Managed OAuth. Unattended clients use Access
service tokens when needed. Connecta-issued `cta_` tokens and their management
routes are removed; a configured Connecta bearer cannot cross the Access edge
alone. See the [migration guide](../../documentation/upgrading.md#unreleased-optional-modules)
if an older deployment still issues tokens.

Activity uses `activityHistory({ store: d1ActivityStore(env.ACTIVITY_DB) })`
from `@zackbart/connecta/activity`. Enable the database and bindings described
below. Omit the module and store wiring to record no history and show no
Activity tab. Diagnostics remain independent; `logger: "silent"` suppresses
them explicitly.

Verify MCP health and the exact seven tools with:

```sh
CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=… \
  npx connecta doctor --url "$PUBLIC_URL"
```

Doctor reports the configured `DynamicWorkerExecutor`, not a presumed Node
executor. Verify the UI separately as a human: check visible connections,
explicit shared and personal auth permissions, and Activity only when enabled.
The configured list loads before live connector checks; a slow provider must
not prevent other connections from appearing. All capability and access changes
still require a deployment-code change.

## Code mode

The Dynamic Worker sandbox requires the
[Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
The required Worker Loader binding is checked into `wrangler.jsonc`:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

`src/index.ts` constructs `DynamicWorkerExecutor` with only `env.LOADER` and
serves the seven-tool surface. Do not add `bindings`, `modules`, or
`globalOutbound`; they grant guest code ambient authority. A copied deployment
owns the package install — see
[copied into its own repository](#copied-into-its-own-repository).

## Activity history (optional)

`src/d1-activity.ts` is a complete `ActivityStore` over D1 — keyset paging on
`(occurred_at_ms, id)` plus a batched retention pass — but the wiring in
`src/index.ts` is **commented out**, so the example deploys without a database.
To enable it:

1. Create the database and uncomment the `d1_databases` binding in
   `wrangler.jsonc`, pasting in the id it prints:

   ```sh
   wrangler d1 create connecta-activity
   ```

   ```jsonc
   "d1_databases": [
     { "binding": "ACTIVITY_DB", "database_name": "connecta-activity", "database_id": "…" }
   ]
   ```

2. Apply the schema (keep it in a deployment-owned `migrations/` directory):

   ```sql
   CREATE TABLE IF NOT EXISTS tool_call_activity (
     id             TEXT PRIMARY KEY,
     occurred_at_ms INTEGER NOT NULL,
     request_id     TEXT NOT NULL,
     actor_kind     TEXT NOT NULL,
     actor_id       TEXT,
     actor_namespace TEXT,
     connector_id   TEXT NOT NULL,
     tool_name      TEXT NOT NULL,
     source         TEXT NOT NULL,
     outcome        TEXT NOT NULL,
     duration_ms    INTEGER NOT NULL,
     attempts       INTEGER NOT NULL,
     error_code     TEXT,
     friction       TEXT,
     server_name    TEXT NOT NULL,
     server_version TEXT NOT NULL,
     deployment_id  TEXT
   );

   CREATE INDEX IF NOT EXISTS tool_call_activity_recent
     ON tool_call_activity (occurred_at_ms DESC, id DESC);
   ```

   **Already have this table?** `actor_namespace` and `friction` were added
   after the original example, and `CREATE TABLE IF NOT EXISTS` will not add
   them to a table that already exists. Add them as migrations:

   ```sql
   ALTER TABLE tool_call_activity ADD COLUMN actor_namespace TEXT;
   ALTER TABLE tool_call_activity ADD COLUMN friction TEXT;
   ```

   `friction` is stored rather than derived because one of its classes belongs
   to a call that *succeeded*: a result too large to return inline is friction
   for the agent and carries no error code. Rows written before the column keep
   working — the mapping module derives their friction from `error_code` — and
   `error_code IS NOT NULL` remains an honest count of failures.

   Do this **before** deploying the updated `d1-activity.ts`: its `INSERT`
   names the column, so against an un-migrated table every write fails with
   `no such column`. Activity writes are best-effort by design — connecta logs
   the failure and returns the tool result unharmed — so the symptom is not an
   error your agent sees, it is an activity log that quietly stops recording.

3. In `src/index.ts`, enable the `activityHistory` and `d1ActivityStore` imports,
   the `ACTIVITY_DB` field on `Env`, and the `activity` option:

   ```ts
   import { activityHistory } from "@zackbart/connecta/activity";
   import { d1ActivityStore } from "./d1-activity.js";

   createConnecta({
     // …
     activity: activityHistory({
       store: d1ActivityStore(env.ACTIVITY_DB),
       deploymentId: "production",
     }),
   });
   ```

Events carry no arguments, results, generated code, or raw error messages — see
[activity history](../../documentation/operator-ui.md).
The Worker entrypoint already forwards `ctx` to `connecta.fetch`, which lets
async activity writes settle on `waitUntil`.

For retention, add a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`triggers.crons` in `wrangler.jsonc` plus a `scheduled` handler — this example
no longer ships one) and call `pruneActivity(env.ACTIVITY_DB, retentionDays)`
from it.
