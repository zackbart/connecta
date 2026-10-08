---
type: fixed
---

Keep a result stash's ledger charge reserved during writes, then retain it
through the latest possible chunk expiry when cleanup fails, so slow writes
cannot leave readable orphan chunks outside the byte and entry limits.
Retry transient ledger errors, distinguish exhausted CAS retries, and persist
completion receipts so later bookings recover completed reservations after
contention prevents release or settlement.
State-file import and `migrate-state` report database failures with fixed
step descriptions, preventing SQLite trigger errors from printing imported
values (#726).
