---
type: changed
---

Upgrade `@modelcontextprotocol/client` and `@modelcontextprotocol/server` to 2.3.1. The SDK binds stored credentials to their issuing authorization server and propagates token-save failures. Resource transport redirects remain confined to the same origin; credential-bearing OAuth token requests refuse every redirect. Connecta overrides the server SDK's 4 MiB request-body default on both protocol legs, preserving `listen()`'s `maxBodyBytes` and the Workers platform bound. The SDK owns the closed-transport legacy-handshake race, removing connecta's workaround for typescript-sdk#2864. Teardown regressions cover workerd rejection handling.
