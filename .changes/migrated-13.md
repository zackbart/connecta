---
type: changed
---

Reject direct upstream `DynamicWorkerExecutor` construction, including
subclasses, before creating runtime resources. The error names the required
`/worker` import and configuration migration; custom executors remain
supported (#704).
