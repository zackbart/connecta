# Changelog

All notable changes to this package are documented here.

## 0.3.0 — 2026-07-24

### Added

- `ConnectorCallError` — a typed failure contract for `Connector.callTool`.
  Connectors can classify failures exactly (`timeout`, `auth_required`,
  `rate_limited`, `unavailable`, `invalid_args`, `connector_call_failed`) and
  set `retryable` explicitly, instead of the meta-tools regexing message text.
  Plain `Error`s keep the old heuristic as a fallback, so existing connectors
  are unaffected. `remoteMcp()` now converts the SDK's `UnauthorizedError`
  into a per-call `auth_required` error that names `authorize_connector`, so
  a token that expires between `status()` and `callTool` routes the agent to
  re-auth instead of a generic failure.
- `api()` validates call arguments against each tool's `inputSchema` (draft
  2020-12, using the existing `@cfworker/json-schema` dependency) before the
  handler runs. Mismatches fail closed as non-retryable `invalid_args` errors
  naming the offending locations. Opt out per connector with
  `validateArgs: false`. Remote MCP connectors deliberately stay
  pass-through — the downstream server is authoritative for its own schemas.
- `fileStorage(path, { logger })` — the corrupt-state-file recovery report now
  goes through the package's `Logger` seam instead of being hardwired to
  `console.error`.
- Workers runtime test suite: the vitest config now runs the suite under both
  Node and `workerd` (`@cloudflare/vitest-pool-workers`), so Workers-only
  regressions fail CI instead of surfacing in production. Two real
  `return await` bugs in the credential and sandbox paths were found and
  fixed by the new pool.
- The Docker example is now verified: CI builds `examples/docker/Dockerfile`
  and smoke-tests `/health` on every push.

### Fixed

- A connector error whose legitimate message text merely mentioned "timeout"
  was misclassified as a retryable timeout and re-run (and recorded as
  outcome "timeout" in activity). Typed errors are now authoritative for
  classification wherever they pass through `call_tool`, `batch_call`, and
  `execute_code` host calls.

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
