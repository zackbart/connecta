---
type: added
---

`listen(..., { maxInFlightBodyBytes })` bounds the request body bytes all in-flight requests hold together on Node. It defaults to 64 MiB, or `maxBodyBytes` when that is larger. Past it a request is answered `503` with `Retry-After` and `Connection: close`. `maxBodyBytes` and its `413` are unchanged, and Workers are unaffected.
