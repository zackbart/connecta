---
type: fixed
---

A program call, resource read or direct call with no more than the dispatch floor left before its deadline (100 ms, or a tenth of a deadline under one second) is now refused unsent with a retryable `timeout` that tells the program to return what it has and continue in a new program, instead of being dispatched with about 1 ms left. `remoteMcp()` and `api()` check the same deadline again at the physical send, after reconnecting, renewing or refreshing a credential, so a write is never sent once its time is spent. Tool calls refused for time, at the run deadline, write gate, dispatch gate or physical send, record a `cancelled` activity event with `attempts: 0` and `errorCode: "timeout"` and no call-failure log line, so they no longer read as downstream timeouts. A refused `connecta.read` records no activity event, like every resource read.
