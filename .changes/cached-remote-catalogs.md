---
type: changed
---

Search and catalog reads serve a remote MCP connector's complete, unexpired cached catalog without connecting. A warm search over cached legacy (2025, stateful-session) connectors no longer pays an `initialize`, `notifications/initialized`, standalone SSE `GET` and session `DELETE` per connector. A miss, expiry, explicit `ttlMs: 0`, invalidation, or credential, token or OAuth epoch change still connects; calls, resource reads, status probes and credential tests still reach the downstream.
