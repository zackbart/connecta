---
type: fixed
---

`execute_code` programs that use `connecta.search`, `connecta.describe` or `connecta.call` and fail with a `TypeError` reading a property of undefined or null now get the result-shape hint, in QuickJS and V8 wording, alongside the existing "not a function" and "not iterable" cases. The hint is now a conditional reminder rather than a diagnosis: `If that value came from connecta: search and describe return { tools }; call returns { data, format }.` The `result()` declaration in the tool description now includes the `connecta.result(id, { all: true })` form that recovery text tells agents to use. The connector inventory in the `execute_code` and `execute_read_code` descriptions is capped at 1,024 bytes, or less where the description would otherwise pass the 4,096-character host cut-off, so a full roster on a deployment with large limits can no longer push the description past it.
