---
type: changed
---

A program's retained results are now unreadable from other requests until they pass the run's complete secret set. At its end a run waits for its host calls and credential reads to finish within the response's answer-by time, then publishes each entry that passes. A run pays no extra storage, and reads stored bytes back only for entries the set grew past. Stored bytes are never rewritten, so an offset issued during the run stays valid. An entry that matched, or could not be checked or written, stays unreadable: paging it from a later request answers `result_not_retained` with `retryable: false`, a read told to rerun and a write told not to repeat, and the run's response carries a `note` saying so. Paging inside the run is unchanged, and direct-call stashes keep passing their own request's set when stored.
