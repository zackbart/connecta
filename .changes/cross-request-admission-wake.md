---
type: fixed
---

Resume a queued `execute_code` program, MCP request, connector call or OAuth refresh waiter in its own request, whichever request released the slot or finished the refresh. On Workers with compatibility date 2025-06-16 or later, workerd's September 2026 releases refused that cross-request resume: the releasing program failed with `Executor failed: Cannot call this AsyncLocalStorage bound function outside of the request in which it was created.`, and the queued one later hit `Executor admission timed out`. QuickJS host calls now also run in the async context of the request running the program, not the request that spawned its warm child. `workerExecutor()`'s default queue deadline rises from 5 to 60 seconds, so a queued run can wait out one default guest deadline; the pool remains two runs and eight queued per isolate, and `admission` still replaces the defaults. Queue refusals remain `executor_overloaded` with `retryable: true` and `retryAfterMs`.
