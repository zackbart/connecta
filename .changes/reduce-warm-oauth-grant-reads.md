---
type: changed
---

Reduce grant reads on warm OAuth remote MCP calls while retaining fresh catalog acceptance, disconnect, token rotation and dispatch checks. Keep the separate invocation token read so same-epoch invalidation refuses writes with OAuth recovery before dispatch, and expiry changes are observed before early renewal.
