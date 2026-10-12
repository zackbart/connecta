---
type: added
---

Read Gmail attachment text and small binary files with `get_attachment`. Attachment listings now expose immutable `partId` identifiers for reads across rotated download ids and for inline attachments. Binary content uses standard base64 for Drive uploads; downloads and whole results have explicit size limits.

Parsed forwarded attachments include their headers and readable body after checking descendant sizes. MIME charset parameters accept whitespace and quoted values, unsupported charsets are reported, and inconsistent attachment byte counts are refused.
