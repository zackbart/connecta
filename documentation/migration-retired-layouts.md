# Migrate before past-layout support is removed

Use this guide before upgrading to the release that removes the pre-0.29
storage and OAuth layout migrations. [Deployment upgrades](./deploying.md#upgrade-an-existing-deployment)
cover the general procedure; [the agent index](./README.md) routes other work.
Apply intervening configuration and provider migrations too.

**0.37.1 is the last bridge release containing these migrations.** A deployment
with Workers KV, a JSON state file, or OAuth layout-2 grants must first upgrade
to exactly `@zackbart/connecta@0.37.1` and finish the relevant migrations there.
Installing the bridge release alone does not migrate unused grants or storage.
Deployments already using D1 or SQLite with layout-3 grants need no conversion.
Keep the existing database, connector ids, owner partitions, and vault key.

## Before updating the package pin

1. Back up the source state and destination database securely, including expiry
   metadata, and preserve the credential encryption key. Stop traffic and all
   background writers; drain OAuth callbacks and refreshes. Keep a recoverable
   0.37.1 deployment and its installed package until verification completes.
2. For Workers KV, use 0.37.1's installed
   `examples/worker/scripts/copy-kv-to-d1.mjs` and `kv-to-d1.wrangler.jsonc`.
   Follow that version's `examples/worker/README.md#upgrading-from-028`:
   wait for stable KV, run `--maintenance`, resolve invalid entries and
   conflicts, run `--maintenance --verify`, switch to D1 under maintenance,
   verify, then run `--maintenance --mark-live` before reopening traffic.
   The underlying API is `copyKvToD1(kv, db, { source })` from
   `@zackbart/connecta/d1`; finish every returned cursor, verify hashes and
   expiries, and call `markKvToD1Live(db, source)` before cutover. Never copy
   stale KV over a database that has accepted new writes.
3. For Node's pre-SQLite JSON state, stop the server and run the bridge CLI:

   ```sh
   npx --yes --package=@zackbart/connecta@0.37.1 connecta migrate-state .connecta-state.json .connecta.sqlite
   ```

   It copies live entries with their expiry, keeps existing destination keys,
   and leaves the JSON file unchanged. The old activity JSONL is not imported.
   Use the destination SQLite file for subsequent starts.

4. While still running 0.37.1 over the SQL destination, open **every OAuth
   grant once, for every connector and owner partition** through its normal
   authorized connection. This includes dormant personal grants. The first
   grant read converts layout 2 to the single layout-3 `oauth:grant` record
   and deletes historical keys. Merely listing configuration is insufficient.
   Grants too old to have issuer binding, invalid ciphertext, and pending
   consents require fresh authorization on the bridge release.
5. Verify each existing OAuth connection, vault credential and agent token,
   including every personal owner. Confirm layout-3 grant records and no
   pending layout-2 cleanup using trusted storage tooling without printing
   credential bodies. Only then upgrade the package pin to the removing release.

## Removed interfaces and stale state

| Removed path                                                                                                                       | Behavior after upgrading                                                                                                                                                                                                                                                                                                | Recovery                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth layout-2 reader and cleanup                                                                                                  | An owner with only old keys has no usable grant. Reads return absent, credentials are never opened or copied, and a warning says to authorize again or migrate on 0.37.1. Calls require consent. Old keys remain untouched. Existing layout-3 grants, including those with an obsolete cleanup marker, remain readable. | Connect again. To preserve an old grant instead, restore a consistent pre-upgrade backup and run the bridge procedure.                         |
| `copyKvToD1`, `markKvToD1Live`, their types/error, and copy script/config                                                          | Named imports fail; no KV copy runs. A KV adapter without atomic compare-and-set is refused at construction. A fresh D1 database contains none of the old credentials or tokens. The `/d1` subpath still exports `d1Storage` and `d1ActivityStore`.                                                                     | Stop writers and restore a consistent backup with 0.37.1, then copy and verify before cutover.                                                 |
| `importStateFile`, `StateFileImport`, and `connecta migrate-state`                                                                 | Named imports fail; the CLI command exits nonzero with usage. The SQLite adapter never reads the JSON file, so a fresh database has no old credentials or tokens.                                                                                                                                                       | Import on 0.37.1 while stopped, then point the deployment at that SQLite file.                                                                 |
| Retired `execute.resumableWrites`, `execute.pausedRunTtlSeconds`, `identity`, `grant`, and deployment/pool `trust` migration hints | Construction still rejects these as ordinary unknown configuration options. It no longer expands identity keys or prints replacement instructions. Pool `grant` is also rejected.                                                                                                                                       | Remove obsolete options. Follow [migration to 0.33](./migration-0.33.md) for `maintainers`, pool `members`, `agents`, and explicit `readOnly`. |

A rollback after accepting new SQL writes can resurrect revoked credentials or
spent refresh tokens. Recover from a consistent backup under maintenance rather
than merging old KV/JSON state into a live database. If preserving old auth is
unnecessary, reconnect credentials and issue fresh agent tokens in the current
SQL deployment; revoke superseded credentials at their providers.

## Verify

Run `connecta doctor --pool <pool>` with each agent's token. Open each shared
and personal OAuth connection and make a controlled read. Confirm authorization
works without an unsupported-layout warning, the intended SQL database is used,
and the operator UI shows expected credentials and activity. Remove one-shot
migration routes and bindings after successful cutover.
