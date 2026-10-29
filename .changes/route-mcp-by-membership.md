---
type: changed
---

Plain `/mcp` now admits a non-maintainer person listed in exactly one pool and serves them that pool exactly as `/mcp/<pool>` does: its tools, `readOnly`, `surface`, `executeCode` and `description`. Maintainers keep the whole catalog; zero or several memberships keep the same 404, logged as `not_maintainer` or the new `ambiguous_pool`, and construction warns about people in several pools, also listed in `describeConfig().peopleInSeveralPools`. Result handles and auth or downstream-input continuations are bound to both the requested path and the admitted pool, so handles minted before this release no longer page. The member page shows `/mcp` as a single-pool member's address.
