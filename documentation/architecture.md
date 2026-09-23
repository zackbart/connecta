# Architecture

One Web-standard `fetch(request) => Promise<Response>` handler, a long-lived
registry behind it, and a strict rule about what may be imported. Everything
else in this repository is a detail of those three things.

Read [`ethos.md`](../ethos.md) first; this guide says how the shape it describes
is assembled and where each subsystem lives. The surface itself belongs to
[meta-tools](./meta-tools.md), [code mode](./code-mode.md), and
[inbound auth](./auth.md).

## The two lifetimes

Almost every bug in this codebase is a lifetime mistake, so the split is worth
stating before anything else.

**Per isolate, built once.** `createConnecta(config)` returns
`{ fetch, registry, close }` (`src/index.ts`). The `Registry` owns the connector
set, address resolution, catalog caches, observed output schemas, connector
health, and the per-connector call limiters. It is built once and lives as long
as the isolate — on Workers a lazy module-scope singleton, which is why both
deployment shapes construct it outside the request handler.

An OAuth `remoteMcp()` connector also owns a runtime-local refresh completion
gate (`src/auth/downstream-oauth.ts`). It coordinates credential mutation across
concurrent request scopes while sharing no client, transport, or response, and
never lets a follower cancel the owner. The subtle part is that a valid token
response consumes the refresh token whether or not the owner survives to save it,
so the accepted tokens live on the flight: cancelling the owner *before* a valid
response fails the joiners, because promoting one could replay a token the
authorization server already consumed, while cancelling it *after* one does not —
the host persists the rotation on its own write, holds contenders behind a
generation-keyed pending-mutation marker until that write lands, and hands them
the saved rotation ([#526](https://github.com/zackbart/connecta/issues/526)).

**Per request, and no longer.** The MCP server, its transport, downstream MCP
clients, abort signals, and the connector scope a probe opens all belong to the
request that created them. `Nothing request-bound survives a request` is an ethos
invariant, not a style preference: a client retained across requests on Workers
is a cross-request capability leak, and a promise awaited after the response is
work the runtime may already have torn down. Deferred work has one sanctioned
channel, `ctx.waitUntil`, threaded through `fetch(request, env, ctx)` — activity
writes use it, as does a stale-window catalog refresh, which owns a fresh scope
and deadline rather than carrying the inbound one past the request. And a fresh
`McpServer` per request is what makes the deployment stateless: no sessions, no
server push, no stream resumability, scope resolved rather than remembered.

## Request lifecycle

`src/server.ts` is the composition root: MCP origin check, scheme upgrade, route
table, security headers. Route *order* is the contract — several routes would
behave differently if they were reachable in another order — so read the table
top to bottom.

| Order | Route | Notes |
| --- | --- | --- |
| 0 | MCP Origin check | A disallowed `Origin` on `/mcp*` is a fixed 403 before redirects, admission, auth, or preflight — costing no permit and no auth lookup. Originless requests are admitted. |
| 0 | HTTPS upgrade | 308 to an HTTPS `publicUrl`, with path and query *assigned* onto it rather than resolved against it, so a `//host` pathname cannot replace the origin. `/health` is exempt: a loopback probe must not need public DNS. |
| 0 | Cloudflare Access (Worker, when enabled) | Edge admission ahead of this table; an admitted invocation carries trusted identity in `ctx.access`. |
| 1 | Mounted UI routes | Before wildcard OPTIONS, so mutation routes refuse preflight rather than inheriting MCP CORS. No UI module, no routes. |
| 2 | MCP preflight | Allowed `OPTIONS` on `/mcp*`: 204 without admission or auth. |
| 2 | Other `OPTIONS` | Auth metadata first, otherwise compatibility CORS preflight. |
| 3 | `/.well-known/*` | Auth metadata, or 404. |
| 4 | `/health` | Open and payload-free: health, executor, admission, and deployment metadata, with drift as stable short hashes. |
| 5 | `/oauth/callback/<connectorId>` | Core downstream OAuth completion, state and personal-ownership checked, independent of the UI. |
| 6 | `/mcp`, `/mcp/<pool>` | Admission, then auth, then a request-local MCP server. An undeclared pool, a refusing grant, and a throwing grant are one identical 404; see [pools](./auth.md#pools). |
| 7 | Other paths | 404. Custom HTTP routes belong to the deployment. |

Every response leaves through `withSecurityHeaders`, and the UI module adds a
nonce-based script CSP and framing denial to its shells.
`test/server-route-contracts.test.ts` pins the ordering and the exact refusal
bodies; it exists because the ordering is invisible in any one file and a
reordering reads like a harmless refactor.

An admitted non-preflight `/mcp` request then takes five steps in
`src/routes/mcp.ts`:

1. **Admit.** One permit from the deployment-wide pool, taken before auth so an
   unauthenticated flood costs a permit rather than a Clerk lookup, and held
   until the response *body* completes, not until the handler returns.
2. **Authorize.** Each `InboundAuth` provider's `authorize` in order, bearer
   before interactive. First `ok` admits; if all fail, the last provider's
   challenge is returned. No providers means open — development only, and it
   warns at construction.
3. **Narrow to the pool.** On `/mcp/<pool>`, look the name up, run its grant
   against the identity, then `intersectAccess` the pool with the identity's own
   access. A pool can never widen a view; anything else is a 404 naming no pool.
4. **Derive the registry view.** One `registry.scoped(...)` call with those
   connector ids, exact `connector.tool` addresses when the identity declares a
   narrower slice, and the subject and principal keys. Personal connectors use
   the principal partition, result paging the subject partition, and no caller
   parameter selects either (`test/identity-scope.test.ts`).
5. **Serve.** Refuse `?toolkit=` with a 404 — the toolkits are gone
   ([#178](https://github.com/zackbart/connecta/issues/178)) but their URLs were
   handed out, and retiring a scoping boundary into fail-open is worse than any
   404 — then register the seven meta-tools on a fresh `McpServer`
   (`test/server.test.ts`, `test/code-first-surface.test.ts`).

## Layers below the meta-tools

The meta-tool handlers are thin. The work sits in five modules the registry owns
or hands out, and a change usually belongs in exactly one of them:

| Module | Owns |
| --- | --- |
| `src/registry.ts` | The connector set, identity-scoped views, personal storage partitions, address resolution, catalog TTL/persistence/completeness, refresh single-flight, connector health, per-connector call limiters, and drift. Construction-time refusals live here. |
| `src/catalog-service.ts` | Request-local listing, search, and describe. Caches catalogs inside one request, fans discovery probes out under deadlines, and opts agent reads into the runtime's deferred catalog channel when one exists. |
| `src/invocation.ts` | One tool call: argument validation, call admission, one-attempt timeout, provider retry hints, result unwrapping, size capping, and the activity record. |
| `src/catalog.ts` | Ranking, description summarizing, and the compact and TypeScript schema renderers discovery shows. |
| `src/result-shapes.ts` | Bounded runtime-only inference and merging for output shapes learned from successful read-only calls whose providers declared none. |

`src/meta-tools.ts` and `src/execute.ts` are two front doors onto the same two
services, `CatalogService` and `InvocationService`. That is the point: a
program's `connecta.call` and a top-level `call_tool` reach
`InvocationService.invoke` by different routes and get the same admission, the
same credential resolution, and the same fail-closed read-only check.
`test/execute.test.ts` asserts the parity directly, because a sandbox path that
quietly diverges is how generated code would mint a capability.

## Admission, in two places

Request admission (`src/executor-admission.ts`, applied in `src/routes/mcp.ts`)
bounds the MCP envelope: one deployment-wide FIFO pool, plus a deliberately
smaller code pool a program takes a *second* permit from, so one request cannot
trade ordinary capacity for unbounded sandboxes. `admission.code` is only a
fallback — an executor implementing `acquire()` owns a bounded pool already, its
settings win, and connecta warns the fallback was ignored. Invalid bounds throw
at construction, because a pool that quietly became unbounded is worse than a
deployment that refuses to boot. The queue is global FIFO across identities: a
capacity boundary, not tenant fairness, and one deployment serves one tenant.

Call admission (`src/call-admission.ts`) answers what the envelope cannot see —
a connector's optional policy over its own `Connector.callTool` attempts,
partitioned by an optional `partitionKey` and bounded by concurrency, a
rolling-window budget, or both. Exactly one rule is accepted, because several
cannot be faked as sequential leases: consuming a rolling token before a later
rule refuses would charge a call that never reached the provider, the exact
accounting error a budget exists to prevent. Both layers are pinned by
`test/request-admission.test.ts` and `test/call-admission.test.ts`.

## Storage, credentials, and connectors

`KVStorage` is `get`/`set`/`delete` with optional `list(prefix)`; core uses it for
connector state, catalogs, and result paging — a 15-minute TTL with one
runtime-wide accounting of stash bytes and entries, where a full stash returns the
successful call's preview and a paging-unavailable notice rather than a result id.
A second optional method, `compareAndSet(key, expected, next)`, is an atomic
claim: `null` means absent (expired counts) on the way in and delete on the way
out. Nothing in core requires it yet; a subsystem that needs an exactly-once
claim will require it explicitly rather than emulate it with a read and a write.
Adapters: `src/storage/memory.ts` and `src/storage/file.ts` (Node) both provide
it, and the namespaced views core hands connectors forward it only when the
underlying store has it. `examples/worker/` carries two more: Cloudflare KV,
eventually consistent and so declaring none, and a D1 store that provides it —
copyable reference source beside the D1 activity store, deliberately not an
importable subpath. The shared cases live in `test/storage-contract.ts`.

`src/credentials.ts` is the AES-GCM vault behind the root-exported
`CredentialVault` contract, selected through the `vault` slot. It binds connector
id and owner into the authenticated encryption context, because sharing a backend
is not permission to share a principal's credentials. Two rules carry the
subsystem: credentials never leave the host — read only through the owning
connector's `ctx.credential`, rendered by nothing, absent from activity and model
recovery — and they fail at use, proactive liveness probing having been removed by
decision. The vault is read per call, so a replacement needs no restart
(`test/credentials.test.ts`).

Connectors are the boundary between the fixed meta-tool surface and downstream
capability, and `api()`, `remoteMcp()`, and a hand-written `Connector`
(`src/connectors/`, plus the prebuilt connections under `src/providers/`) all
produce instances that take the same catalog, read-only, credential, storage,
invocation, result-size, and activity paths. Every one is deployment
configuration, never runtime registration. `authScope: "shared" | "personal"`
partitions connecta-owned context — state, credentials, OAuth, catalogs, observed
shapes — by principal, and *only* connecta-owned context: a secret a custom
handler closes over is shared JavaScript state, and `remoteMcp()` refuses the
literal-headers-plus-personal version of that mistake. Visibility
(`identity.connectorAccess`) is a separate rule; hiding a connector does not
change who owns its auth.

## Optional deployment modules

`createConnecta` takes closed typed `ui`, `vault`, and `activity` slots, with
factories at `/ui`, `/credentials`, and `/activity` and bearer auth at
`/auth/bearer`. Root exports the contracts, never the implementations, and there
is no module array, runtime registration, or plugin lifecycle. Core keeps
discovery, the executor contract, invocation, permissions, and OAuth callback
verification; an omitted module contributes no runtime work at all.

The operator UI — `src/ui.ts` (data-free shell and `/ui/data` payload),
`src/routes/ui.ts`, `src/operator-ui/` (the Preact app and its pure rules) —
shows a human what a deployment exposes and manages only the authentication
material code explicitly permitted; it never edits the connector set, catalog,
annotations, scopes, or permission rules. Two invariants shape it: a status read
never starts authorization, since OAuth begins with an explicit authorized POST,
and each lazy details request owns a bounded downstream scope, so one failing
provider leaves the other connections usable. A connector's status message
never reaches the page: it can quote a downstream error body, and that body can
quote the secret it rejected, so the details payload carries only a classified
`problem` — which picks fixed on-screen copy and a fixed fix prompt — and the raw
text goes to the server log. Credential handoff URLs exist only while the UI is
mounted; OAuth callbacks never need it.

Its appearance is one token layer. `src/operator-ui/browser.css` resolves every
color, radius, and font through a custom property and mixes the rest from those
with `color-mix`, so `branding.theme` only has to append a `:root` block after
that stylesheet. The five tokens it accepts are gated in `src/branding.ts`, each
by a narrow syntactic check: deployment config reaches a `<style>` element here,
and an unvalidated value would be CSS injection. The dark palette is the same
tokens under `prefers-color-scheme`; `colorScheme` pins one with a `data-scheme`
attribute on the page.

## Import-graph purity

Nothing reachable from `src/index.ts` may import a `node:` builtin, so the same
core runs unchanged in workerd and in Node. The Node-touching paths — `src/node.ts`
(the `node:http` adapter), `src/storage/file.ts`, and the QuickJS process pool
(`src/executors/quickjs.ts` plus its child) — each sit behind an explicit subpath
and must stay unreachable from the root. `./auth/clerk` is separate because
`@clerk/backend` is an optional peer rather than a dependency, and
`./auth/cloudflare-access` for a third reason: it is Web-API-pure, but its trust
contract is specific to a direct Worker invocation carrying `ctx.access`.

`test/purity.test.ts` walks the relative-import graph and fails on any `node:`
specifier in a reachable file, or on any of those modules — plus the UI bundle,
encrypted vault, and activity implementation — being reachable at all;
`test/package-surface.test.ts` and `scripts/check-package.mjs` guard the same
boundary in the published tarball. The failure mode is not theoretical: one
convenience import of `node:crypto` in a shared helper stops the whole Worker
shape from building, in someone else's repository rather than this one.

## Effect inside

Request admission, downstream call admission, deadlines, bounded settled
fan-out, connector scope close, OAuth refresh coordination, catalog
persistence, catalog refresh flights, the result stash, the remote MCP
connection lifecycle, discovery's request-scoped catalog cache, the
single-call invocation pipeline, and the `execute_code` run with its sandbox
host calls run on Effect v4; the rest of the core has not moved yet.
Every published signature stays Promise-shaped, so each
converted module is a shell and a core. The shell keeps its exported class or
function exactly as it was: same members, same errors, same `.d.ts`, private
member names included. The core is an Effect program behind it.
`AdmissionController.acquire()` runs the admission program and resolves with
the lease, or rejects with the same `ExecutorAdmissionError`. An Effect caller
skips the Promise and takes the program from `src/runtime/admission.ts`
(`admit`, or `acquireScoped` for a lease its Scope releases). Call admission
follows the same shape, kept a separate controller as #453 requires:
`ConnectorCallAdmissionController.acquire()` over `src/runtime/call-admission.ts`
(`admitCall`, `acquireCallScoped`), with the rolling window read from the
fiber's Clock. `closeConnectorScope` is the Promise face of `closeScope` in
`src/runtime/connector-scope.ts`, which an Effect caller registers as a Scope
finalizer (`closeScopeOnExit`). `withDeadline` is the Promise face of
`withDeadlineEffect`. `OAuthRefreshCoordinator.coordinatedFetch()` still
returns a plain `FetchLike`; inside, a refresh flight is a Deferred, and the
owning request's redemption is a fiber its abort interrupts. The registry's
persisted catalog (the manifest and its chunks: read, write, delete) and its
result stash are Effect programs over the `Storage` and `Logger` services,
run from the registry's unchanged methods. A catalog refresh flight is a
Deferred too: the request that publishes it runs the listing (a stale read's
refresh under `detach`, so under `waitUntil`, with its own deadline and a
connector scope closed as a Scope finalizer) and completes the flight after
that teardown; every other reader joins the outcome. Persisted-catalog writes
and deletes take turns per connector, in arrival order, each turn a Deferred
its own request completes once its storage work is done. Effect's `Semaphore`
is not used for that: a newcomer can take a released permit ahead of a
waiter that queued earlier, and the waiter is resumed from the releasing
fiber, which is the cross-request problem below. `remoteMcp()` keeps its
Promise-shaped `Connector`; inside, each request scope's state holds a Scope,
and each connection is a lease forked from it that closes the connection's
transport, bounded to a second for the session DELETE and a second for the
local close. A connect in flight is a Deferred that every caller in the scope
joins and that resolves with the client it connected, and `closeScope` closes
the Scope, which is the one-way latch a late connect checks. `CatalogService`
keeps its Promise methods; inside, each connector a request asks about is a
Deferred that the first asker's registry read completes and every later asker
joins, a success kept for the rest of the request and a failure dropped so the
next ask reads again. The read settles the Deferred itself, so a probe
deadline ends one asker's wait and never the read the others share. Search and
describe fan out over those catalogs with `Effect.forEach` under the
discovery concurrency, each probe under `withDeadlineEffect`, and settle every
slot with `Effect.result`; ranking and rendering stay synchronous.
`InvocationService.invoke` runs one call as one fiber: resolution,
the read-only and schema refusals, admission, and the one downstream attempt
sit under a single `withDeadlineEffect`, whose expiry interrupts the call
wherever it is instead of leaving it to finish in the background. The call
permit is an `acquireRelease` in the attempt's Scope, released on success,
failure, and interruption alike, and the connector call is an
`Effect.tryPromise` over the unchanged Promise `Connector`. Every outcome,
refusals included, is a value; the caller still records the activity event.
An `execute_code` run is one fiber too, and its Scope holds what the run
owns: the run's own signal and, from an admitting executor, the lease.
Closing it on every exit releases the lease and aborts the signal, so a
result, a thrown executor, the watchdog, and cancellation all end the same
way. The executor's `acquire()` and `execute()` stay Promises, each raced
against the signal (and a run against `execute.watchdogMs`), so connecta
stops waiting on a sandbox that does not settle; a lease that arrives after
its request gave up is released on arrival. Each guest host call is a fiber
of its own behind the provider function the executor awaits: spend the
budget, then a call yields the invocation pipeline directly while `search`
and `describe` race the run's signal, and a typed failure leaves through the
authenticated frame. The budget, the emit collector, and the frame itself
stay plain synchronous code.

Work shared across requests meets only through a Deferred that the owning
request completes, never through a fiber that outlives its request. Waiting
on one is its own edge. Deferred resumes a waiting fiber synchronously, inside
the call that completed it, which on Workers means inside the completing
request's I/O context: a waiter that goes on to touch its own request body or
transport there fails with workerd's "Cannot perform I/O on behalf of a
different request". So the wait runs through `runEdge`, and the waiter does
its own I/O after awaiting that promise, which workerd resumes in the
waiter's request as it does any promise resolved from another one. Call
admission is the busiest case: a permit is handed to a queued call from inside
the request that released one, so the invocation pipeline awaits
`registry.admitCall`'s promise rather than the controller's Effect program,
and the controller never reads a waiter's `AbortSignal` while handing it a
permit — on workerd, reading another request's signal throws. A waiter whose
signal aborts leaves the queue from its own listener, in its own request.
Executor admission is the same shape one level up: a queued `execute_code`
is handed its code slot by the request that finished, so the run awaits the
executor's `acquire()` promise and builds its providers only after it
resolves, back in its own request.

Each Connecta also gets a runtime of its own. `createConnecta` resolves
storage, the vault, activity history, the logger, and the rest of its
configuration once, and `src/runtime/services.ts` gives each a service key —
`Storage`, `Vault`, `ActivityRecorder`, `Logger`, `ResolvedConfig` — behind a
runtime keyed by the root registry (`coreRuntime`). An omitted activity module
is a recorder that records nothing, so it does no work there either; the
per-request `DeferredWork` hook is provided by the request, never the runtime.
Creating the runtime builds nothing, because a Worker may construct its
Connecta at global scope; the first run that needs the services builds them,
and `close()` disposes the runtime last. The shells stay constructible from
plain arguments, as the tests build them.

The registry's programs do not run on that runtime. A personal registry's
storage is the root's namespaced to its principal, so the runtime's `Storage`
would be another partition's; each registry instead provides its own storage
and logger to the programs it runs (`runOnPartition` in
`src/runtime/storage.ts`). For the root registry those are the same two
objects the runtime holds. A scoped view has no storage of its own and reaches
it through the registry it delegates to, and the result stash is always the
root's, because its capacity is runtime-wide.

`src/runtime/run.ts` is the only place a fiber starts, and
`test/purity.test.ts` fails if any other file calls `Effect.run*`, `runFork`,
`forkDaemon`, or `ManagedRuntime.make`. Its `runEdge` does three things the
stock runner does not:

- It rethrows the original failure or defect, never a wrapper, because callers
  check `instanceof`, `name`, and `message` on connecta's error classes.
- It turns an interrupt into the caller's `signal.reason` rather than
  Effect's generic interruption error.
- It runs every fiber on a scheduler that yields through microtasks. Effect's
  default scheduler yields through `setImmediate`, which vitest's fake timers
  freeze and Workers never had. The price is that a fiber never yields to
  I/O, so CPU-heavy work stays out of Effect loops.

`npm run check:declarations` fails if any shipped declaration names an Effect
type. `npm run check:bundle` records what the core costs per entry against
`scripts/bundle-budget.json`.

## Where else to look

Beyond the modules already named:

```
src/
  server.ts           route ordering, HTTPS upgrade, security wrapper
  routes/             one file per surface; shared.ts holds the auth gate
  skills.ts           MCP instructions, the usage skill, connector guides
  catalog-drift.ts    vetted manifests and the counts a refresh produces
  activity.ts         optional history factory and best-effort recorder
  auth/               bearer, Cloudflare Access, clerk (optional peer), downstream OAuth
  executors/          the QuickJS pool and child (Node only)
  node.ts             listen() + fileStorage re-export (Node only)
```

There are exactly two deployment shapes — `templates/node/`, which
`connecta init` copies with its container files, and `examples/worker/` — and
`test/deployment-shapes.test.ts` with `npm run check:examples` keeps both
compiling and configuring the real thing.

## Sharp edges

- **The root registry is shared; identity views are partitioned.** Shared
  connector caches are visible to later requests in the isolate; personal
  connectors use a bounded principal registry and transient results the
  authenticated subject. Putting a downstream client or credential on the wrong
  side of those lines is the highest-severity mistake available here.
- **Route order is behavior.** Moving a mutation route below the wildcard
  `OPTIONS` opts it into CORS preflight; reordering admission after auth makes
  the cheapest possible attack the most expensive request.
- **`close()` is idempotent and ordered.** Both admission pools, then the
  connector limiters, then the executor, then the Connecta's runtime; Node's `listen()` calls it on
  SIGTERM/SIGINT.
- **Structural mistakes throw at construction.** A duplicate connector id, an
  invalid admission rule, the removed `accessTokens` option, a missing executor:
  all refuse to boot (`test/config.test.ts`, `test/registry.test.ts`). Starting
  in the wrong shape is worse than not starting.
