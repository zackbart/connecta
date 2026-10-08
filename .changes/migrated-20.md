---
type: fixed
---

Preserve downstream tool definitions in the complete SQL-backed SDK catalog cache. Output-schema validation, `Mcp-Param-*` header mirroring, and refusal of tools requiring task-based execution use those definitions on warm reads as well as after a same-request listing. Registry manifests v2/v3 are retired and refreshed rather than reused (#704).
