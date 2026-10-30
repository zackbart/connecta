---
type: changed
---

Contributor tests now hold downstream-request, D1 round-trip and SQL-statement ceilings for the common request shapes (warm and cold-isolate remote MCP calls with header auth and OAuth, refresh after a 401 and before expiry, an `api()` credential call, an unscoped warm search, a five-call program and operator UI connector detail reads) on a production-shaped fixture with a sealed vault, Cloudflare Access and a D1 activity sink. Runtime behavior is unchanged.
