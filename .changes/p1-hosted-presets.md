---
type: changed
---

Convert the eight hosted MCP implementations to reviewed `defineProvider()` presets. Preserve authentication, endpoint choices, tool classifications, schema digests, results, and API defaults. Add usage prerequisites and pool-trust guidance. Hosted factories now reject blank titles and malformed common options at construction. Remove the internal `withVettedCatalog` helper; public `*_VETTED_CATALOG` exports remain deprecated aliases of each provider definition's classification.
