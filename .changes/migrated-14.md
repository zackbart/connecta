---
type: changed
---

Require a non-enumerable, versioned lifecycle brand on executors before
creating runtime resources. `/worker` and `/quickjs` carry the brand across
package copies and bundles; unbranded executors fail with all migration
options. Custom sandboxes opt in with
`customExecutor(myExecutor, { lifecycle: "self-managed" })` (#704).
