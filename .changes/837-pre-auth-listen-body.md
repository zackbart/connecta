---
type: security
---

No MCP endpoint reads a request body before auth. A POST whose `Mcp-Method` header named `subscriptions/listen` skipped request admission, and connecta then buffered its entire body to confirm the method before authenticating the caller, so an unauthenticated client could hold unbounded memory per request with no permit on `/mcp` and `/mcp/<pool>` (and `/agent/<pool>`). Such a request now authenticates and passes endpoint admission first, and its body is read for classification only up to 64 KiB; past that connecta answers 413 with JSON-RPC code `-33006` and stops reading. A confirmed modern listen still takes no permit and is refused as unsupported; any other body with that header takes a permit before dispatch.
