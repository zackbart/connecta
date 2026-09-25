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
| 4 | `/health` | Open and payload-free: health, executor, whether resumable writes are on, admission, and deployment metadata, with drift as stable short hashes. |
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
   until the response *body* completes or the caller leaves, not until the
   handler returns.
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
   404 — then register the eight meta-tools on a fresh `McpServer`
   (`test/server.test.ts`, `test/code-first-surface.test.ts`).

## Layers below the meta-tools

The meta-tool handlers are thin. The work sits in six modules the registry owns
or hands out, and a change usually belongs in exactly one of them:

| Module | Owns |
| --- | --- |
| `src/registry.ts` | The connector set, identity-scoped views, personal storage partitions, address resolution, catalog TTL/persistence/completeness, refresh single-flight, connector health, per-connector call limiters, and drift. Construction-time refusals live here. |
| `src/catalog-service.ts` | Request-local listing, search, and describe. Caches catalogs inside one request, fans discovery probes out under deadlines, and opts agent reads into the runtime's deferred catalog channel when one exists. |
| `src/invocation.ts` | One tool call: argument validation, call admission, one-attempt timeout, provider retry hints, result unwrapping, size capping, and the activity record. |
| `src/catalog.ts` | Ranking, description summarizing, and the compact and TypeScript schema renderers discovery shows. |
| `src/result-shapes.ts` | Bounded runtime-only inference and merging for output shapes learned from successful read-only calls whose providers declared none. |
| `src/resumable.ts`, `src/run-journal.ts` | Resumable writes: a program's host-call numbering, the write gate that pauses it, the journal a paused run becomes, the replay `resume_execution` plays from it, and the claim and write-ahead marks that keep an approved write to at most one send. |

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
A second optional method, `compareAndSet(key, expected, next, options?)`, is an
atomic claim: `null` means absent (expired counts) on the way in and delete on
the way out. A successful write accepts the same optional `ttlSeconds` as
`set`. Resumable writes require it: of two `resume_execution` calls racing
for one paused run exactly one may win, and every write that run sends is
marked on its header first, so a read and a write standing in for the claim
could send an approved write twice. Omitted, `execute.resumableWrites` is on
exactly when the store has it, and asking for it over a store without it
refuses to construct. Downstream OAuth uses it where the store has it, so
resealing legacy plaintext and discarding a refused grant cannot overwrite a
consent that landed in between, and falls back to a read and a write where it
does not.
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
text goes to the server log. The OAuth and credential Test notices keep the
same rule: those routes answer a downstream's failure in fixed words (a Test
answers only `{ ok }`), log its text, and the page picks a sentence by outcome
without ever rendering what the server sent. Credential handoff URLs exist only while the UI is
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

The core runs on Effect v4; no API a deployment touches does. `createConnecta`,
`remoteMcp()`, `api()`, the `Connector` contract, and every shipped `.d.ts`
are Promise-shaped and name no Effect type, so a connector author never meets a
second async paradigm. The reason for the rewrite is the first section of this
guide: the bugs here are lifetime bugs, and Effect makes a lifetime a value —
a Scope that closes on every exit, an interrupt that reaches whatever a fiber
is waiting on, a Deferred that one party completes and any number join. The
conversion found and closed a dozen of them, each with a test that fails on the
code before it: permits and leases held after their caller left, waits with no
bound, and races between requests.

### Shell and core

Each converted module is a shell and a core. The shell keeps its exported class
or function exactly — same members, same error classes, same `.d.ts`, private
member names included, because TypeScript ships those too. The core is an
Effect program behind it. In a published class it lives in a `static` block,
the one place that can read private state without adding a member to the
declarations; elsewhere it lives in an unexported function or in
`src/runtime/`, which no `exports` target reaches. Errors keep their classes
(`ConnectorCallError`, `ExecutorAdmissionError`, `CallAdmissionError`) because
callers and tests check `instanceof`, `name`, and `message`.

Effect callers skip the Promise and take the program: `admit` and
`acquireScoped` for request admission (`src/runtime/admission.ts`), `admitCall`
and `acquireCallScoped` for call admission, `closeScope` and `closeScopeOnExit`
for a connector scope, `withDeadlineEffect` where Promise code has
`withDeadline`. The build prunes every declaration no `exports` target reaches,
and `npm run check:declarations` fails if what remains names an Effect type.

### One runner

`src/runtime/run.ts` is the only place a fiber starts, and
`test/purity.test.ts` fails if any other file calls `Effect.run*`, `runFork`,
`forkDaemon`, or `ManagedRuntime.make`. It exports two ways out:

- **`runEdge(effect, { signal, runtime? })`** runs an effect at a Promise
  boundary. It rethrows the original failure or defect, never a wrapper. It
  turns an interrupt into the caller's `signal.reason` rather than Effect's
  "All fibers interrupted without error". And it runs every fiber on a
  scheduler that yields through microtasks: Effect's default yields through
  `setImmediate`, which vitest's fake timers freeze and Workers never had. The
  price is that a fiber never yields to I/O, so CPU-heavy work stays out of
  Effect loops.
- **`detach(effect, ctx)`** is the only fire-and-forget, and it hands the work
  to `ctx.waitUntil` when there is one.

Beside them sit `withDeadlineEffect`, which aborts the operation's own signal
with the labelled timeout error *before* interrupting it, so work that honors
the signal sees the same reason the caller does, and `fromSignal`, which turns
an `AbortSignal` into a failure to race against. Nothing runs Effect at module
scope, where a Worker may not start work, and nothing logs through
`Effect.log`: logging goes through the configured `Logger`, which is what
honors `logger: "silent"`.

Each Connecta also gets a runtime of its own (`src/runtime/services.ts`):
`Storage`, `Vault`, `ActivityRecorder` (one that records nothing when the module
is omitted), `Logger`, and `ResolvedConfig`. Creating it builds nothing, since
a Worker constructs its Connecta at global scope; the first run that needs the
services builds them, and `close()` disposes the runtime last. Two things
deliberately do not run on it. The request pipeline runs on no runtime, so
`/health` and a closed deployment's 503 keep answering after `close()`. And a
registry provides its own storage and logger to its programs
(`runOnPartition` in `src/runtime/storage.ts`), because a personal registry's
storage is the root's namespaced to its principal and the runtime's `Storage`
would be another partition's.

### What runs on Effect

| Area | Shape |
| --- | --- |
| Requests (`src/server.ts`, `src/routes/mcp.ts`, `src/routes/oauth.ts`) | One fiber per `fetch`, tied to `request.signal`. An `/mcp` request's admission permit and every `McpServer` it builds live in a Scope the response carries out, closed when the body ends, fails, or is cancelled, when the signal aborts, or at once if the handler fails first. The OAuth callback is uninterruptible: a single-use code's exchange and catalog invalidation are one commitment. |
| Admission (`executor-admission.ts`, `call-admission.ts`) | Queued waiters are Deferreds settled by whoever removes them from the queue; a wait is one flat race of grant, Clock timeout, and signal. The uncontended path stays synchronous. Two controllers, as [#453](https://github.com/zackbart/connecta/issues/453) requires. |
| One tool call (`invocation.ts`) | One fiber: resolution, the read-only and schema refusals, admission, and the downstream attempt sit under a single `withDeadlineEffect`, whose expiry interrupts the call wherever it is. The permit is an `acquireRelease`; the connector call is `Effect.tryPromise` over the unchanged `Connector`. |
| `execute_code` (`execute.ts`) | One fiber whose Scope owns the run's signal and executor lease, so a result, a throw, the watchdog, and cancellation all release the lease and abort the signal the same way. The executor's `acquire()` and `execute()` stay Promises raced against the signal and `execute.watchdogMs`. Each guest host call is a fiber of its own. |
| Resumable writes (`resumable.ts`) | A play's stop is a Deferred its write gate completes, raced against the executor like the watchdog; the gate for call n awaits the decision Deferreds of every lower-numbered call; header writes are one compare-and-set at a time on a per-play turn. A paused run holds nothing request-bound — its journal is data, and the next play is a new request's. |
| Discovery (`catalog-service.ts`) | A request-scoped cache: one shared read per connector (`runtime/shared-read.ts`), settled by the read itself and carrying its own signal and the probe timeout whichever asker starts it. Each asker waits under its own deadline and signal, so one that times out or is cancelled fails alone, and the read is cancelled only once every asker has gone. Fan-out is `Effect.forEach` under the discovery concurrency. |
| Registry (`registry.ts`) | Catalog persistence and the result stash are programs over `Storage`. A refresh flight is a Deferred its publishing request completes, bounded by its owner's deadline (the default probe timeout when it has none); persisted-catalog writes take per-connector turns, each a Deferred its own request completes. Same-request loads share one read the way discovery's do. |
| Remote MCP (`connectors/remote-mcp.ts`) | Each request scope's state holds a Scope, each connection is a lease forked from it, and a connect in flight is a Deferred carrying the client it connected. Closing a session and the transport are each bounded to a second. |
| Downstream OAuth (`auth/downstream-oauth.ts`) | A refresh flight is a Deferred; the owner's redemption is a fiber its abort interrupts, and committing an answer that already exists is uninterruptible. |
| Operator and activity data (`routes/operator.ts`) | Each JSON route is one program run by `serveOperator` behind the Promise `handle()`. Reads run under the request's signal; writes do not, so a vault write or OAuth disconnect that started reaches its cache invalidation. |
| QuickJS pool (`executors/quickjs.ts`, Node only) | Each child is a scoped resource whose release sends SIGTERM, then SIGKILL after a second; crash respawn backoff is a `Schedule`. |

### What stays plain

- **Everything a deployment writes against.** The `Connector` contract,
  `api()`, the providers, custom connectors, storage adapters, and the vault
  are Promises. A connector is called with `Effect.tryPromise`, never asked to
  return an Effect.
- **Inbound authorization.** `authorize` in `src/routes/shared.ts` ships in
  the declarations and in the `./activity` bundle; converting it cost 32 KB
  gzip there for nothing a caller could see.
- **Pure synchronous code.** Ranking, schema rendering, classification,
  `validateToolInput`, the host-call budget, the emit collector, failure
  framing, and result shaping. The microtask scheduler never yields to I/O, so
  wrapping them would buy nothing and could starve a request.
- **The MCP edges.** `@modelcontextprotocol/server` upward and the SDK client
  downstream; Effect's own `McpServer` is not used.
- **The Node and browser leaves.** `node.ts`, `fileStorage`, the QuickJS
  child, runtime, and protocol, and the operator UI's browser app.

### Across requests

Work shared across requests meets only through a Deferred that the owning
request completes, never through a fiber that outlives its request. Two
workerd rules follow, and both have bitten.

**Waiting on a shared Deferred is its own edge.** Deferred resumes a waiting
fiber synchronously, inside the call that completed it, which on Workers means
inside the completing request's I/O context. A waiter that goes on to touch its
own body, transport, or storage there fails with "Cannot perform I/O on behalf
of a different request", or hangs until its deadline. So the wait runs through
`runEdge`, and the waiter does its own I/O after awaiting that promise, which
workerd resumes in the waiter's request as it does any promise resolved from
another. The same holds one level out for every queue: a queued call, a queued
`execute_code`, and a queued `/mcp` request are each handed their permit from
inside the request that released one, so each awaits the controller's
Promise-shaped `acquire` rather than yielding its Effect program, and does its
own work only once that promise resolves. Effect's `Semaphore` is not used
across requests for the same reason, and because a same-tick newcomer can take
a released permit ahead of a waiter that queued earlier.

**Never read another request's signal.** On workerd, reading `aborted` or
`reason`, or calling `abort()`, on a signal that belongs to another request
throws; adding and removing listeners does not. Code that runs from another
request's completion — a queue handing out a permit, `close()` — must not look
at a waiter's signal. A waiter whose signal aborts leaves the queue from its
own listener, in its own request.

One corollary is easy to break by tidying. Workerd cancels a request as hung
when its only pending work is waiting on another request and it has no timer or
I/O of its own. Connecta's deadline timers are what keep a waiting request
alive and bounded, so no wait may lose its timer.

**A shared flight has a lifetime of its own.** A catalog refresh flight runs in
its owner's request, under its owner's scope and signal, and lives only as long
as its owner's deadline. Past that the owner may have answered and gone, taking
its I/O with it on workerd, and a connector that ignores its abort signal would
otherwise hold every later reader on a flight nothing will ever settle. So each
joiner waits on its own timer, set to the flight's bound: when it fires, the
joiner abandons the flight and makes a fresh attempt, and a reader that arrives
after the bound starts one without joining. Joiners also leave when the owner
fails for a reason that was only its own, such as its cancellation, rather than
inheriting it. A flight's result enters the caches only while the flight is
current, checked at the same points as the catalog generation, so a stuck
listing that lands late is never cached or persisted and never overwrites the
fresh attempt's.

### Why not Schema or HttpApi

Both were measured and both lost. `effect` is imported through its barrel,
which defeats tree-shaking: the first conversion step measured about +20 ms
of Worker cold start for it, and that cost was accepted over deep imports at
every call site. The catch is that a module the barrel reaches is paid for in
full, however little of it is used. Effect Schema for config validation and the
meta-tool inputs came to about +62 KB gzip and +13 ms of cold start in the
root, for a validator no clearer than the hand-written `CONFIG_SCHEMA`; the
meta-tool inputs stay zod, which the MCP SDK bundles regardless. `HttpApi` for
the operator and activity routes cost about +100 KB gzip on `./ui` and +130 KB
on `./activity`, and matching the wire format meant opting out of most of what
it does: unowned paths fall through rather than 404, a wrong method is a JSON
405, and the content-type and size checks run before a body is read. The root
entry may import only `effect` itself (`test/purity.test.ts`); nothing in
`src/` uses `effect/unstable/*`, which would have to stay behind a subpath.

The core's cost is recorded rather than guessed. Against 0.24.4 the root entry
grew from 235,346 to 279,526 bytes gzip, the Worker example from 263,949 to
314,336, and each provider by about 36 KB, since each reaches Effect through
`remoteMcp()`; `npm run check:bundle` caps every entry against
`scripts/bundle-budget.json`. An install carries about 53 MB of `effect`, with
no dependencies of its own.

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
