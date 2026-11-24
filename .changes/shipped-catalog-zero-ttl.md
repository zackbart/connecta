---
type: changed
---

The Node template and Worker example set `discovery.catalogZeroTtlSeconds: 300`, so new deployments reuse tool catalogs from remote MCP servers that send `ttlMs: 0` (the MCP TypeScript server SDK's default) for five minutes instead of listing them again on every request. A tool such a server adds or reclassifies from read to write is not seen until that window lapses and a listing succeeds, the bound already accepted for servers that omit `ttlMs`. The library default stays 0; the deployment guide tells existing deployments to add the setting (#1483).
