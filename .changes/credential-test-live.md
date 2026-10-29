---
type: fixed
---

A remote MCP connector's credential test always sends a live `tools/list` to the downstream. Against a modern server whose catalog was cached, it previously could report success from the cache without any request.
