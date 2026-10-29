---
type: changed
---

Search and catalog reads serve a remote MCP connector's complete, unexpired cached catalog without connecting. A warm search over cached legacy (2025, stateful-session) connectors no longer pays an `initialize`, `notifications/initialized`, standalone SSE `GET` and session `DELETE` per connector. A miss, expiry, explicit `ttlMs: 0`, invalidation, or credential, token or OAuth epoch change still connects. The read never seals, binds or refreshes an OAuth grant and never claims a cache generation. A cached catalog does not validate the downstream credential: an expired or revoked credential surfaces on the next call, resource read or credential test, not in search.
