---
type: added
---

`discovery.catalogZeroTtlSeconds` (default 0, off) lets a deployment reuse remote MCP tool catalogs whose servers send `ttlMs: 0`, the MCP SDK server's default list hint: a positive value replaces an explicit zero `tools/list` hint and is bounded by `catalogMinTtlSeconds` and `catalogMaxTtlSeconds`. Resource inventories are not floored, `catalogMinTtlSeconds` still never applies to a zero hint, and generation, credential and refusal-fence checks still apply. Read-program and read-only revalidation now relist such a catalog once the floor lapses, so a reclassification to write reaches those calls within `catalogZeroTtlSeconds`. Timing traces add `catalog.store` and `catalog.store.refused.<reason>` (`zero_ttl`, `partial`, `expired`, `fenced`, `ended`) counters and split invocation connector time into `connector.mcp`, `connector.api` and `connector.custom`. `describeConfig().limits.discovery` reports the new option.
