---
type: changed
---

Record decision 0010's provider kit design and implement request-ledger integration, fixed write capacity, atomic step/item reservation and call-owned cancellation. Every maintained provider now uses the kit; writes preserve the core's whole-call outcome and structured recovery rules. The separate Effect core rewrites remain deferred.
