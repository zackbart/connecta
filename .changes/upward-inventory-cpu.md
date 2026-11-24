---
type: changed
---

Upward `tools/list` and `server/discover` on the meta surface spend less CPU: each connector's inventory entry is built once per connector configuration and reused across probes and requests, the inventory is built once per request for both program tools, and the skills route's parameter schemas are built once. Served descriptions are byte-identical.
