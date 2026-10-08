---
type: fixed
---

Fence downstream OAuth refresh dispatch with a durable CAS state and a 20-second HTTP deadline. Expired unsent claims can be taken over; ambiguous dispatched tokens require re-consent and are never resent. Waiter timeouts, including blocked storage reads and local joiners, return retryable unavailable while keeping the grant. SQLite and D1 create and check TTLs with database time so isolate clock skew cannot expire a live holder.
