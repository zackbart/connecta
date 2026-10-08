---
type: added
---

`copyKvToD1(kv, db, { source, cursor, overwriteFamilies, maxKeys, verify })`
on `@zackbart/connecta/d1` copies a 0.28 Workers KV deployment's state into D1
during a maintenance window, preserving OAuth grants, vault credentials,
`cta_` tokens, and absolute expiries. It skips oversized UTF-8 strings/rows,
bounds buffered bytes, and reports invalid/conflict/verification counts by
family only. Resume tokens require the same source id and an atomic claim;
error labels use class identity. Overwrite requires an explicit family list.
`markKvToD1Live` seals the source in D1 before traffic reopens, refusing later
copies unless explicitly overridden. The Worker runbook backs up and drains
writers, waits for stable KV, copies and verifies before deployment, checks
existing credentials under maintenance, then reopens traffic (#709).
