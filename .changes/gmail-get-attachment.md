---
type: added
---

Read Gmail attachment text and small binary files with `get_attachment`. Attachment listings now expose immutable `partId` identifiers for reads across rotated download ids and for inline attachments. Binary content uses standard base64 for Drive uploads; downloads and whole results have explicit size limits.
