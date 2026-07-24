# Changelog

All notable changes to this package are documented here.

## 0.2.1 — 2026-07-24

### Added

- `serverInfo` now passes `title`, `websiteUrl`, and `icons` (MCP icons spec)
  through to the initialize response, so icon-aware clients (claude.ai)
  render the declared mark and human-readable name instead of a scraped
  domain favicon.

## 0.2.0 — 2026-07-24

### Breaking

- Trimmed internal factoring out of the root export: `CredentialVault`,
  `createMetaTools`, `buildSandboxProviders`, `createExecuteTool`, and
  `sanitizeIdentifier` are no longer exported, and `Registry` is now a
  type-only export (it is still reachable as `Connecta.registry`). Import from
  source paths if you were depending on any of them.

### Added

- `Connector.handleRequest(request, ctx)` — an optional seam for
  connector-owned public routes, e.g. a signed download link minted by one of
  the connector's tools. Dispatched only after every built-in route misses, so
  a connector can add a route but never shadow `/mcp`, `/ui`, `/health`, or the
  credential API, and inside the security-header wrapper that previously only
  covered connecta's own routes. Generalizes the `/oauth/callback/<id>`
  special case.
- Branding is now complete: `productUrl`, `pageTitle`, `themeColor`, and
  `favicon: { svg, ico, href }` join the existing labels, and the dashboard's
  remaining hardcoded "Connecta" strings now follow `productName`. A
  deployment can replace every operator-facing label and mark.
- `listen()` accepts an options object — `{ port, host, maxBodyBytes,
  gracefulShutdown, shutdownTimeoutMs }` — alongside the existing plain port.
  Graceful shutdown is on by default: SIGTERM/SIGINT stop accepting
  connections, let in-flight requests finish, drain deferred work, then exit.
- `CONNECTA_VERSION` is exported and is now the single source of the version
  reported by `/health` and by the downstream MCP client handshake. A test
  asserts it matches package.json.

### Fixed

- `fileStorage` no longer silently discards a corrupt state file. It moves the
  damaged bytes to `<path>.corrupt-<timestamp>`, logs loudly, and starts from
  empty — previously the next write persisted `{}` over irreplaceable
  downstream OAuth tokens and credential-vault entries. If the file cannot be
  moved aside, startup fails rather than overwriting it.
- The Node adapter streams response bodies instead of buffering them through
  `arrayBuffer()`, and caps request bodies at 10 MiB (413) instead of
  accumulating them without limit.
- Deferred work now settles on Node: `listen()` supplies a `waitUntil`
  equivalent and drains it on shutdown. The Workers example passes `ctx`
  through, so the `defer` path is exercised on both runtimes.
- The meta-tools carry their own MCP behavior annotations. Previously only
  `skills` and `call_destructive_tool` did, so hosts that gate on hints treated
  read-only meta-tools as potentially destructive — and a connecta aggregated
  behind another connecta would have been refused by its own fail-closed
  policy.
- `listen()`'s request handler logs the error it catches instead of returning a
  bare 500.
- The import-graph purity test now also rejects dynamic `import("node:…")`,
  which previously slipped past both of its patterns.
- Operator-supplied `branding.productName` is escaped for the `<script>`
  context it is inlined into, not just for HTML attributes.
- A mid-stream response failure destroys the connection instead of appending an
  error string to the partial body the client is already reading, and graceful
  shutdown closes idle keep-alive sockets rather than waiting out its own
  deadline on them.

## 0.1.1 — 2026-07-24

- Fix: `/health` is no longer 308-redirected to `publicUrl` when it is reached
  over plain HTTP. Container and orchestrator liveness probes hit loopback
  without `X-Forwarded-Proto`, so the redirect made an internal health check
  depend on external DNS, TLS, and any proxy in front of connecta — the shipped
  Docker `HEALTHCHECK` reported unhealthy for every HTTPS `PUBLIC_URL`
  deployment. All other routes still redirect.

## 0.1.0 — 2026-07-23

- Initial public package release.
- Generic API and remote MCP connector contracts.
- Nine fixed meta-tools with progressive tool discovery and approval boundaries.
- Optional sandboxed code mode for dependent read-only orchestration.
- Generic storage, activity, authentication, and credential-management seams.
- Node and Web-standard fetch runtimes.
- Optional Clerk authentication adapter.
