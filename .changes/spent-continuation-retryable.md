---
type: fixed
---

Mark failed downstream input continuations as not retryable once their single-use nonce is consumed. Recovery guidance now re-issues the original direct call to start a fresh input round instead of resending the spent continuation, while preserving typed failure codes and first-call retryability.
