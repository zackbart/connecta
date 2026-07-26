# connecta — Cloudflare Worker example

A deployable Worker that aggregates a downstream remote MCP and an in-code HTTP
API connector behind the nine meta-tools plus `execute_code`, guarded by Clerk
OAuth *and* a static bearer token, with state in a KV namespace.

This is also the **starting template for a deployment**: a real deployment
should be its own repository that pins an exact `@zackbart/connecta` version and
owns only its connector configuration, auth policy, domain, bindings,
migrations, and secrets. See [documentation.md §10](../../docs/documentation.md#10-deployment-architecture).

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
wrangler secret put CONNECTA_TOKEN
wrangler secret put CLERK_SECRET_KEY
wrangler secret put DOWNSTREAM_TOKEN
wrangler deploy
```

`PUBLIC_URL` and `CLERK_PUBLISHABLE_KEY` are plain vars in `wrangler.jsonc`.
Enable Dynamic Client Registration on the Clerk instance (OAuth Applications →
DCR) so Claude/Cursor can self-register — full walkthrough in
[documentation.md §9](../../docs/documentation.md#9-setting-up-clerk-walkthrough).

Then point an MCP client at `<PUBLIC_URL>/mcp`, and open `<PUBLIC_URL>/ui` for
the operator dashboard.

## Toolkits (multi-team)

`src/index.ts` declares two scoped views over the same registry, so one
deployment serves several teams in the org:

| Team | MCP URL | Sees |
| --- | --- | --- |
| support | `<PUBLIC_URL>/mcp?toolkit=support` | `notion` |
| exec | `<PUBLIC_URL>/mcp?toolkit=exec` | `notion`, `echo` minus `echo.shout` |
| operators | `<PUBLIC_URL>/mcp` | everything |

Inside a scoped session every meta-tool behaves as if out-of-scope connectors
and tools do not exist, and an out-of-scope address fails exactly like a
nonexistent one. Toolkits scope **visibility**, not identity: any caller `auth`
admits may select any declared toolkit — or omit the parameter and see
everything — so the shared `CONNECTA_TOKEN` in this example does not separate
the teams. `auth` stays the access check. Full reference:
[documentation.md §16](../../docs/documentation.md#16-toolkits-scoped-views).

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

3. Pass the store to `createConnecta`:

   ```ts
   import { d1ActivityStore } from "./d1-activity.js";

   createConnecta({
     // …
     activity: d1ActivityStore(env.ACTIVITY_DB),
     activityDeploymentId: "production",
   });
   ```

Events carry no arguments, results, generated code, or raw error messages — see
[documentation.md §15](../../docs/documentation.md#15-activity-history).
`toolkit_id` records which of the scoped views above a call came through, so an
operator can tell the support team's traffic from the exec team's. The
Worker entrypoint already forwards `ctx` to `connecta.fetch`, which is what lets
async activity writes settle on `waitUntil`.

For retention, call `pruneActivity(env.ACTIVITY_DB, retentionDays)` from a
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
`scheduled` handler.
