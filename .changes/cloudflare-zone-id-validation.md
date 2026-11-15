---
type: changed
---

Cloudflare refuses a zone path segment or GraphQL `zoneTag`, `zoneTag_in` or `accountTag` that is not a 32-character hexadecimal id with `invalid_args` before any request, pointing to `list_zones`, instead of sending a domain name that returns misleading analytics.
