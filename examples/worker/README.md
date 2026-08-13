# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector, guarded by Clerk OAuth *and* a static bearer token, with state in
a KV namespace. Its required Worker Loader binding backs the seven-tool surface
and requires the Workers Paid plan.

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
wrangler secret put SUPPORT_TOKEN                # one headless client
wrangler secret put EXEC_TOKEN                   # another headless client
wrangler secret put CLERK_SECRET_KEY
wrangler secret put DOWNSTREAM_TOKEN
wrangler secret put CREDENTIAL_ENCRYPTION_KEY   # base64 32-byte AES key
wrangler deploy
```

`PUBLIC_URL` and `CLERK_PUBLISHABLE_KEY` are plain vars in `wrangler.jsonc`.
Enable Dynamic Client Registration on the Clerk instance (OAuth Applications →
DCR) so Claude/Cursor can self-register — full walkthrough in
[setting up Clerk](../../documentation/auth.md).

### Copied into its own repository

The `npm install` above is the connecta repository's, which already has every
dependency this file imports. A copy with its own `package.json` installs three
things, because two of them are not part of connecta and never install with it:

```sh
npm install @zackbart/connecta @cloudflare/codemode @clerk/backend
```

`@cloudflare/codemode` is the executor behind `execute_code`, and
`@clerk/backend` is the optional peer behind `@zackbart/connecta/auth/clerk` —
which `src/index.ts` imports at the top level, so wrangler must resolve it at
build time. Miss it and the build stops at
`Could not resolve "@clerk/backend"`, which is a missing peer rather than a
broken example. Drop `clerkAuth` from `auth` if this deployment has no operator
sign-in, and the peer goes with it — but read
[the operator surface](#the-operator-surface) first, because a deployment
without it can never write a credential or issue an access token.

Then point an MCP client at `<PUBLIC_URL>/mcp`, and open `<PUBLIC_URL>/` for
Connections. Credentials is at `/credentials`, named MCP access tokens are at
`/tokens`, Activity is at `/activity`, and legacy `/ui` redirects to `/`. Each
of those three appears in the nav only when this deployment can serve it — see
the next section for what turns each one on.

## The operator surface

This example ships the whole operator feature set. Three quarters of it is on
as deployed; the fourth needs a database, so it is commented in place.

**Operator sign-in** is the `clerkAuth` entry in `src/index.ts`, alongside two
static bearers. The split is deliberate: a bearer is a client key that may call
tools and read connector status, while writing a credential or issuing an
access token requires an interactive Clerk identity. Narrow who that can be
with `allowedDomains`, or with a `gate` for anything a domain cannot express.

**The credential vault** is `credentials: { encryptionKey: … }`, backed by the
same KV namespace as everything else and encrypted with the
`CREDENTIAL_ENCRYPTION_KEY` secret before a value reaches it. Generate one with:

```sh
node -e "console.log(crypto.randomBytes(32).toString('base64'))"
```

Leave the secret unset and the deployment still runs — `/credentials` stays
read-only and connecta says so at startup. Keep the key in Worker secrets and
nowhere near KV: it is the only thing that makes a copied namespace useless.
Rotation takes effect on the next call, with no redeploy and no liveness probe,
because credentials fail at use.

The vault is ready here, and the Credentials page is still hidden, because that
page lists connector credential slots rather than deployments. Neither
connector in `src/index.ts` declares one — Notion carries a deployment-owned
static header and echo has no secret — so nothing would be on the page. Add
`credential: { label: "API token" }` to an `api()` connector (the commented
shape on `echo` is exactly it) or use a provider connector such as `notion()`,
which declares its own, and Credentials appears for a signed-in operator on the
next load.

**Access tokens** are `accessTokens: {}`. A signed-in operator mints named,
revocable Bearer tokens at `/tokens` for header-capable clients that will not do
OAuth. Secrets are shown once and only their hashes enter KV; a lost token is
reissued, never recovered. Note the KV caveat above — revocation is visible
everywhere only as fast as the namespace converges.

**Activity** is the commented block in `src/index.ts` and the commented
`d1_databases` binding in `wrangler.jsonc`; the section below creates the
database and applies the schema.

None of these change what agents can reach. Operator routes manage the
authentication material behind capabilities `src/index.ts` already declares —
never the connector set, the tool catalog, or its annotations.

`connecta doctor` reports the same line here as for a deployment with none of
this on: connector count, executor, seven tools. It carries a bearer, and a
bearer learns the model-facing surface rather than the deployment's
configuration topology. Confirm the operator surface the way an operator will:
sign in at `<PUBLIC_URL>/` and check that Tokens is live. Credentials joins it
once a connector declares a `credential` slot, and Activity once the D1 wiring
below is on — the nav shows a page when the deployment can actually serve it,
so a missing page is the honest report that its half is still off.

## Code mode

The Dynamic Worker sandbox requires the
[Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
The required Worker Loader binding is checked into `wrangler.jsonc`:

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

`src/index.ts` constructs `DynamicWorkerExecutor` from `env.LOADER` and serves
the seven-tool surface. The executor package is one of the installs a copied
deployment owns — see
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

3. In `src/index.ts`, uncomment the `d1ActivityStore` import, the `ACTIVITY_DB`
   field on `Env`, and the `activity` block — the three commented fragments
   that together read:

   ```ts
   import { d1ActivityStore } from "./d1-activity.js";

   createConnecta({
     // …
     activity: {
       store: d1ActivityStore(env.ACTIVITY_DB),
       deploymentId: "production",
     },
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
