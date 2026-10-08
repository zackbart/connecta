---
type: fixed
---

Classify a reviewed read as a write when its live schema digest changes or cannot be checked (#705). `call_tool` refuses it toward `call_destructive_tool`; `execute_code` refuses it before dispatch in read-only pools, while trusted programs may dispatch it. Legacy discovery filters such as `approval-required` select write classification, not host approval policy. Digests cover the whole schema, and oversized unchecked schemas fail closed. Request-local entries classify intake-redacted facts using the running release's review and deployment overrides. Complete SQL-backed SDK caches retain facts, not classification verdicts; retired registry catalogs are refreshed instead of preserving old read claims.
