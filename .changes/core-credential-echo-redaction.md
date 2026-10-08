---
type: security
---

Redact credentials used by a call from agent-facing downstream diagnostics,
tool results, and nested errors across all connectors and guest program calls.
The per-call secret set stays in memory and covers credential slots, auth
headers, bearer tokens, URL encodings, and base64 forms.
