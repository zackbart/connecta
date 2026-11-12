---
type: added
---

Connectors accept an optional `members` list (`remoteMcp()`, `api()`, every maintained provider, and custom connectors) that narrows who sees them on every endpoint, maintainers' plain `/mcp` included. A caller it omits meets an unknown connector on every surface; agents see the connector only when `"agent:<name>"` is listed (#1377).
