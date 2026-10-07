---
type: fixed
---

Keep downstream tool definitions when discovery serves a memory or storage
cache. Output-schema validation, `Mcp-Param-*` header mirroring, and refusal
of tools requiring task-based execution now use the cached definition, just
as after a same-request listing. Older stored catalogs remain readable (#704).
