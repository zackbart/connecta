---
type: fixed
---

Refuse malformed `callAdmission` policies at construction across connector and maintained provider factories, including custom connectors registered by a deployment. Only omission or `undefined` selects the documented default; `false`, `null`, `0`, and `""` no longer silently disable admission or select a default.
