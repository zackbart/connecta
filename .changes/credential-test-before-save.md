---
type: added
---

Credentials can be tested before they are saved. `PUT /ui/credentials/<id>` with `verify: "test"` tests the candidate in memory under `discovery.probeTimeoutMs` and stores it only if the test passes; `verify: "skip"` (the default) stores it unverified, so an outage never blocks a replacement. Tests answer a typed failure class (`rejected`, `scope`, `unreachable`, `timeout`, `failed`) instead of a bare `ok`, `CredentialTestResult` gains an optional `failure`, and the operator page reports a stored last-verified record for credential connectors and `api()` OAuth, whose grant now shows real calls' accept or reject outcome rather than its mere presence. `remoteMcp()` credential tests now test the value they are given rather than refusing an unsaved one.
