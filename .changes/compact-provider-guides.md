---
type: changed
breaking: true
---

Shrink every maintained connector guide to provider-specific facts. Generic paging, `fields`, withheld-value and write-once rules now live in the `cursor`, `page` and `fields` schemas and the `write_outcome_unknown` error; a hatch page that cannot continue adds an incomplete-result warning; and a read-only connection is no longer served its guide's write rules. A `skills` fetch now returns its text once, in `content`, as documented, so a client reading `structuredContent.text` from that fetch must read `content`; the tool advertises no `outputSchema`.
