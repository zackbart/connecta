---
type: removed
breaking: true
---

People connect only at plain `/mcp`; `/mcp/<pool>` is removed and answers the MCP 404 before auth, and Clerk no longer publishes per-pool protected-resource metadata. Maintainers receive the whole catalog and belong to no pool; every other person is listed in at most one pool, which plain `/mcp` serves them. Construction throws `ConfigError` on a maintainer in a pool's `members` or a person in two pools. `describeConfig().peopleInSeveralPools`, its construction warning and the `ambiguous_pool` log reason are removed; `describeConfig().pools[].path` and `OperatorPoolV2.humanPath`/`agentPath` now name where each pool's members connect, with `null` for the other kind. `connecta doctor --pool` accepts only agent tokens. Agents keep `/agent/<pool>` unchanged. See `documentation/plain-mcp-upgrade.md`.
