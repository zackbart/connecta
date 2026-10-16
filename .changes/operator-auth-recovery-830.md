---
type: fixed
---

Recover operator pages from transient Cloudflare Access and auth-state failures without reloading. Distinguish unavailable identity lookups from rejected identities, prevent caching refusals, reconcile catalog and auth refreshes, scope and cancel bounded OAuth status polling, prevent queued focus recovery after sign-out, preserve shared passive retry throttling and backoff across Access refusals, coalesce passive returns through slow catalog/auth recovery with a 15-second admission deadline that releases Retry without aborting healthy pending reads, and show unreadable credentials as unavailable.
