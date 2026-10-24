---
type: fixed
---

Settle write failures from the complete logical call's dispatch ledger (H1). Only positive pre-dispatch or served-refusal evidence can establish a known failure. A dispatched write with an uncertain result is non-retryable, including when later calls fail, guest code catches an error or a recovery wrapper supplies authorization guidance. Programs retain `writes.unknown` and require reconciliation before a fresh write. Direct keyed Stripe requests retain only the retry guidance supported by the vendor's actual idempotency contract. See [write outcomes and recovery](https://github.com/zackbart/connecta/blob/main/documentation/code-mode.md#writes).
