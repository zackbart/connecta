# Remove built-in artifacts in 0.29

Date: 2026-10-08

The owner decided to remove built-in artifacts in 0.29.0. Connecta stays focused
on aggregating MCP servers and HTTP APIs; publishing belongs in dedicated
services. This supersedes the artifacts guidance in [0001](./0001-ethos-verdict-table.md).

The removal includes the `connecta/artifacts` subpath, configuration options,
operator pages, agent tools and guide, scheduled refresh, and related evals.
Existing artifact data in KV, D1, SQLite, or R2 is left untouched and ignored.
There is no migration or cleanup job. Deployments remove their import and
`artifacts:` configuration and may drop dedicated bindings or storage.

INV-1 through INV-13 remain general contracts and retain non-artifact tests.
No invariant is retired or renumbered. See [#709](https://github.com/zackbart/connecta/issues/709).
