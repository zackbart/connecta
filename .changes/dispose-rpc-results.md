---
type: fixed
---

Cloudflare Access auth now disposes the result of each `ctx.access.getIdentity()` JS RPC call, including one that settles after the lookup deadline. Without this, workerd logged "An RPC result was not disposed properly" and kept the call open until the request ended. `workerExecutor` also disposes each run's `evaluate()` RPC result, and any stubs the guest returned, before it disposes the entrypoint and Loader. Auth decisions and program results are unchanged.
