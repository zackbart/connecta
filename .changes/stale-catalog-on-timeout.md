---
type: fixed
---

Keep a slow connector's tools in discovery. When a connector does not answer an unscoped search or native `tools/list` in time, its last complete catalog, up to 24 hours past expiry, is listed and reported with `stale: true` and `ageMs` in `catalogErrors`. Calls still resolve the live catalog. An auth or permission refusal lists nothing and retires that credential's catalog, in every isolate, until a listing succeeds. A downstream's retry delay is kept in `retryAfterMs`, and `connecta doctor` fails with "Native discovery degraded" when a native pool lists a connector stale. Cached and authored catalogs no longer wait for a probe slot, a timed-out probe refreshes its catalog in the runtime's tail, and a publish deletes the catalog revision it supersedes.
