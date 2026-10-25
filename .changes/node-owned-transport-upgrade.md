---
type: changed
breaking: true
---

Require Node deployments to serve with `listen()` from `@zackbart/connecta/node` and install `undici@6.29.1`. Without its owned sender, every maintained-provider write, every reviewed POST read and every remote MCP write is refused before sending, although each worked in 0.34.1. With `listen()`, every maintained-provider request, reads included, and remote MCP writes connect directly, ignoring `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` and host proxy dispatchers; only remote MCP reads keep native fetch and its proxy settings. Deployments needing a proxy for maintained providers or remote MCP need approved direct egress or the Workers shape before upgrading. Explicit proxy configuration for the owned sender is follow-up work.
