---
type: added
---

Pools take an optional `description`: one line of plain text, 1 to 500 characters, that `/mcp/<pool>` and `/agent/<pool>` append to their MCP instructions after `This endpoint: ` so the model learns that endpoint's scope. Plain `/mcp` and pools without one keep the shared instructions, and `describeConfig()` lists each pool's `description` (`null` when unset).
