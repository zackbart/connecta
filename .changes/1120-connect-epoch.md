---
type: fixed
---

Keep remote MCP authorization starts and status checks bound to the successful connection's OAuth epoch, so a concurrent Restart supersedes the older attempt instead of letting it read the replacement grant or publish consent there.

Explicit starts after a passive status check or call in the same request scope can still initiate consent without widening the cached connection's authorization permissions.
