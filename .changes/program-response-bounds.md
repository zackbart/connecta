---
type: changed
---

Program logs are capped by their serialized size: the `logs` string's JSON form, escapes and truncation marker included, is at most 4,000 characters, so control characters and quotes can no longer inflate it to six times that. A failed program's `error.message` is clipped to 4,096 serialized characters, so an executor's oversized error can no longer produce an unbounded response.
