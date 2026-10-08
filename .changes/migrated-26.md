---
type: fixed
---

Retry accepted OAuth refresh rotations through bounded grant-commit attempts without sending another refresh request. Exhausted commits require re-consent; waiter deadlines remain retryable `unavailable` failures. Failed credential writes return fixed text without storage error causes.
