# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector, guarded by Cloudflare Access, with state in a KV namespace. Its
required Worker Loader binding backs the eight-tool surface and requires the
Workers Paid plan.

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets.

## Files

| File | What it is |
| --- | --- |
| `src/index.ts` | the Worker entrypoint — connector and auth configuration |
| `src/cloudflare-kv.ts` | `KVStorage` over Workers KV (deployment-owned, not a package export) |
| `src/d1-storage.ts` | `KVStorage` over D1 with atomic compare-and-set (optional; see below) |
| `src/d1-activity.ts` | `ActivityStore` over D1 (deployment-owned; see below) |
| `src/d1-activity-row.ts` | the row ↔ event mapping `d1-activity.ts` uses, including friction derived from `error_code` for rows written before that column existed |
| `src/r2-artifact-blobs.ts` | artifact bodies in an R2 bucket, beside a D1-backed `kvArtifactStore` (optional) |
| `wrangler.jsonc` | Worker name, vars, bindings, `compatibility_flags` |

Keep `enable_request_signal` in `wrangler.jsonc`. On Workers it lets a live
response's client disconnect abort its request, so connecta cancels the stream
and returns the admission permit promptly. The total admitted-request bound in
`admission.requests.maxDurationMs` (default 300,000 ms) also reclaims capacity
on a later request if workerd ends one without delivering a signal or stream
cancellation. Set it above the longest authorization, tool call, and response
delivery your deployment expects to serve.

`cloudflare-kv.ts`, `d1-storage.ts`, and `d1-activity.ts` deliberately live
here rather than in the package: storage backends are deployment-owned, so the
package ships only the generic `KVStorage` and `ActivityStore` contracts.
Workers KV is eventually consistent across locations; use a strongly consistent
`KVStorage` adapter, such as [`d1-storage.ts`](#strongly-consistent-storage-optional),
when OAuth disconnect or credential rotation must become globally visible
immediately.

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

### Optional resource management with Alchemy

Keep this example's Worker on Wrangler. A copied deployment may use
[Alchemy](https://alchemy.run) to manage its KV namespace, optional D1 databases
and R2 bucket, and the Access application without adding Alchemy to connecta or
changing this template. In that deployment, install `alchemy@2.0.0-beta.79`
and `effect@4.0.0-rc.117` at exact versions. The latter is connecta's own
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
    const kv = yield* Cloudflare.KV.Namespace("ConnectaKV", { title: "connecta-kv" }).pipe(adopt(true));
    const activity = yield* Cloudflare.D1.Database("ActivityDB", {
      name: "connecta-activity", migrations: "./migrations/activity",
    }).pipe(adopt(true));
    const storage = yield* Cloudflare.D1.Database("StorageDB", {
      name: "connecta-storage", migrations: "./migrations/storage",
    }).pipe(adopt(true));
    const blobs = yield* Cloudflare.R2.Bucket("ArtifactBlobs", { name: "connecta-artifacts" }).pipe(adopt(true));
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
    return { kvId: kv.namespaceId, activityId: activity.databaseId,
      storageId: storage.databaseId, bucketName: blobs.bucketName,
      accessId: access.applicationId };
  }),
);
```

Replace the Worker ID and example Access policy before applying this stack.
Keep only the resources the deployment uses: `STORAGE_DB` replaces
`CONNECTA_KV`; `ACTIVITY_DB` and R2 are optional. Copy the output IDs into the
matching `wrangler.jsonc` bindings. Keep `LOADER` in `worker_loaders` and, when
enabled, the Browser Rendering binding and cron trigger in the Wrangler-owned
Worker configuration. Configure the main and artifact hostnames as Wrangler
custom domain `routes` with `custom_domain: true`. The Worker-level Access
destination covers both hostnames; verify both against the same application
after domain setup. Continue to set secrets with `wrangler secret put` and to
deploy the Worker with Wrangler. After its initial `wrangler deploy`, use
`wrangler versions upload` and `wrangler versions deploy` for code updates;
apply route and cron changes through Wrangler too.

The `adopt(true)` calls explicitly permit taking over matching existing
resources; compare their live names, IDs, Access policy, and data before the
first Alchemy deploy. Remove adoption where a resource is new. Put the D1 SQL
from this README in the shown migration directories before deploying. With
`migrations` configured, Alchemy copies an adopted database's Wrangler
migration history once into `__alchemy_migrations`; the old history stays
frozen. Review pending SQL before handing migrations over. Remote
`Cloudflare.state()` bootstraps an account-level state-store Worker backed by a
Durable Object and Secrets Store entries for its credentials. Retain them:
deleting the state store loses Alchemy's record of what it owns.

Verification for this optional path stops at the API and types. The fenced
snippet was copied to an isolated `alchemy.run.ts` and passed `tsc --noEmit`
with TypeScript 5.9.3, Alchemy 2.0.0-beta.79, and Effect 4.0.0-rc.117; no
Alchemy deploy or adoption was run.
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
separate Credentials or Tokens tab.

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

Reuse the same key and KV namespace during upgrades. Without the secret, omit
the vault; declared credential slots remain unmanageable. Keep the key outside
KV because it protects a copied namespace. Credential replacement takes effect
on the next call without redeploying; no liveness probe runs in the background.
With this vault, 0.25.0 seals existing downstream OAuth state on first read.
Rolling back to 0.24.x then requires reauthorizing those OAuth connectors.

The shipped Notion connector uses a deployment-owned static header and echo
needs no secret. To exercise vault controls, declare a `credential` slot on an
`api()` connector or use a provider such as `notion()` that declares its own.
Authorized users manage that slot inside the connection. Configuring a vault
does not create credentials or permissions by itself.

### Client authentication and activity

Interactive MCP clients use Access Managed OAuth. Unattended clients use Access
service tokens when needed. Connecta-issued `cta_` tokens and their management
routes are removed; a configured Connecta bearer cannot cross the Access edge
alone.

Activity uses `activityHistory({ store: d1ActivityStore(env.ACTIVITY_DB) })`
from `@zackbart/connecta/activity`. Enable the database and bindings described
below. Omit the module and store wiring to record no history and show no
Activity tab. Diagnostics remain independent; `logger: "silent"` suppresses
them explicitly.

Verify MCP health and the exact eight tools with:

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
serves the eight-tool surface. Do not add `bindings`, `modules`, or
`globalOutbound`; they grant guest code ambient authority. A copied deployment
owns the package install — see
[copied into its own repository](#copied-into-its-own-repository).

## Strongly consistent storage (optional)

`KVStorage` has an optional atomic `compareAndSet`, for a subsystem that must
claim a key exactly once — resumable writes, where two `resume_execution` calls
racing for one paused program must send its writes once. **Workers KV cannot
provide it**, so on KV this example turns resumable writes off
(`execute: { resumableWrites: false }` in `src/index.ts`) and its programs
refuse writes. It is eventually
consistent: two locations can each read a key as absent and both write, so
`cloudflare-kv.ts` declares no `compareAndSet` rather than fake one with a read
followed by a write. `src/d1-storage.ts` is a complete `KVStorage` over D1
that does provide it, one SQL statement per claim, with TTLs honored at read
time. It replaces the KV namespace rather than sitting beside it: every piece
of connecta state lives in one store.

1. Create the database and uncomment the `STORAGE_DB` entry of the
   `d1_databases` binding in `wrangler.jsonc`, pasting in the id it prints:

   ```sh
   wrangler d1 create connecta-storage
   ```

2. Apply the schema (keep it in a deployment-owned `migrations/` directory):

   ```sql
   CREATE TABLE IF NOT EXISTS connecta_kv (
     key           TEXT PRIMARY KEY,
     value         TEXT NOT NULL,
     expires_at_ms INTEGER
   );

   CREATE INDEX IF NOT EXISTS connecta_kv_expiry
     ON connecta_kv (expires_at_ms);
   ```

3. In `src/index.ts`, add `STORAGE_DB: D1Database` to `Env` and build the store
   from it:

   ```ts
   import { d1Storage } from "./d1-storage.js";

   const storage = d1Storage(env.STORAGE_DB);
   ```

   Then delete the `execute: { resumableWrites: false }` line: on D1,
   resumable writes default on, and programs pause at a write until
   `resume_execution` approves it.

   Switching an existing deployment starts from empty state: downstream OAuth
   connections must be re-authorized and vault credentials re-entered, because
   nothing copies them out of the KV namespace.

## Artifacts (optional)

`artifacts()` from `@zackbart/connecta/artifacts` adds the built-in `artifacts`
connector: team pages whose data lives in versioned JSON documents. Every write
commits by compare-and-set, so the store needs the D1 storage above — Workers
KV is refused at construction. Artifacts share the `connecta_kv` table and need
no schema of their own. Bodies (page sources and documents) can stay in D1 rows,
which the default limits keep well under D1's row size, or go to R2 with
`src/r2-artifact-blobs.ts`:

```ts
import { artifacts, kvArtifactStore } from "@zackbart/connecta/artifacts";
import { r2ArtifactBlobs } from "./r2-artifact-blobs.js";

createConnecta({
  // …
  publicUrl: env.PUBLIC_URL, // required: artifact links are shared
  artifacts: artifacts({
    store: kvArtifactStore(d1Storage(env.STORAGE_DB), {
      blobs: r2ArtifactBlobs(env.ARTIFACTS_BUCKET), // optional
    }),
  }),
});
```

For R2, create the bucket (`wrangler r2 bucket create connecta-artifacts`) and
add `"r2_buckets": [{ "binding": "ARTIFACTS_BUCKET", "bucket_name":
"connecta-artifacts" }]` to `wrangler.jsonc` and `ARTIFACTS_BUCKET: R2Bucket`
to `Env`. Nothing ever deletes a body: versions are immutable, a rollback
points back at an old one, and a body written by a write that lost a conflict
stays stored unreferenced.

To refresh pages, keep the module in a variable, pass it to `createConnecta`,
and assign it to `scheduledArtifacts.module` as shown in `src/index.ts`.
Uncomment the hourly cron in `wrangler.jsonc`. An hourly tick starts at most
10 due pages; each page's `manual`, `daily`, or `weekly` schedule lives in its
versioned refresh configuration. Refresh programs use only shared connectors'
explicitly read-only tools within the program owner's current grants. Revoking
refresh or pool access stops future runs. D1's compare-and-set prevents two cron invocations
from claiming the same page. Failed runs keep the last good data and show a
stale banner without exposing downstream error text to readers.

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
     approval       TEXT,
     server_name    TEXT NOT NULL,
     server_version TEXT NOT NULL,
     deployment_id  TEXT
   );

   CREATE INDEX IF NOT EXISTS tool_call_activity_recent
     ON tool_call_activity (occurred_at_ms DESC, id DESC);
   ```

   **Already have this table?** `actor_namespace`, `friction`, and `approval`
   were added after the original example, and `CREATE TABLE IF NOT EXISTS`
   will not add them to a table that already exists. Add them as migrations:

   ```sql
   ALTER TABLE tool_call_activity ADD COLUMN actor_namespace TEXT;
   ALTER TABLE tool_call_activity ADD COLUMN friction TEXT;
   ALTER TABLE tool_call_activity ADD COLUMN approval TEXT;
   ```

   `approval` is set only on an `approved` row — the scope a resumed
   program's approval covered, `call` or `tool` — and is otherwise null.

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

Events carry no arguments, results, generated code, or raw error messages.
The Worker entrypoint already forwards `ctx` to `connecta.fetch`, which lets
async activity writes settle on `waitUntil`.

For retention, add a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
(`triggers.crons` in `wrangler.jsonc` plus a `scheduled` handler — this example
no longer ships one) and call `pruneActivity(env.ACTIVITY_DB, retentionDays)`
from it.
