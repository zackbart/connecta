---
type: changed
---

Return MCP response body text untouched when the request has no registered secrets or unregistered private values after the body is fully read, avoiding unnecessary JSON parsing and serialization.
