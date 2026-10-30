---
type: added
---

Credentials can be tested before they are saved. `PUT /ui/credentials/<id>` with `verify: "test"` tests the candidate in memory under `discovery.probeTimeoutMs` and stores it only if the test passes; `verify: "skip"` (the default) stores it unverified, so an outage never blocks a replacement. Tests answer a typed failure class (`rejected`, `scope`, `unreachable`, `timeout`, `failed`) instead of a bare `ok`, `CredentialTestResult` gains an optional `failure`, and the operator page shows a stored last-verified record for credential connectors, bound to the revision each vault save now seals, so a concurrent replacement is never shown as verified. Vaults gain an optional `snapshot()` and per-save `revision` metadata. `remoteMcp()` credential tests now test the value they are given rather than refusing an unsaved one.
