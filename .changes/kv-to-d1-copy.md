---
type: added
---

`copyKvToD1(kv, db, { cursor, overwrite, maxKeys })` on `@zackbart/connecta/d1`
copies a 0.28 Workers KV deployment's state into D1 once, so OAuth grants,
vault credentials, and `cta_` tokens survive the move to `d1Storage`. Each
live entry keeps its key, value, and absolute expiry; expired entries are
skipped, and a D1 entry holding a different value is kept unless `overwrite`
is set, so a rerun copies nothing twice. Each call reads at most `maxKeys`
keys (default 500, inside a Workers Paid invocation's limits) and returns a
resume token until done. Results count keys per key family and never name a
key or value, and errors use fixed wording. The Worker example adds
`scripts/copy-kv-to-d1.mjs`, which runs the copy through wrangler's remote
bindings right after the deploy (#709).
