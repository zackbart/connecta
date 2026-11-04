---
type: fixed
---

Keep a slow connector's tools in discovery. When a connector does not answer an unscoped search or native `tools/list` in time, its last complete catalog, up to 24 hours past expiry, is listed and reported with `stale: true` and `ageMs` in `catalogErrors`. Calls still resolve the live catalog, and auth or permission failures never list a stale catalog. Cached and authored catalogs no longer wait for a probe slot, a timed-out probe refreshes its catalog in the runtime's tail, and a publish deletes the catalog revision it supersedes.
