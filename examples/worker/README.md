# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector behind the nine meta-tools plus `execute_code`, guarded by Clerk
OAuth *and* a static bearer token, with state in a KV namespace.

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets. See [deployment architecture](../../docs/operations.md#deployment-architecture).

## Files

| File | What it is |
| --- | --- |
| `src/index.ts` | the Worker entrypoint — connector and auth configuration |
| `src/cloudflare-kv.ts` | `KVStorage` over Workers KV (deployment-owned, not a package export) |
| `src/d1-activity.ts` | `ActivityStore` over D1 (deployment-owned; see below) |
| `wrangler.jsonc` | Worker name, vars, bindings, `compatibility_flags` |

`cloudflare-kv.ts` and `d1-activity.ts` deliberately live here rather than in
the package: storage backends are deployment-owned, so the package ships only
the generic `KVStorage` and `ActivityStore` contracts.

## Deploy

This example has no `package.json` of its own — it resolves the installed
package from the repository root.

```sh
npm install                                    # from the package root

wrangler kv namespace create CONNECTA_KV       # paste the id into wrangler.jsonc

cd examples/worker
wrangler secret put SUPPORT_TOKEN                # bound to the support toolkit
wrangler secret put EXEC_TOKEN                   # bound to the exec toolkit
wrangler secret put CLERK_SECRET_KEY
wrangler secret put DOWNSTREAM_TOKEN
wrangler deploy
```

`PUBLIC_URL` and `CLERK_PUBLISHABLE_KEY` are plain vars in `wrangler.jsonc`.
Enable Dynamic Client Registration on the Clerk instance (OAuth Applications →
DCR) so Claude/Cursor can self-register — full walkthrough in
[setting up Clerk](../../docs/auth.md#setting-up-clerk-walkthrough).

Then point an MCP client at `<PUBLIC_URL>/mcp`, and open `<PUBLIC_URL>/ui` for
the operator dashboard.

## Toolkits (multi-team)

`src/index.ts` declares two scoped views over the same registry and **binds each
one to its own credential**, so one deployment serves several teams in the org
without any team's token opening another team's view:

| Team | Credential | MCP URL | Sees |
| --- | --- | --- | --- |
| support | `SUPPORT_TOKEN` (bound to `support`) | `<PUBLIC_URL>/mcp?toolkit=support` | `notion` |
| exec | `EXEC_TOKEN` (bound to `exec`) | `<PUBLIC_URL>/mcp?toolkit=exec` | `notion`, `echo` minus `echo.shout` |
| operators | Clerk sign-in (unbound) | `<PUBLIC_URL>/mcp` | everything |

Inside a scoped session every meta-tool behaves as if out-of-scope connectors
and tools do not exist, and an out-of-scope address fails exactly like a
nonexistent one. The binding is checked at connect time, before any scoped
registry exists: `SUPPORT_TOKEN` on `?toolkit=exec` — or with no `?toolkit=` at
all — is refused with a 403 identical to the one a toolkit name that does not
exist gets, so a team token is not a directory of the org's other teams. It also
cannot read the deployment-wide operator surfaces (`/ui/data`, `/ui/activity`).
Drop the `toolkits: [...]` option from a `bearerToken(...)` call and that
credential goes back to selecting any view. Full reference:
[toolkits](../../docs/toolkits.md#toolkits-scoped-views).

## Code mode

`worker_loaders` in `wrangler.jsonc` binds the Dynamic Worker sandbox behind
`execute_code`. Dynamic Workers is in open beta on paid plans — delete the
binding and the `executor` line in `src/index.ts` to run with the nine base
meta-tools only. `src/index.ts` already treats the binding as optional, so an
account without it degrades cleanly rather than failing to boot.

## Activity history (optional)

`src/d1-activity.ts` is a complete `ActivityStore` over D1 — keyset paging on
`(occurred_at_ms, id)` plus a batched retention pass — but it is **not wired
into `src/index.ts`**, so the example deploys without a database. To enable it:

1. Create the database and bind it in `wrangler.jsonc`:

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
     connector_id   TEXT NOT NULL,
     tool_name      TEXT NOT NULL,
     source         TEXT NOT NULL,
     outcome        TEXT NOT NULL,
     duration_ms    INTEGER NOT NULL,
     attempts       INTEGER NOT NULL,
     error_code     TEXT,
     server_name    TEXT NOT NULL,
     server_version TEXT NOT NULL,
     deployment_id  TEXT,
     toolkit_id     TEXT
   );

   CREATE INDEX IF NOT EXISTS tool_call_activity_recent
     ON tool_call_activity (occurred_at_ms DESC, id DESC);
   ```

   **Already have this table?** `toolkit_id` is new (it arrived with
   toolkits), and `CREATE TABLE IF NOT EXISTS` will not add it to a table
   that already exists. Add it as its own migration:

   ```sql
   ALTER TABLE tool_call_activity ADD COLUMN toolkit_id TEXT;
   ```

   Do this **before** deploying the updated `d1-activity.ts`: its `INSERT`
   names `toolkit_id`, so against an un-migrated table every write fails with
   `no such column: toolkit_id`. Activity writes are best-effort by design —
   connecta logs the failure and returns the tool result unharmed — so the
   symptom is not an error your agent sees, it is an activity log that
   quietly stops recording.

3. Pass the store to `createConnecta`:

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
[activity history](../../docs/operator-ui.md#activity-history).
`toolkit_id` records which of the scoped views above a call came through, so an
operator can tell the support team's traffic from the exec team's. The
Worker entrypoint already forwards `ctx` to `connecta.fetch`, which is what lets
async activity writes settle on `waitUntil`.

For retention, call `pruneActivity(env.ACTIVITY_DB, retentionDays)` from a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
`scheduled` handler.
