---
type: changed
breaking: true
---

Bound authenticated MCP request bodies with `admission.requests.maxBodyBytes`, defaulting to 4 MiB on every endpoint. Oversized streams stop with the existing 413 refusal and release admission. The Node adapter's separate pre-auth buffer now also defaults to 4 MiB.
