# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector, guarded by Cloudflare Access. It uses three Cloudflare resources
and nothing else: one D1 database (`CONNECTA_DB`) for every piece of state, the
Worker Loader binding (`LOADER`) behind the six-tool surface, which requires
the Workers Paid plan, and one secret (`CREDENTIAL_ENCRYPTION_KEY`).

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets.

## Files

| File | What it is |
| --- | --- |
| `src/index.ts` | the Worker entrypoint — starts the configuration, under 30 lines |
| `src/connecta.config.ts` | connectors, auth, storage, and optional modules, as `defineConfig((env) => …)` |
| `wrangler.jsonc` | Worker name, vars, bindings, `compatibility_flags` |
| `scripts/copy-kv-to-d1.mjs`, `kv-to-d1.wrangler.jsonc` | one-shot copy of a 0.28 Workers KV deployment's state into D1, run once and deleted ([Upgrading from 0.28](#upgrading-from-028)) |

Keep `enable_request_signal` in `wrangler.jsonc`. On Workers it lets a live
response's client disconnect abort its request, so connecta cancels the stream
and returns the admission permit promptly. The total admitted-request bound in
`admission.requests.maxDurationMs` (default 300,000 ms) also reclaims capacity
on a later request if workerd ends one without delivering a signal or stream
cancellation. Set it above the longest authorization, tool call, and response
delivery your deployment expects to serve.

Storage is `d1Storage(env.CONNECTA_DB)` from `@zackbart/connecta/d1`, and
activity history, when `CONNECTA_ACTIVITY` is `"on"`, is `d1ActivityStore` over
the same database.
See [Storage](#storage).

## Deploy

This example has no `package.json` of its own — it resolves the installed
package from the repository root.

```sh
npm install                                    # from the package root

wrangler d1 create connecta                    # paste the id into wrangler.jsonc

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
trusted human `ctx.access` identity connecta reads. A cron job or CI client
needs Access service headers to cross the edge and a stored `cta_` bearer to
authenticate inside connecta. An Access service identity alone is refused.
See [Machine tokens](#machine-tokens).

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

### Optional resource management with Alchemy

Keep this example's Worker on Wrangler. A copied deployment may use
[Alchemy](https://alchemy.run) to manage its D1 database, optional R2 bucket,
and the Access application without adding Alchemy to connecta or
changing this template. In that deployment, install `alchemy@2.0.0-beta.79`
and `effect@4.0.0` at exact versions. The latter is connecta's own
Effect pin; check `npm ls effect` for one resolved copy after installation.
The following `alchemy.run.ts` is a resource stack, not a Worker deployment:

```ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";

// Replace this with the immutable ID of the Wrangler-deployed Worker.
const workerId = "replace-with-worker-id";

export default Alchemy.Stack(
  "ConnectaResources",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("ConnectaDB", {
      name: "connecta",
    }).pipe(adopt(true));
    const access = yield* Cloudflare.Access.Application("ConnectaAccess", {
      type: "self_hosted",
      name: "Connecta",
      destinations: [{ type: "worker", workerId }],
      policies: [{ decision: "allow", include: [{ emailDomain: "example.com" }] }],
      oauthConfiguration: {
        enabled: true,
        dynamicClientRegistration: {
          enabled: true,
          allowedUris: [
            "https://claude.ai/api/mcp/auth_callback",
            "https://chatgpt.com/connector_platform_oauth_redirect",
            "https://chatgpt.com/connector/oauth/*",
          ],
        },
      },
    }).pipe(adopt(true));
    return { databaseId: database.databaseId,
      accessId: access.applicationId };
  }),
);
```

Replace the Worker ID and example Access policy before applying this stack.
`CONNECTA_DB` is required. Copy the database ID into `wrangler.jsonc` and keep
`LOADER` in `worker_loaders`. Configure the hostname as a Wrangler custom domain
route with `custom_domain: true`. Verify it against the Worker-level Access
application, set secrets with `wrangler secret put`, and deploy with Wrangler.
After the initial `wrangler deploy`, use `wrangler versions upload` and
`wrangler versions deploy` for code updates.

The `adopt(true)` calls explicitly permit taking over matching existing
resources; compare their live names, IDs, Access policy, and data before the
first Alchemy deploy. Remove adoption where a resource is new. The stack
configures no `migrations`: connecta creates its tables on first use. Remote
`Cloudflare.state()` bootstraps an account-level state-store Worker backed by a
Durable Object and Secrets Store entries for its credentials. Retain them:
deleting the state store loses Alchemy's record of what it owns.

Verification for this optional path stops at the API and types. The 0.28
form of this snippet (a KV namespace and two D1 databases with `migrations`)
was copied to an isolated `alchemy.run.ts` and passed `tsc --noEmit` with
TypeScript 5.9.3, Alchemy 2.0.0-beta.79, and Effect 4.0.0, with `npm ls
effect` confirming one resolved copy; this form only removes resources and the
optional `migrations` field. No Alchemy deploy or adoption was run.
[Alchemy's Worker resource](https://alchemy.run/cloudflare/compute/workers/)
can declare `WorkerLoader`, domains, Browser Rendering, and cron wiring, but
those properties are coupled to its script deploy. Its current full deploy
still uses the script-upload endpoint; only a conditional gradual rollout uses
the versions API. A previous full deploy through that endpoint did not provide
`ctx.access`, so do not transfer Worker ownership until that path is verified
end to end. The [Access](https://alchemy.run/cloudflare/security/access/),
[D1](https://alchemy.run/cloudflare/data/d1/), and
[state-store](https://alchemy.run/state-store/) guides describe the resources
above; the typecheck does not prove Cloudflare will accept this particular
Access adoption or preserve production identity.

### Copied into its own repository

The `npm install` above is the connecta repository's, which already has every
dependency this file imports. A copy with its own `package.json` installs
Connecta and the separately installed `@cloudflare/codemode` peer:

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
authentication controls. The page labels tool safety, offers fixed repair
prompts for classified failures, and shows client setup commands for endpoints
the signed-in person may use. Those commands contain no token. There is no
separate Credentials tab. The Access tokens page is available to permitted
interactive operators.

## Select optional modules

`cloudflareAccessAuth()` reads trusted identity after Access admits the Worker
request. Humans may use their code-derived connector view and operator pages.
Machines authenticate with `accessTokens(storage)` over the same D1 database;
Access service headers alone never grant MCP access or interactive authority.
Keep users, groups, and admission in Access. Connector visibility and management
permissions belong in `src/connecta.config.ts`.

`identity.connectorAccess` selects discoverable and callable connectors.
`credentialAdministration` separately allows shared credential and OAuth
management, while `personalConnection` allows a human to connect their own
account. Both management permissions default to none. Grant the intended
owner's shared permissions explicitly, and grant users personal permissions
only for connectors configured with `authScope: "personal"`. Static headers
remain deployment configuration. `activityAccess` governs global history reads.
`accessTokenManagement` separately allows interactive operators to create, rename,
and revoke machine tokens. This example grants that permission to every signed-in
human, matching its connector-management permissions; narrow all three for a team.
See [inbound identity](../../documentation/auth.md#principals-visibility-and-operators).

### Machine tokens

`accessTokens(storage)` is always installed over `CONNECTA_DB`, with no new
binding. Empty token storage admits no machine client. A human authenticated
through Access can still sign in and bootstrap the first token. Open
`<PUBLIC_URL>/`, select Access tokens, and create a named token. Save the
returned `cta_` secret privately; it is returned once. UI-issued tokens retain
the issuing human's principal, while connector and pool rules are evaluated
on every request. They never grant interactive operator authority.

A machine sends all three headers:

```text
CF-Access-Client-Id: <access-service-client-id>
CF-Access-Client-Secret: <access-service-client-secret>
Authorization: Bearer <stored-cta-token>
```

Permit the service credentials in the Worker-level Access application's policy.
The service headers admit the request at the edge; connecta verifies the bearer
against D1. Neither credential works alone for machine access. Doctor uses
the same three credentials; see [Client authentication and activity](#client-authentication-and-activity).

For programmatic bootstrap, trusted provisioning code that already holds this
deployment's D1 binding can use the published API against that same storage:

```ts
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { d1Storage } from "@zackbart/connecta/d1";

const manager = new AccessTokenManager(d1Storage(env.CONNECTA_DB));
const { token } = await manager.create("ci-client", "trusted-provisioning");
// Deliver token once to the client's secret store, outside logs and source control.
```

This creates a token without a human principal. The name is a label, never a
grant. Provision only through trusted operator tooling; do not expose this
code as a public route or mint a token at startup. Existing unrevoked `cta_`
tokens survive a state migration into this same D1 namespace. Keep
`accessTokens(storage)` configured and preserve the identity and pool rules.

### UI and encrypted credentials

Import `operatorUi` from `@zackbart/connecta/ui` and set `ui: operatorUi()`.
Branding belongs in `operatorUi({ branding })`, including `branding.theme`:
`accent`, `radius`, `fontFamily`, `monoFamily`, and `colorScheme`. Every other
color is mixed from those, so one accent themes the whole page. A value that
fails its gate falls back to the default, and the startup warning names it. Omit
the import and option to serve no UI routes; OAuth callbacks still work in core
for authorized interactive MCP callers.

Import `encryptedCredentialVault` from `@zackbart/connecta/credentials` and set
`vault: encryptedCredentialVault(storage, env.CREDENTIAL_ENCRYPTION_KEY)` when
the secret is configured. Keep this base64 32-byte key in Worker secrets:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Reuse the same key and D1 database during upgrades. Without the secret, omit
the vault; declared credential slots remain unmanageable. Keep the key outside
D1 because it protects a copied database. Credential replacement takes effect
on the next call without redeploying; no liveness probe runs in the background.
With this vault, 0.25.0 seals existing downstream OAuth state on first read.
Rolling back to 0.24.x then requires reauthorizing those OAuth connectors.

The shipped Notion connector uses a deployment-owned static header and echo
needs no secret. To exercise vault controls, declare a `credential` slot on an
`api()` connector or use Notion's explicit `surface: "api"` integration
interface, which declares its own slot.
Authorized users manage that slot inside the connection. Configuring a vault
does not create credentials or permissions by itself.

### Client authentication and activity

Interactive MCP clients use Access Managed OAuth. Machine clients need both
Access service credentials and a stored `cta_` bearer, provisioned as described
in [Machine tokens](#machine-tokens). `accessTokens(storage)` is always enabled,
and the example grants token management to every interactive Access operator.
Keep token, connector, and pool grants in deployment code.

Activity uses `activityHistory({ store: d1ActivityStore(env.CONNECTA_DB) })`,
with `activityHistory` from `@zackbart/connecta/activity` and `d1ActivityStore`
from `@zackbart/connecta/d1`. See [Activity history](#activity-history-optional).
Omit the module and store wiring to record no history and show no Activity tab. Diagnostics remain independent; `logger: "silent"` suppresses
them explicitly.

Verify MCP health and the exact six tools with:

```sh
CF_ACCESS_CLIENT_ID='REPLACE_WITH_ACCESS_CLIENT_ID' \
CF_ACCESS_CLIENT_SECRET='REPLACE_WITH_ACCESS_CLIENT_SECRET' \
CONNECTA_TOKEN='cta_REPLACE_WITH_STORED_SECRET' \
connecta doctor --url "$PUBLIC_URL"
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

`src/connecta.config.ts` uses `workerExecutor({ loader: env.LOADER })` from
`@zackbart/connecta/worker`. The adapter constructs the upstream
`DynamicWorkerExecutor` with only the loader and a deadline, and disposes each
run's loader and RPC handles when its lease ends, even if the guest has not
settled. It serves the six-tool surface. Do not add `bindings`, `modules`, or
`globalOutbound`; they grant guest code ambient authority. A copied deployment
owns the package install — see
[copied into its own repository](#copied-into-its-own-repository).

When upgrading an existing deployment, replace
`import { DynamicWorkerExecutor } from "@cloudflare/codemode";` with
`import { workerExecutor } from "@zackbart/connecta/worker";` and use
`executor: workerExecutor({ loader: env.LOADER })` instead of
`executor: new DynamicWorkerExecutor({ loader: env.LOADER })`. Keep
`@cloudflare/codemode` installed as the optional peer. Direct upstream
construction now throws at boot with this migration instruction; its private
loader cannot release request-owned handles through Connecta's generic executor
wrapper.

## Storage

Every piece of connecta state lives in the one D1 database bound as
`CONNECTA_DB`: downstream OAuth grants, sealed vault credentials, catalogs,
result paging, OAuth handoffs, access tokens, and activity.
`d1Storage` creates its `connecta_kv` table on first use, and
`d1ActivityStore` its `tool_call_activity` table, so there is no schema to
apply. Every compare-and-set is one SQL statement, which D1 serializes on the
database's primary: two isolates claiming the same key cannot both win.

For reference, the tables connecta creates:

```sql
CREATE TABLE IF NOT EXISTS connecta_kv (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  expires_at_ms INTEGER
);
CREATE INDEX IF NOT EXISTS connecta_kv_expiry ON connecta_kv (expires_at_ms);
-- tool_call_activity: one row per completed call, keyset-paged on
-- (occurred_at_ms, id); see src/storage/sql.ts in the package.
```

### Upgrading from 0.28

0.28 shipped three storage shapes in this example. Each moves to the one
`CONNECTA_DB` binding:

- **Already on `d1-storage.ts`** (one D1 database, possibly also holding
  activity). The table is unchanged, so no data moves. Rename the binding in
  `wrangler.jsonc` to `CONNECTA_DB`, keeping `database_name` and
  `database_id`, replace the copied `d1-storage.ts` / `d1-activity.ts` imports
  with `@zackbart/connecta/d1`, and delete those files. A deployment that
  called `pruneActivity` from a cron drops that call: retention is
  `d1ActivityStore(db, { retentionDays })`. A binding rename
  changes only the name the Worker sees; the database and its rows stay. An
  existing `tool_call_activity` table missing `actor_namespace`, `friction`,
  `approval`, `client_name`, `client_version`, or `package_version` gets nullable
  columns added on first use. Old rows keep unknown package and client facts;
  new rows record the actual package version and validated request client facts.
- **Activity and storage in two databases** (`ACTIVITY_DB` and `STORAGE_DB`).
  Bind the storage database as `CONNECTA_DB`. Activity is history: either
  start it fresh in `CONNECTA_DB`, or copy it once, before deploying 0.29 (so
  the target has no `tool_call_activity` table yet), with
  `wrangler d1 export connecta-activity --remote --table tool_call_activity --output activity.sql`
  and `wrangler d1 execute connecta-storage --remote --file activity.sql`. Then
  remove the `ACTIVITY_DB` binding.
- **Workers KV** (`CONNECTA_KV` and `cloudflare-kv.ts`). Workers KV is no longer
  supported: `createConnecta` refuses storage without `compareAndSet` at boot.
  Copy its state into D1 once, as described below, so OAuth grants, vault
  credentials, and `cta_` access tokens keep working.

#### Copying Workers KV state into D1

Storage keys did not change in 0.29. `copyKvToD1(kv, db, { source })` from
`@zackbart/connecta/d1` preserves live keys, exact values including vault
ciphertext, and absolute expiries. The source is the KV namespace id. Counts
and failures name only families, never keys or values. Oversized UTF-8 strings
or rows are skipped and counted as invalid against D1's
[2,000,000-byte limit](https://developers.cloudflare.com/d1/platform/limits/).
A different live D1 value or expiry is a conflict, kept by default.

Use a maintenance window. Copying while either deployment serves can restore
revoked tokens, stale refresh tokens, or disconnected connectors. A rerun is
safe only while the source remains stable and D1 has no new application writes.
The script reads the source id from `kv-to-d1.wrangler.jsonc` and checks two
consecutive listing/hash passes before a copy or verification pass. The config
uses remote KV and D1 bindings and is never deployed.

Prepare the new configuration without deploying it. Use the existing activity
D1 database as `CONNECTA_DB`, keeping its name and id; otherwise create one
with `wrangler d1 create connecta`. Remove `kv_namespaces` and copied adapters.
Configuration lives in `src/connecta.config.ts` and
`src/index.ts` is the entry point. Set the plain var `CONNECTA_ACTIVITY = "on"`
so preserved activity remains visible. Bind only `CONNECTA_DB` and `LOADER` for storage/execution;
keep existing auth vars and the credential secret.
Fill in the copy config's namespace id and the same D1 database name/id,
then `wrangler login` and check the prepared deployment with a dry run.

1. Back up KV with a bulk export including values and expiration metadata.
   Export D1 with `wrangler d1 export <db> --remote --output before-cutover.sql`.
   Store backups securely and preserve the exact credential encryption key,
   including One&Many's `CONNECTA_CREDENTIALS_KEY`.
2. Block traffic using maintenance mode or turn the route off. Stop cron,
   queue consumers, scheduled jobs, and every other KV/D1 writer. Drain all
   in-flight requests, including OAuth callbacks and token refreshes.
3. Wait at least **60 seconds after the last write**, or the longest configured
   KV `cacheTtl`, whichever is greater. KV propagation can take longer, so this
   is a minimum, not proof of consistency. See
   [KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/).
   Confirm a stable source with two consecutive listing/hash passes that match;
   the script performs this check. If they differ, stay in maintenance, wait
   longer, and repeat. Expiring entries may also require another pass.
4. Copy **before switching traffic** with
   `node scripts/copy-kv-to-d1.mjs --maintenance`. Resolve all `invalid` and
   `conflicts` counts under maintenance; either makes the script exit non-zero.
   An oversized entry requires a deliberate per-family remediation, not a
   retry of the same value. Overwrite only families explicitly reviewed as
   stale in D1, for example `--maintenance --overwrite-family catalog`.
   Token/OAuth/vault families require the operator to confirm D1 rows are stale
   and also pass `--confirm-stale-d1`; never infer this from a conflict alone.
   There is no blanket `--overwrite`. Then run
   `node scripts/copy-kv-to-d1.mjs --maintenance --verify`. It compares SHA-256
   hashes of exact values and absolute expiries for live source keys, reports
   `verified` / `mismatches` counts by family only, and exits non-zero on any
   invalid entry or mismatch. Keep traffic and writers stopped until these
   counts are resolved. A verification pass does not rewrite copied entries.
5. Deploy the D1 configuration with `wrangler deploy` while maintenance remains.
   Run `connecta doctor` using Access service credentials plus a stored `cta_`
   bearer through `CONNECTA_TOKEN`. Verify an existing
   OAuth connector without re-consent, an existing `cta_` token, a connector
   using a vault credential, and prior activity in the Activity view. Run
   these controlled checks with other traffic and background writers blocked.
6. Seal the source with
   `node scripts/copy-kv-to-d1.mjs --maintenance --mark-live`, then reopen
   traffic and background writers. The permanent D1 marker refuses later
   copies. Never rerun after traffic resumes. `--i-know-this-is-stale` is only
   an emergency override after stopping writers again and assessing stale KV;
   it does not make stale tokens or credentials safe to restore.
   Retain backups before deleting the KV namespace. After a clean observation
   period, remove the copy script/config and delete KV with
   `wrangler kv namespace delete --namespace-id <id>`.

An in-Worker copy can call
`copyKvToD1(env.CONNECTA_KV, env.CONNECTA_DB, { source: namespaceId, cursor })`
from a guarded one-off route under the same maintenance procedure. Each call
reads at most `maxKeys` keys, default 500. For near-limit rows use 200 or fewer
so additional byte-bounded D1 batches fit the invocation's query budget.
Loop until `done`, passing each returned cursor. Tokens keep KV's raw cursor
in D1 for seven days, are bound to the source id, and are atomically consumed.
Unknown, spent, or foreign-source tokens are refused without echoing them.
On failure, use the error's replacement token or restart under maintenance.
Call `markKvToD1Live(db, namespaceId)` before reopening traffic, and remove the
route and KV binding. The source stability check is the operator's duty when
using the API directly. Remote bindings remain unverified until deploy day.

## Activity history (optional)

`d1ActivityStore(env.CONNECTA_DB)` from `@zackbart/connecta/d1` is a complete
`ActivityStore` in the same database — keyset paging on
`(occurred_at_ms, id)`, its table created on first use. `src/connecta.config.ts`
switches it on only when the `CONNECTA_ACTIVITY` var is `"on"`, because
retention is the deployment's decision:

```ts
activity: env.CONNECTA_ACTIVITY === "on"
  ? activityHistory({
      store: d1ActivityStore(env.CONNECTA_DB, { retentionDays: 90 }),
      deploymentId: "production",
    })
  : undefined,
```

Each write prunes a bounded batch of rows older than `retentionDays` (90 by
default), so no Cron Trigger is needed; change the number there. Events carry no arguments, results, generated code,
or raw error messages. The Worker entrypoint already forwards `ctx` to
`connecta.fetch`, which lets async activity writes settle on `waitUntil`.

`friction` is stored rather than derived because one of its classes belongs to
a call that *succeeded*: a result too large to return inline is friction for
the agent and carries no error code. Rows written before the column derive
their friction from `error_code`, and `error_code IS NOT NULL` remains an
honest count of failures. `approval` is history, set only on `approved` rows
written before 0.28.0 removed program pauses.

Activity uses `d1ActivityStore` and the shared SQL row mapping. On first access,
it adds nullable classification, result byte count, event kind, catalog-change
counts, pool and actor-basis columns. Existing rows retain unknown facts. Personal
rows require the checked `principal` actor basis before their ownership is trusted.
Request IDs already
exist in the table. Catalog-change events contain checked counts only; tool-call
results and payloads are never stored.
