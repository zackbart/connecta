---
type: fixed
---

A program call, resource read or direct call with no more than the dispatch floor left before its deadline (100 ms, or a tenth of a deadline under one second) is now refused unsent with a retryable `timeout` that tells the program to return what it has and continue in a new program, instead of being dispatched with about 1 ms left. These refusals, and those at the write and dispatch gates, record a `cancelled` activity event with `attempts: 0` and `errorCode: "timeout"` and no call-failure log line, so they no longer read as downstream timeouts.
