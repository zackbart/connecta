---
type: changed
breaking: true
---

The result stash's byte and entry bounds are booked in one ledger record in
storage by compare-and-set, so they bound the deployment rather than each
isolate or process. Every chunk expires by its charge's deadline, concurrent
stashes retry a lost swap instead of refusing, and a stash write that fails
releases its charge once it has deleted what it may have written. `engines.node` is `>=22.13.0`, the first
Node 22 with `node:sqlite` unflagged (#705).
