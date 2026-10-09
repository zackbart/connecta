---
type: security
---

Redact submitted writeOnly argument values, private object property names, and their encoded forms before agent output or result paging storage. Exempt empty strings; protect short non-empty values by redacting exact structured string matches and withholding matching prose while preserving identifiers and approval state. Scan raw wire text before JSON interpretation so numeric echoes and registration refusals stay protected, and redact private values containing the placeholder. Bound literal matching and escaped scanning so large private values retain safe success metadata without matcher exceptions. Keep public-only schemas on their existing path and retain surrounding wire whitespace during literal replacement.
