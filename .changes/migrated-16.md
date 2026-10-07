---
type: changed
---

**`@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.3.1.**
The SDK now binds stored credentials to the issuing authorization server
itself, follows HTTP redirects only within an origin for both transports and
OAuth requests, and propagates a `saveTokens` failure after a successful
refresh. Connecta's redirect handling already refused anything else, so no
redirect a downstream sends is treated differently. The server SDK's new
4 MiB request-body default is overridden on both protocol legs, so
`listen()`'s `maxBodyBytes` (10 MiB by default) and the Workers platform
limit remain the bound they were. The SDK now owns the closed-transport race
in the legacy handshake, so connecta's workaround for
[typescript-sdk#2864](https://github.com/modelcontextprotocol/typescript-sdk/issues/2864)
is gone; the handshake teardown sweeps prove no rejection escapes under
workerd without it. Bundles grow by about 5.7 KB gzip at the root and the
Worker example and about 2.9 KB for each hosted-MCP provider, within every cap.
