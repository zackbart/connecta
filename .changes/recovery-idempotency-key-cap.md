---
type: fixed
---

Preserve caller-supplied REST idempotency keys up to the schema's 255-character limit in `uncertainCall.recovery` after an ambiguous write. Versions 0.31.0 through 0.32.0 echoed caller-supplied keys only up to 128 characters. Other recovery values retain their 128-character cap, and keys longer than 255 characters are still rejected before dispatch.
