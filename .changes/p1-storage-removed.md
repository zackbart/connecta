---
type: removed
breaking: true
---

Workers KV, `fileStorage` from `@zackbart/connecta/node`, and the Worker
example's copied `cloudflare-kv.ts`, `d1-storage.ts`, `d1-activity.ts`, and
`d1-activity-row.ts` are removed, as is the Node template's
`src/file-activity.ts`. `KVStorage.list` and `KVStorage.compareAndSet` are
required, and `createConnecta` refuses storage missing either at construction.
Every fallback for stores without compare-and-set is gone: downstream OAuth
grant discard, stale-write cleanup, and generation fencing; OAuth handoffs and
single-use connect links; and access-token rename and revocation.
The Worker example binds one D1 database, `CONNECTA_DB`; the Node template
keeps everything, activity included, in `CONNECTA_DATABASE` (default
`./.connecta.sqlite`, `/data/connecta.sqlite` in the container), replacing
`CONNECTA_STATE_FILE` and `CONNECTA_ACTIVITY_FILE` (#705).
