---
type: changed
breaking: true
---

Bind modern MCP client capabilities and identity to request-local meta-tool context; record only allowlisted ASCII client name/version facts in activity, including SQLite and D1 storage. Client names are bounded to 64 characters and versions to 32; invalid values are absent at recording, storage write/read, and operator UI boundaries. Advertise the served extension map and private discovery cache hints, declare direct-call address headers, and make doctor negotiate through the SDK and report its revision using the exported META_TOOL_NAMES set. Connecta-owned 403, pool 404, and deadline 504 refusals now return JSON-RPC error bodies with unknown request IDs omitted. Admission codes change from -31001/-31002 to -33001/-33002; deadline, pool, and access refusal codes are -33003/-33004/-33005.
