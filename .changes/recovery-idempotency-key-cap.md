---
type: fixed
---

Preserve caller-supplied REST idempotency keys up to the schema's 255-character limit in `uncertainCall.recovery` after an ambiguous write. Other recovery values retain their 128-character cap, and keys longer than 255 characters are still rejected before dispatch.
