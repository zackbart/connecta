---
type: fixed
breaking: true
---

Book each result stash reservation once with a finite deadline of booking time
plus a 30-second write budget plus the chunk TTL, normally 15 minutes. Stop the
write loop on timeout and return no paging ID. Absolute chunk and ledger expiry
prevents late or ambiguous writes from extending that bound. Custom KVStorage
adapters must honor the new `expiresAtMs` option on set and compareAndSet and
declare `capabilities: { absoluteExpiry: true }`; construction rejects legacy
adapters without that explicit opt-in. Rejected write responses retain the
original reservation because their dispatched operation may commit later.
Settlement and cleanup shorten or remove charges when possible; after failure
or exhausted retries, capacity may be over-held until the booked deadline.
Bound each cleanup/release or settlement path to 15 seconds, including storage
I/O, and abandon further work when its budget expires so stalled operations
cannot hang the caller after the write timeout.
Remove durable completion receipts and their recovery path.
State-file import and `migrate-state` report database failures with fixed
step descriptions, preventing SQLite trigger errors from printing imported
values (#726).
