---
type: fixed
---

Mark failed downstream input continuations as not retryable once their single-use nonce is consumed. Read failures without existing recovery prerequisites direct a fresh input round through the original call. Write reconciliation and auth recovery guidance stay unchanged; spent continuations must not be resent. Typed failure codes and first-call retryability are preserved.
