---
type: fixed
---

`remoteMcp()` now bounds each `tools/call` answer on the wire to the larger of `results.maxStashBytes` and 8 MiB. JSON and event-stream bodies are counted as they stream, a declared `Content-Length` past the bound is refused unread, and event streams still pass progress and server requests along as they arrive. An oversized answer is cancelled at the bound instead of being buffered whole, which could exhaust a Worker's memory. The call fails as non-retryable `connector_call_failed` and says to narrow the request; a write answered past the bound reports `writeOutcome: "unknown"` and is never resent (#1364).
