---
type: changed
---

A warm OAuth remote MCP call makes fewer sequential storage reads: 6 D1 round trips instead of 12 on a modern downstream and 11 instead of 15 on a legacy one, with non-OAuth calls unchanged. Catalog acceptance reads the grant and the catalog generation in one statement. A call's admission reads the grant once for both the disconnect and token checks. A connect binds the epoch and addresses its first listing from the fresh read the request already made, and a modern connect that sends nothing skips its post-connect epoch check. The SDK still reads the grant before every message, and rotation, refresh, disconnect and same-epoch token invalidation are refused or adopted before anything is sent with a stale credential. A rotation that lands just after a connect binds its epoch is refused as retryable "authorization changed" rather than reconnected within the same call. (#1424)
