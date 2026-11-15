---
type: fixed
---

Node's `listen()` keeps idle keep-alive connections open for 100 seconds instead of Node's 5-second default, so a client reusing a pooled socket no longer loses a request to `ECONNRESET` as the server closes it. Set `listen(..., { keepAliveTimeoutMs })` to change it.
