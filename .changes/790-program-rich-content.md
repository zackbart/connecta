---
type: added
---

Forward MCP rich content from programs with `connecta.emit(result)` or `result.content`, preserving native blocks and metadata within the existing paging and emission limits. Snapshot native results before paging so later connector mutations cannot change retained or emitted content or bypass those limits.
