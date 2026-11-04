---
type: changed
---

End program reads just before the executor's run deadline, so a slow read becomes a catchable, retryable `timeout` and `Promise.allSettled` keeps every result that finished. Executors may publish `deadlineMs`; `quickJsExecutor()` and `workerExecutor()` do, and `execute_code` states it as `<n>s/run`. Writes stay exempt so a drained write's outcome is still learned, and a write that reaches its gate after reads have stopped is refused unsent.
