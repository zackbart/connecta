---
type: fixed
---

Stabilize the bounded skill-cancellation test: it now expires its deadlines only after the downstream skills scope opens, and a new test covers cancellation that lands while local skill manifests are still being hashed, before any downstream scope opens.
