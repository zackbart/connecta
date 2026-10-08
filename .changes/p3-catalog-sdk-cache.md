---
type: changed
breaking: true
---

Use SDK Client.listTools aggregation and a SQL-backed ResponseCacheStore for complete, intake-redacted remote MCP catalogs. Honor bounded downstream ttlMs and public/private scope within host-computed auth partitions; request tokens and personal auth remain private even under public hints. Partition private entries by admitted principal and pool even with shared auth, preserve original fetch age, and refuse invalid header declarations before SDK logging. Replace the registry's memory/stale/persist cache with request-local reads. Remove discovery.persistCatalog and discovery.staleCatalogSeconds; add catalogMinTtlSeconds and catalogMaxTtlSeconds (defaults 0 and 86400). catalogTtlSeconds remains the legacy fallback. Retired registry catalogs are ignored; failed or expired listings never serve a stale fallback.
