---
type: fixed
breaking: true
---

Make logs, status and activity payload-free (INV-6, #695, #716). Failure records contain checked typed facts instead of messages, stacks or raw downstream error text. `ActivityEventInput.errorCode` is a closed union, and call-failure logs replace `message` with those facts. Status text and tool names follow the same disclosure checks. Downstream body reads use UTF-8 byte decoding, and catalog drift timestamps are validated before disclosure.
