# Architecture

One Web-standard `fetch(request) => Promise<Response>` handler, a long-lived
registry behind it, and a strict rule about what may be imported. Everything
else in this repository is a detail of those three things.

Read [`ethos.md`](../ethos.md) first. This guide says how the shape it
describes is actually assembled, and where a change is likely to break it.

## The two lifetimes

Almost every bug in this codebase is a lifetime mistake, so the split is worth
stating before anything else.

**Per isolate, built once.** `createConnecta(config)` returns
`{ fetch, registry, close }`. The `Registry` owns the connector set, address
resolution, catalog caches, connector health, and the per-connector call
limiters. It is constructed once and lives as long as the isolate or process —
on Workers that means a lazy module-scope singleton, which is why both
deployment shapes build it outside the request handler.

**Per request, and no longer.** The MCP server, its transport, downstream MCP
clients, abort signals, and the connector scope a probe opens all belong to the
request that created them. `Nothing request-bound survives a request` is an
ethos invariant, not a style preference: a client retained across requests on
Workers is a cross-request capability leak, and a promise awaited after the
response is work the runtime may have already torn down. Deferred work has one
sanctioned channel — `ctx.waitUntil`, threaded through `fetch(request, env,
ctx)` and used for best-effort activity writes.

The registry is deliberately on the long side of that line and the MCP server
deliberately on the short side. A fresh `McpServer` per request is what makes
the deployment stateless: no sessions, no server push, no resumability, and
scope resolved from the request rather than remembered.

## Request lifecycle

`src/server.ts` is the composition root. It does three things in order: upgrade
the scheme when it must, run the route table, then wrap whatever came back in
security headers. Route *order* is the contract — several routes would behave
differently if they were reachable in another order — so the table below is
read top to bottom.

| Order | Route | Notes |
| --- | --- | --- |
| 0 | HTTPS upgrade | 308 to `publicUrl` when it is HTTPS and the request arrived over HTTP. Path and query are *assigned* onto the configured URL, never resolved against it, so a `//host` pathname cannot replace the deployment origin. `/health` is exempt: a loopback container probe must not depend on public DNS and TLS. `/ui` is canonicalized to `/` while upgrading. |
| 1 | `/ui/access-tokens[/<id>]`, `/ui/credentials/<id>[/<action>]`, `/ui/oauth/<id>` | Private mutation routes, matched **first** so nothing can shadow them and so they own their own `OPTIONS` — they answer it with a refusal rather than inheriting the wildcard CORS preflight. |
| 2 | `OPTIONS` | Each auth provider's `handleMetadata` gets a chance (CORS preflight for browser MCP clients); otherwise 204 with MCP CORS. |
| 3 | `/.well-known/*` | Auth providers' `handleMetadata`, open. 404 when none handles it. |
| 4 | `/health` | Open JSON: status, connector count, `serverInfo`, the configured executor's sanitized name when it has one, catalog-drift counts, admission snapshots, reserved route names, and `deployment` when `deploymentInfo` is set. Payload-free by construction, and it never joins the MCP queue. |
| 5 | `/oauth/callback/<connectorId>` | Downstream-OAuth completion, open, `verifyState` before `finishAuth`. |
| 6 | `/favicon.*`, `/ui` → `/`, the operator shells, `/ui/data` | The operator surface ([operator UI](./operator-ui.md)). The shells are open and data-free; `/ui/data` behind them is gated. Built-ins are matched before connector routes, so a connector cannot shadow a page. |
| 7 | `/ui/activity` | Gated, plus the optional `activity.readGate`. `GET` only; 404 with no `activity.store.list`. |
| 8 | `/mcp` | **Admission before auth**, then the auth gate, then a fresh MCP server. |
| 9 | connector `handleRequest` | Registration order, open. Dispatched only after every built-in misses, so a connector can *add* a route and never shadow one of connecta's. First non-null response wins; a throw is a 500, not a fall-through. |
| 10 | — | 404. |

Every response leaves through `withSecurityHeaders`: `nosniff`, a no-referrer
policy, HSTS on HTTPS, and — on the operator shells — a nonce-based script CSP
and framing denial. `test/server-route-contracts.test.ts` pins this ordering
and the exact refusal bodies; it exists because the ordering is invisible in
any one file and a reordering reads like a harmless refactor.

`/mcp` itself is four steps, in this order and for these reasons:

1. **Admit.** One permit from the deployment-wide FIFO pool, taken before auth
   so an unauthenticated flood costs a permit rather than a Clerk lookup
   ([request admission](./request-admission.md)). The permit is held until the
   response *body* completes, not until the handler returns.
2. **Authorize.** Each `InboundAuth` provider's `authorize` in order, bearer
   before Clerk. First `ok` admits; if all fail, the last provider's challenge
   response is returned. No providers configured means open — development
   only, and it warns at construction.
3. **Refuse `?toolkit=`.** Toolkits were removed ([#178](https://github.com/zackbart/connecta/issues/178))
   but the URLs naming them were handed out, so the parameter is a 404 rather
   than silently serving the full registry. Retiring a scoping boundary into
   fail-open is the one outcome worse than the 404.
4. **Serve.** A fresh `McpServer` per request, the seven meta-tools registered
   against the registry, the Apps shell resource registered (and
   `resources/list` deliberately answering with nothing), and the response
   handed back.

## Layers below the meta-tools

The meta-tool handlers are thin. The work sits in four services the registry
owns or hands out, and a change usually belongs in exactly one of them:

| Module | Owns |
| --- | --- |
| `src/registry.ts` | The connector set, id validation, address resolution, connector health, per-connector call limiters, and the drift snapshot. Construction-time refusal of structural mistakes lives here. |
| `src/catalog-service.ts` | Tool listing: cold-load coalescing, TTL, persistence as manifest plus revision-addressed chunks, stale fallback, and the completeness rule — a partial catalog is a failure, never a cache write. |
| `src/invocation.ts` | One tool call: argument validation, call admission, per-attempt timeout, retry with the connector's own `Retry-After` honoured exactly or declined, result unwrapping, size capping, and the activity record. |
| `src/catalog.ts` | Ranking, description summarizing, and the compact schema renderer discovery shows. |

`src/meta-tools.ts` and `src/execute.ts` are two front doors onto the same
three services. That is the point: a program's `connecta.call` and a top-level
`call_tool` reach `InvocationService.invoke` by different routes and get the
same admission, the same credential resolution, and the same fail-closed
read-only check. `test/execute.test.ts` asserts that parity directly, because
the alternative — a sandbox path that quietly diverges — is how generated code
would mint a capability.

## Import-graph purity

Nothing reachable from `src/index.ts` may import a `node:` builtin. The core is
Web-API only so the same code runs unchanged in workerd and in Node.

The Node-touching paths are `src/node.ts` (the `node:http` adapter),
`src/storage/file.ts`, and the QuickJS process pool
(`src/executors/quickjs.ts` and its child entry). Each lives behind an explicit
subpath export — `@zackbart/connecta/node`, `@zackbart/connecta/quickjs` — and
must stay unreachable from the root entry. The optional Clerk adapter is behind
`./auth/clerk` for the adjacent reason: `@clerk/backend` is an optional peer,
not a dependency.

`test/purity.test.ts` walks the relative-import graph from `src/index.ts` and
fails on (a) any `node:` specifier in a reachable file and (b) the Node
adapter, file storage, QuickJS parent or child, or the Clerk adapter being
reachable at all. `test/package-surface.test.ts` and
`scripts/check-package.mjs` guard the other half — that the published tarball
matches the same boundary.

The failure mode this prevents is not theoretical: a single convenience import
of `node:crypto` in a shared helper makes the whole Worker deployment shape
stop building, and it will do so in someone else's repository rather than
this one.

## Where things live

```
src/
  index.ts            createConnecta + the public re-exports (Workers-clean)
  server.ts           route ordering, HTTPS upgrade, security wrapper
  routes/             one file per surface; shared.ts holds the auth gate
  meta-tools.ts       the six non-execute meta-tools over the registry
  execute.ts          execute_code, the sandbox host bridge, emit and ui
  apps-shell.ts       the one build-time MCP Apps template
  skills.ts           MCP instructions, the usage skill, connector guides
  registry.ts         connector set, addresses, health, call limiters
  catalog-service.ts  catalog loading, caching, persistence, stale fallback
  catalog.ts          ranking, summaries, compact schema rendering
  invocation.ts       one tool call, end to end
  catalog-drift.ts    vetted manifests and the counts a refresh produces
  credentials.ts      the AES-GCM connector vault over KVStorage
  access-tokens.ts    operator-issued MCP bearer tokens
  activity.ts         payload-free event contracts + best-effort recorder
  call-admission.ts   connector-partitioned downstream permits and budgets
  executor-admission.ts  the portable bounded queue both pools use
  ui.ts               the served operator shell and /ui/data payload
  operator-ui/        the Preact app, its pure rules, and the built bundle
  connectors/         remote-mcp.ts, api.ts, guarded-fetch.ts
  providers/          the maintained prebuilt connections
  auth/               bearer, clerk (optional peer), downstream OAuth
  executors/          the QuickJS pool and child (Node only)
  storage/            memory.ts, file.ts (Node only)
  node.ts             listen() + fileStorage re-export (Node only)
```

## Sharp edges

- **The registry is shared; the request is not.** Anything you cache on the
  registry is visible to every later request in that isolate. Anything you
  cache per request dies with it. Putting a downstream client on the wrong side
  of that line is the highest-severity mistake available here.
- **Route order is behavior.** Moving a built-in below the connector dispatch
  hands a connector the ability to shadow it. Moving a mutation route below the
  wildcard `OPTIONS` opts it into CORS preflight.
- **Admission runs before auth, on purpose.** Reordering them to "authenticate
  first" makes the cheapest possible attack the most expensive request.
- **`close()` is idempotent and ordered.** It closes both admission pools and
  the connector limiters, then the executor. Node's `listen()` calls it on
  SIGTERM/SIGINT.
- **Structural mistakes throw at construction.** A duplicate connector id, an
  invalid admission rule, `accessTokens` without a Clerk provider, a missing
  executor: all refuse to boot. A deployment that starts in the wrong shape is
  worse than one that does not start.

## Tests that enforce this

| Invariant | Suite |
| --- | --- |
| The core imports no `node:` builtin and reaches no Node-only module | `test/purity.test.ts` |
| The published surface matches the same boundary | `test/package-surface.test.ts`, `scripts/check-package.mjs` |
| Route order, per-route auth, and byte-exact refusals | `test/server-route-contracts.test.ts` |
| `/mcp` end to end, the open routes, exactly seven tools | `test/server.test.ts`, `test/code-first-surface.test.ts` |
| Construction-time refusals and the grouped config boundary | `test/config.test.ts`, `test/registry.test.ts` |
| Program and top-level calls take the same enforced path | `test/execute.test.ts` |
| Both deployment shapes still compile and configure the real thing | `test/deployment-shapes.test.ts`, `npm run check:examples` |
