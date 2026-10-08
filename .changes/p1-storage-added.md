---
type: added
---

`@zackbart/connecta/d1` exports `d1Storage(db)` and
`d1ActivityStore(db, { retentionDays })`; `@zackbart/connecta/sqlite`
(Node-only, on the built-in `node:sqlite`) exports `openSqlite(path)`,
`sqliteStorage(db | path)`, `sqliteActivityStore(db | path, { retentionDays })`,
and `importStateFile(db, statePath)`. Both drivers share one SQL store; each
creates its tables on first use and reads a 0.28 `connecta_kv` or
`tool_call_activity` table as is, adding activity columns it lacks. Activity
writes prune a bounded batch past the retention window, 90 days by default, so
no cron is needed. `connecta migrate-state <state.json> <connecta.sqlite>`
copies a 0.28 `fileStorage` state file into SQLite once, keeping any key the
database already holds. Every storage key is built in `src/storage/keys.ts`,
which lists each key family's scope, version, codec, and TTL (#705).
