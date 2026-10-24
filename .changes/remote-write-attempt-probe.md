---
type: fixed
---

Send remote MCP writes through the owned Node transport so HTTP 421 responses
and host retry dispatchers cannot silently repeat them. Node deployments must
serve with `listen` from `@zackbart/connecta/node` to send remote writes;
unconfirmed dispatched writes retain an unknown outcome.
