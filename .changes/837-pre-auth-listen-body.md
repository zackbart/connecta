---
type: security
---

Affected versions: 0.29.0–0.32.0. An unauthenticated POST with `Mcp-Method: subscriptions/listen` to `/mcp` or `/mcp/<pool>` was buffered with no byte cap before authentication and request admission, so an anonymous client could hold unbounded memory per request without taking an admission permit. Every MCP endpoint (`/mcp`, `/mcp/<pool>`, and `/agent/<pool>`) now authenticates first, and endpoint admission follows, before any body is read. Every pre-dispatch body read is bounded: classification reads at most 64 KiB, and past that connecta answers 413 with JSON-RPC code `-33006` and stops reading. A confirmed modern listen still takes no permit and is refused as unsupported; any other body carrying that header takes a permit before dispatch.
