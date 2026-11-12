---
type: fixed
---

Cloudflare Access auth now disposes the result of each `ctx.access.getIdentity()` JS RPC call, including one that settles after the lookup deadline. workerd asks callers to dispose every object an RPC call returns, and connecta left these results open until the request ended. `workerExecutor` also disposes each `evaluate()` RPC result, and any stubs the guest returned, exactly once, including a result that arrives after the run was released or cancelled. Auth decisions and program results are unchanged.
