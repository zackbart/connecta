---
type: changed
---

Move Gmail onto the shared Google provider kit while retaining its draft-only tools, catalogs, MIME requests, projections, guides and bound cursors. Track auxiliary lookups separately from draft writes when reporting whether a draft write was dispatched. Sanitize decoded Gmail bodies and attachments before truncation while retaining their original byte-size checks.

Keep multi-request Gmail reads working when served as writes, validate large encoded bodies without overflowing the regex stack, and refuse draft replacement when redaction hides an attachment's disposition or a header name.
