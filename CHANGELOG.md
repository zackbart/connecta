# Changelog

All notable changes to this package are documented here.

## 0.5.0 — 2026-07-26

A feature release. Toolkits, per-connector usage guides, and per-connector
result caps are the substance; a paging fix, a docs coherence pass, and a
cleared audit advisory round it out. Nothing here is breaking, and a deployment
that declares none of the new options keeps its 0.4.1 *runtime* behavior on
every path that matters: an unscoped connection still sees the whole registry,
a zero-guide catalog gains no discovery text, and an unset cap truncates where
it always did. One narrow exception — a request carrying `?toolkit=` against a
deployment that configures no toolkits is now a 404, where 0.4.1 never read the
parameter and served the request; no 0.4.1 client had reason to send it. Three
textual changes are unconditional and reach every deployment, so anything that
snapshots them will diff: the `get_result` tool description now documents the
accepted `maxBytes` range, its `maxBytes` JSON Schema tightens from
`exclusiveMinimum: 0` to `minimum: 1`, and the matching validation error
message is reworded. The next intentional breaking release stays reserved for
issue #28.

### Added

- **Toolkits — named scoped views over one deployment's registry.** A connecta
  deployment belongs to an org; a toolkit is the slice one team group sees.
  Operators declare them in the new `ConnectaConfig.toolkits` (`{ support: {
  connectors: [...], includeTools?, excludeTools? } }`, with per-tool address
  grain; `ToolkitConfig` and `ToolkitDefinition` are exported), and a client
  selects one with `?toolkit=<name>` on the MCP URL. The boundary is a single
  enforcement point: a `ScopedRegistry` built once per HTTP request — the
  transport is stateless, so there is no longer-lived connection to hang it on
  — with every meta-tool and the `execute_code` sandbox bridge typed against a
  narrow `RegistryView` rather than the full `Registry`, so reaching for an
  unfiltered method is a compile error instead of a silent leak. All nine
  meta-tools are scoped; an out-of-scope address fails byte-identically to a
  nonexistent one; `get_result` stashes are namespaced per toolkit so a scoped
  session cannot page out a sibling's results; and health observations are
  per-toolkit so one scope's `lastError` never names another's tools. A
  monotonic has-ever-succeeded flag is the one deployment-wide *observation* a
  scoped view can read back, so scoped sessions don't misreport live remote
  connectors as `unknown`. Plenty of other state is shared by design and is not
  scoped at all — the tool-catalog cache, and, worth saying out loud, the
  `conn:<id>:` storage namespace and the credential vault: **a downstream OAuth
  token obtained under one toolkit is usable from another.** `/ui`, `/health`,
  and the OAuth pages stay unscoped operator surfaces. **Selection is
  self-service: any caller who can reach the endpoint may name any toolkit, or
  omit the parameter and see the whole registry.** A toolkit scopes visibility,
  not identity — binding a team member to a toolkit belongs in `auth`, and
  enforcing that binding is a deliberate follow-up (issue #37). Until it lands,
  treat toolkits as an ergonomics and context-budget feature rather than access
  control; connecta warns at startup when toolkits are configured without
  inbound `auth`. `InboundAuth.authorize` already receives the full request, so
  an adapter can refuse a mismatched `?toolkit=` today.
- **Per-connector usage guides, served by the existing `skills` meta-tool.** A
  connector declaration can carry `usageGuide` — agent-facing markdown,
  config-as-code, and a new pass-through option on both `ApiOptions` and
  `RemoteMcpOptions`. `skills({})` then lists the built-in `usage` guide
  alongside one summarized entry per guided connector, with `skills({ name:
  "connector:<id>" })` returning the guide verbatim. Collision with a built-in
  skill name is structurally impossible because the built-in names are bare
  identifiers that never contain `:`, so no `connector:<id>` can ever match one
  — not even when a connector's id is literally `usage`. The prefixed form is
  also the only way to reach a guide: a bare connector id is never resolved,
  and errors with a pointer to the prefixed name rather than shadowing
  anything. Discovery is conditional: the extra `usage` section and the `guide`
  hints on `search_tools`/`describe_tools`/`skills` appear only once some
  connector declares a guide, so a zero-guide deployment's catalog is
  byte-identical to before — with one exception: the `skills({ name })` error
  wording for connector-shaped names. Those branches are gated on the name
  matching a connector id, not on any guide existing, so asking for a bare
  connector id now reports that the connector has no usage guide where 0.4.1
  said `Unknown skill`, and `connector:<unknown>` reports an unknown connector.
  Guides follow the connection's toolkit scope — a scoped session sees only
  in-scope guides.
- **Per-connector `maxResultBytes` override.** The inline-result byte cap now
  resolves per call as connector value → global `ConnectaConfig.maxResultBytes`
  → the built-in 50 000 default, so a connector that habitually returns large
  payloads can be capped without shrinking everything else. It is a new
  `maxResultBytes` field on the `Connector` interface with pass-through options
  on both `ApiOptions` and `RemoteMcpOptions`. Resolution happens after address
  resolution inside the call path, so `call_tool`, `call_destructive_tool`, and
  each leg of a `batch_call` use their own connector's cap. `get_result`'s
  default page size deliberately stays on the global cap — a stashed result
  carries no connector identity — and `execute_code` host-call results never
  flowed through this truncation path at all (they have a separate guard on the
  final sandbox return), so they're unaffected. A toolkit can neither raise nor
  lower a cap.
- **`ToolCallActivityEvent.toolkitId`** — an optional field on the exported
  activity event, set to the toolkit a call arrived through and absent on
  unscoped calls. Every custom `ActivityStore` now receives it, so a sink that
  persists into a typed or column-bound schema needs a migration to keep the
  value rather than drop it on the floor; sinks that pass the event through
  untouched need no change.

### Fixed

- **`maxResultBytes` is validated at all three intake points, and `get_result`
  paging can never fail to advance** (issue #32). The cap is now a whole number
  of bytes >= 1, enforced from one shared definition. An unusable operator
  value (zero, negative, `NaN`, non-integer, `Infinity`) emits a startup
  warning through the existing insensible-config channel — naming the connector
  for a per-connector override, and quoting the exact value the runtime falls
  back to — instead of silently misbehaving: previously `0`/`NaN` served a
  0-byte head, and a *negative* cap served a **larger** head than the default
  (`Uint8Array.slice` counts from the end) while still claiming truncation. A
  bad `get_result` `maxBytes` argument is now an ordinary input-validation
  error. On top of intake validation, `alignEndToCharBoundary` widens any
  window that would yield no bytes, so a page inside the payload always
  advances; the end of the payload is handled separately, by only reporting a
  `nextOffset` while the window stops short of the total. Between them, paging
  terminates whatever effective page size reaches it. Worth recording so the
  issue isn't closed on a false premise: the *client*-triggerable hang the
  issue suspected was confirmed never reachable — the wire schema already
  rejected non-positive `maxBytes` before dispatch, verified empirically
  against the previous release. The hang was real but operator-triggered only;
  the in-handler check is defense in depth for in-process callers. Valid values
  behave byte-identically to 0.4.1.
- **Documentation coherence pass across README, `docs/`, and `examples/`.** The
  changes above each documented themselves; nobody had reconciled the set.
  Fixed: a TOC link to an anchor that never existed, a toolkits section that
  opened by calling a toolkit "an access boundary" in direct contradiction of
  the "what toolkits are *not*" text below it, a `ConnectaConfig` table missing
  `toolkits` and `probeTimeoutMs`, design.md's silence on guides and toolkits,
  and a `serveMcp` misattribution of where the scope is actually built.
  **Operators running the worker example should note a schema migration**: its
  `ActivityStore` dropped `toolkitId`, the field that shows which team's view a
  call came through. The example now binds and reads back a `toolkit_id`
  column, and its README carries an `ALTER TABLE` note for pre-existing D1
  tables — without it, every insert fails with `no such column`, and because
  activity writes are best-effort the failure is invisible to the caller (it
  surfaces only as a warning per write in the operator log) while the activity
  table stops filling.

### Security

- **`branding.favicon.href` is now scheme-gated**, completing the branding-URL
  invariant begun in 0.4.1 (issue #29). All three branding URLs are validated
  in one resolver shared by both HTML surfaces (`/ui` and the OAuth result
  pages). A favicon href must be an absolute http(s) URL or a genuinely
  root-relative path — enforced structurally, after stripping the tab/LF/CR
  characters URL parsers ignore, with an origin comparison kept as defense in
  depth. Root-relative only, because `/ui` and `/oauth/callback/<id>` sit at
  different depths and a document-relative path would resolve differently on
  each. A rejected value falls back silently to the default `/favicon.svg` and
  is named in a startup warning — which also names a dropped `productUrl` or
  `ownerUrl`, so a deployment that has been quietly carrying one of those since
  0.4.1 will start seeing a warning line it did not see before.
  `resolveBranding` also reads every field through a string guard, so malformed
  branding from an untyped JavaScript caller degrades to defaults instead of
  throwing at construction.
- **GHSA-frvp-7c67-39w9 cleared, and `check:security` tightened from `high` to
  `moderate`.** The advisory (a Windows-only path traversal in
  `@hono/node-server`'s `serve-static`) is resolved by a root `overrides` entry
  pinning `@hono/node-server@^2.0.12`. No *declared* dependency version changes
  — the MCP SDK stays where it was — though the override does of course move
  the resolved transitive package across a major, 1.19.14 to 2.0.12. The
  planned SDK bump could not work: every SDK release from 1.25.0 onward pins a
  `@hono/node-server@^1.19.x` range that can never resolve to the patched 2.x
  line, and it is those same releases that pull the package in at all. This is
  audit-noise remediation rather than live vulnerability remediation — a
  module-graph trace from every SDK entrypoint connecta uses found no reachable
  `@hono/node-server` import, and the vulnerable `serve-static` subpath is
  imported by nothing in the tree — which is what makes the forced major safe.
  The old `high` gate caught high and critical findings correctly, but by
  construction could never surface this moderate one; `SECURITY.md` is updated
  to match, having still recorded the advisory as an accepted open finding
  under the old threshold. **Residual, stated plainly:** npm applies
  `overrides` only at the root project, so consumers who install this package
  still resolve the `1.19.x` range and will keep seeing the advisory in their
  own audits until the SDK moves to `@hono/node-server@^2`. Tracked as issue
  #40, which also retires the override.

## 0.4.1 — 2026-07-25

A security-hardening release from a full audit of the codebase. Every change is
backward-compatible: new safety that could alter behavior is opt-in or a
generous default, and existing well-behaved deployments are unaffected. No
sandbox-escape, RCE, or XSS was found; the items below are the real gaps.

### Security

- **QuickJS sandbox log memory is now bounded.** `execute_code`'s `console.log`
  capped only the *number* of retained entries (200), not their size, so
  untrusted guest code — the sandbox's explicit threat model — could
  `console.log("x".repeat(25_000_000))` two hundred times and retain multiple
  GB of host memory, OOMing the Node process. Each entry is now truncated to 8k
  chars and the cumulative buffer to 256k, both at capture time. Small logs are
  byte-for-byte unchanged.

- **The `fileStorage` state file is now owner-only.** It holds downstream OAuth
  access/refresh tokens in cleartext on the Node backend and was written with
  no mode (world-readable `0644`), so any local user could read long-lived
  tokens. The directory is now `0700`, the temp file `0600` (the atomic rename
  preserves it), and an existing loose-mode file is repaired to `0600` on load.
  Repair is best-effort so a non-POSIX filesystem can't block startup.

- **Cleartext-credential and destination guard on `remoteMcp`.** Static
  `headers` credentials were attached with no scheme check, so an `http://`
  `url` sent bearer tokens / API keys in cleartext. `remoteMcp` now warns at
  construction when headers-auth targets a non-https, non-loopback URL, and a
  new opt-in `requireHttps` makes that a hard error. A `NOTE` documents the
  residual redirect-following SSRF in the SDK's fetch transport (a malicious
  downstream could 3xx-redirect to an internal address); a full guard needs
  manual redirect handling in the SDK and is deferred to a non-patch release.

- **Construction-time warnings for insecure deployment shapes.**
  `createConnecta` now emits a one-time `logger.warn` when: no inbound `auth`
  is configured while credential/OAuth connectors are present (any caller
  reaches the credential vault — connecta's trust model is single-domain, so an
  open or open-signup deployment grants every caller full access); `publicUrl`
  is unset while OAuth connectors exist (the downstream `redirect_uri` is
  derived from the attacker-influenced inbound `Host` header — set `publicUrl`
  to a fixed https origin); or a connector exposes `finishAuth` but not
  `verifyState` (its `/oauth/callback` would exchange any delivered `code`).
  The shipped `remoteMcp` implements `verifyState`, so the last fires only for
  hand-rolled connectors. Full per-actor authorization remains an architectural
  change for a future release.

- **The discovery meta-tools no longer hang on a stuck downstream.**
  `list_connectors`, `search_tools`, and `describe_tools` fanned out live
  probes to every connector with no deadline, so one hung downstream stalled
  the whole call. Bounded by the new `probeTimeoutMs` (below); a timed-out
  connector degrades to an unavailable/errored entry. The bound is
  caller-facing — the registry takes no `AbortSignal` yet, so the underlying
  fetch is not cancelled; real cancellation is a documented follow-up.

- **`/ui` now ships a nonce-based script CSP.** The operator page carried no
  script-restricting CSP, so any future escaping regression would be directly
  exploitable. It now sends a per-request `script-src 'nonce-…' 'strict-dynamic'
  https: 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors
  'none'`. `'strict-dynamic'` keeps Clerk's runtime-injected scripts working;
  the `https:`/`'unsafe-inline'` fallbacks are ignored by modern browsers and
  only cover legacy ones; and no `default-src` is set so Clerk's network/fonts
  and the inline styles stay unrestricted. Operator `branding` `productUrl`/
  `ownerUrl` values are now scheme-gated (a `javascript:` URL is dropped rather
  than rendered as a link), and credential metadata omits `lastFour` for values
  shorter than 12 chars so a short secret doesn't leak half of itself.

### Added

- `RemoteMcpOptions.requireHttps` (default `false`) — reject a non-`https://`
  (non-loopback) `url` at construction, and `RemoteMcpOptions.logger` for the
  cleartext-credential warning.
- `ApiOptions.strictValidation` (default `false`) and
  `ValidateToolInputOptions.failClosed` (default `false`) — reject a call whose
  `inputSchema` the validator cannot evaluate instead of passing the raw
  arguments through. The default remains fail-open (a broken schema does not
  break an otherwise working tool); `api()` also now eagerly compiles each tool
  schema at construction so a bad one warns once at startup rather than
  silently on first use.
- `ConnectaConfig.probeTimeoutMs` (default `30_000`) — per-connector deadline
  for the `list_connectors`/`search_tools`/`describe_tools` fan-out. Generous
  by default so it trips only on a pathological hang; does not apply to
  `call_tool`/`batch_call`, which carry `defaultToolTimeoutMs`.

## 0.4.0 — 2026-07-25

### Added

- `ConnectorCallError` accepts `retryAfterMs` — the wait window a connector
  already knows (a `Retry-After` header, say) and until now had no way to
  report. It round-trips into the value-mode error envelope as
  `error.retryAfterMs` (and `errorDetails.retryAfterMs` in `batch_call`), so an
  agent that receives the failure can schedule a re-issue instead of guessing,
  and the engine's retry loop waits that long in place of its exponential
  guess. A reported window is honoured exactly or not at all: up to 10 s the
  engine waits it in full; beyond that it declines the retry and returns the
  failure immediately rather than retrying inside a rate-limit window it was
  told about. The reported value is never capped.
- `ConnectaConfig.defaultToolTimeoutMs` — a deadline for `call_tool`/
  `batch_call` calls that pass no `timeoutMs`, giving the connector both a
  budget (`ctx.timeoutMs`) and a cancellation signal (`ctx.signal`) on the
  common path, as `execute_code` host calls have always had. **Opt-in and unset
  by default**: switching it on globally would put a deadline on every call in
  every existing deployment, and the failure mode is a working long-running
  call starting to time out. An explicit per-call `timeoutMs` always wins.
- `validateToolInput(schema, args, { address, logger? })` — the argument
  validation `api()` performs, extracted to `src/validate.ts` and exported so
  connectors that implement the `Connector` interface directly can use it too.
  Previously enforcement lived inside `api()`, so a hand-rolled connector whose
  manifest declared `additionalProperties: false` had nothing enforcing it: an
  unknown argument key was silently dropped, an empty body went upstream, and a
  200 was reported back as a successful write. It **returns** the non-retryable
  `invalid_args` `ConnectorCallError` (or `null`) instead of throwing, so the
  connector owns the decision — its own error prose, or stripping a
  connector-wide convention argument the tool schema doesn't declare. `api()`
  now calls it; behaviour is unchanged (`test/api-connector.test.ts` is
  untouched).
- `@zackbart/connecta/json-schema` — re-exports `Validator` from
  `@cfworker/json-schema`. It was already a direct dependency but not public,
  so downstream build-time validation (a manifest generator asserting its own
  output) resolved it only through npm hoisting.

### Fixed

- `compactSchema` — the rendering behind `search_tools` and `describe_tools`,
  and for most models the only description of a tool they ever read — dropped
  `const` and did not handle `allOf`. A discriminated union, the standard shape
  for "one of these request bodies", therefore rendered as several textually
  identical branches with the field that selects them erased
  (`{ type: string, emoji: string } | { type: string, external: {…} }`), and a
  schema using `allOf` fell through to raw `JSON.stringify` — on a real
  connector that measured *longer* than the schema it was meant to compact.
  `const` now renders as a literal, so unions are self-documenting again, and
  `allOf` composes with the schema's own shape joined by `&` rather than
  replacing it: a sibling `properties`, `$ref`, `enum`, `const`, or `items` is
  no longer silently dropped, and an empty `allOf` beside real properties no
  longer erases the whole schema.
- An aborted call — including one the engine itself cancelled at its deadline —
  was classified `connector_call_failed`/`retryable: false`. An aborted `fetch`
  rejects with a `DOMException` named `AbortError` whose message matches
  neither classification regex. `classifyCallError` now checks the name before
  the message text and classifies it as a retryable `timeout`, so connectors
  that pass `ctx.signal` through no longer have to special-case it.

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
