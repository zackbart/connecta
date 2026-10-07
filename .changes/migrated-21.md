---
type: fixed
---

**Tool catalog changes are no longer advertised.** Modern `server/discover`
and legacy `initialize` report `tools.listChanged: false`, because a fresh
server per request cannot publish those notifications. Modern
`subscriptions/listen` requests receive HTTP 404 with JSON-RPC `-32601`
(Method not found), without acquiring a request-admission permit or opening
an SSE stream. Authentication and SDK protocol/header validation still run.
Legacy listens remain unsupported (#704).
