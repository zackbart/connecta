---
type: changed
---

Read a program call result's other properties from its `data`, so `r.items` and `rows.map(...)` work without guessing the envelope root. `r.data`, destructuring, `Object.keys`, spread, `JSON.stringify` and returning `r` are unchanged. Migration: `r.items === undefined`, `"items" in r` and `for...in` now see `data`'s keys, and a Worker program's return is JSON-normalized, so it no longer carries non-JSON values to the host.
