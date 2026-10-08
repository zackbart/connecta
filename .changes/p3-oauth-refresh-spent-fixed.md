---
type: fixed
---

Permanently record downstream OAuth refresh-token fingerprints before dispatch, across grant epochs. Retry valid rotation commits without another HTTP request and require re-consent after every dispatched failure or exhausted commit. Waiter deadlines remain retryable without permitting token replay.
