---
type: fixed
---

The Node server `listen()` returns stops admitting requests at `close()`. Requests already received complete normally; a request that arrives on an open connection afterwards is answered `503` with `Retry-After: 1` and `Connection: close` once every earlier response on that connection is written, then the connection ends. A client that kept pipelining onto a busy connection could otherwise hold a direct `close()` open indefinitely.
