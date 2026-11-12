---
type: fixed
---

`remoteMcp()` now bounds every MCP transport answer as it streams, instead of buffering it whole, which could exhaust a Worker's memory. A tool's answer is bounded to the larger of `results.maxStashBytes` and 8 MiB, and a listing page to the 32 MiB catalog ceiling. A declared `Content-Length` past the bound is refused unread. Event streams still pass progress and server requests along, and a stream resumed with `Last-Event-ID` is bounded as the call it resumes. HTTP error and `202` bodies keep their status but only their first 64 KiB are read. A tool call answered past its bound fails as non-retryable `connector_call_failed` and says to narrow the request; a write answered past it reports `writeOutcome: "unknown"` and is never resent (#1364).
