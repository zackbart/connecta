---
type: fixed
---

Downstream OAuth tokens are refreshed before they expire, not only after a 401. Grants now store `expiresAt` with their tokens, counted from when the token request was sent (an `expires_in` of `0` expires at issuance), and a call whose token is within 60 seconds of it renews first through the existing refresh coordinator, so a `remoteMcp()` or `api()` write no longer meets an avoidable 401 and an unknown outcome. The renewal runs in the invocation's authorization check, so a failed one is a plain `downstream_oauth_required` with nothing sent. Two isolates that find the same token due spend one refresh token. Grants stored without `expiresAt` keep refreshing after a 401 until their next refresh stores one; reading a grant never adds it, and status, listing and discovery never refresh. Waiting on another isolate's refresh now polls with a 50 ms to 2 s backoff and reads its lease, grant and spent record in one batched read.
