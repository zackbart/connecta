# Architecture

## Contributor reference

This guide describes Connecta implementation and repository verification.
It is optional for deployment operators. Start with the
[operator task index](./README.md#operator-tasks) for package-local procedures.

One Web-standard `fetch(request) => Promise<Response>` handler, a long-lived
registry behind it, and a strict rule about what may be imported. Everything
else in this repository is a detail of those three things.

Read [PRINCIPLES.md](https://github.com/zackbart/connecta/blob/main/PRINCIPLES.md)
first; this guide explains the shape and where each subsystem lives. The surface itself belongs to
[meta-tools](./meta-tools.md), [code mode](./code-mode.md), and
[inbound auth](./auth.md).

## Task routes

[Agent index](./README.md) routes endpoint use, deployment, integration, and
repository maintenance. Read this guide when changing the core or checking an
implementation boundary. Use these sections for the affected subsystem.

| Change or question                      | Sections                                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Request handling, transport, cleanup    | [Two lifetimes](#the-two-lifetimes), [request lifecycle](#request-lifecycle), [admission](#admission-in-two-places)                           |
| Discovery, invocation, classification   | [Layers below meta-tools](#layers-below-the-meta-tools), [providers and classification](#providers-and-reviewed-classification)               |
| Storage, credentials, catalogs, paging  | [Storage and connectors](#storage-credentials-and-connectors), [errors and records](#errors-and-records)                                      |
| Config validation and optional features | [Configuration](#configuration), [modules](#optional-deployment-modules), [operator contract](./operator-ui.md#operator-data-contract)        |
| Imports, executors, or Effect           | [Purity](#import-graph-purity), [Effect](#effect-inside), [sharp edges](#sharp-edges)                                                         |
| Find code and deployment evidence       | [Source map](#where-else-to-look), [sharp edges](#sharp-edges), [repository policy](https://github.com/zackbart/connecta/blob/main/AGENTS.md) |

Source paths and test names in each section identify its implementation and
regression evidence. Recorded production probes and bundle measurements are
historical observations tied to their stated date or version, not current
benchmarks or proof that planned replacements have shipped.

## The two lifetimes

Almost every bug in this codebase is a lifetime mistake, so the split is worth
stating before anything else.

**Per isolate, built once.** `createConnecta(config)` returns
`{ fetch, registry, describeConfig, close }` (`src/index.ts`). The `Registry` owns the connector
set, address resolution, request-local catalog reads, observed output schemas, connector
health, and the per-connector call limiters. It is built once and lives as long
as the isolate — on Workers a lazy module-scope singleton, which is why both
deployment shapes construct it outside the request handler.

An OAuth connector, `remoteMcp()` or `api()` with a static grant, owns a
runtime-local refresh completion gate in `src/auth/downstream-oauth.ts`.
Joined scopes share the outcome while keeping their own request I/O and
cancellation. A shared-storage CAS lease prevents independent isolates from
redeeming the same refresh token concurrently. The holder commits an accepted
rotation to the grant by CAS before releasing waiters, even when the owner
cancels after dispatch. The HTTP exchange uses its own 20-second deadline,
detached from caller cancellation, and the runtime passes its completion and
commit to Workers `waitUntil`. Contenders read the committed tokens or typed
verdict. An unsent claim can be taken over after expiry. Dispatch uses a lease CAS
transition and a CAS of the token fingerprint into permanent spent storage
before sending. Fingerprint records have no TTL and carry outstanding,
ambiguous, or resolved state across Restart and Disconnect. Outstanding and
ambiguous fingerprints block every epoch. A resolved fingerprint can be sent
once in a later epoch only when its code exchange observed the resolved
storage write before completing. Holder liveness survives reset until
completion or expiry. Credential-bearing
token requests use manual fetch and bypass resource redirect handling. Every
3xx requires re-consent after a refresh and refuses a code exchange. The HTTP
deadline is 20 seconds. A sent request
whose 120-second storage-owned liveness record expired without a commit is
never retried and requires re-consent. Valid rotations retry their grant commit
up to 32 times without another HTTP request; exhausted commits and all dispatched
provider failures require re-consent. [Auth](./auth.md#refresh-failures) describes the lease and failure
contracts.

**Per request, and no longer.** The MCP server, its transport, downstream MCP
clients, abort signals, and the connector scope a probe opens all belong to the
request that created them. INV-7 requires this lifetime: a client retained
across requests on Workers is a cross-request capability leak, and a promise awaited after the response is
work the runtime may already have torn down. Deferred work has one sanctioned
channel, `ctx.waitUntil`, threaded through `fetch(request, env, ctx)` — activity
writes and dispatched OAuth grant commits use it. Catalog listing and SQL cache
publication finish in the requesting scope. A fresh
`McpServer` per request is what makes the deployment stateless: no sessions, no
server push, no stream resumability, scope resolved rather than remembered.

## Request lifecycle

`src/server.ts` is the composition root: MCP origin check, scheme upgrade, route
table, security headers. Route _order_ is the contract — several routes would
behave differently if they were reachable in another order — so read the table
top to bottom.

| Order | Route                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | MCP Origin check                                          | A disallowed `Origin` on `/mcp*` is a fixed 403 before redirects, admission, auth, or preflight — costing no permit and no auth lookup. Originless requests are admitted.                                                                                                                                                                                                                                                            |
| 0     | HTTPS upgrade                                             | 308 to an HTTPS `publicUrl`, with path and query _assigned_ onto it rather than resolved against it, so a `//host` pathname cannot replace the origin. `/health` is exempt: a loopback probe must not need public DNS.                                                                                                                                                                                                               |
| 0     | Cloudflare Access (Worker, when enabled)                  | Edge admission ahead of this table; an admitted invocation carries trusted identity in `ctx.access`.                                                                                                                                                                                                                                                                                                                                 |
| 1     | Agent namespace, any path starting `/agent` once decoded  | First, so no path Access bypasses reaches a human route. Exactly `/agent/<pool>`: admission, then the `cta_` adapter alone, then pool membership; every other spelling is the pool 404 before admission or auth. See [agent endpoints](./auth.md#agent-endpoints).                                                                                                                                                                   |
| 1     | `/oauth/client-metadata/<connectorId>`                    | Public GET-only CIMD for configured self-hosted OAuth connectors; fixed `publicUrl`, no auth or storage.                                                                                                                                                                                                                                                                                                                             |
| 1     | Mounted UI routes                                         | Before wildcard OPTIONS, so mutation routes refuse preflight rather than inheriting MCP CORS. No UI module, no routes.                                                                                                                                                                                                                                                                                                               |
| 1     | `/connect/<connectorId>`, `/oauth/callback/<connectorId>` | GET-only browser OAuth routes, before wildcard OPTIONS. Both verify the initiating user and management permission, independent of the UI.                                                                                                                                                                                                                                                                                            |
| 2     | MCP preflight                                             | Allowed `OPTIONS` on `/mcp*`: 204 without admission or auth.                                                                                                                                                                                                                                                                                                                                                                         |
| 2     | Other `OPTIONS`                                           | Auth metadata first, otherwise compatibility CORS preflight.                                                                                                                                                                                                                                                                                                                                                                         |
| 3     | `/.well-known/*`                                          | Public auth metadata, or 404. Protected-resource discovery does not authenticate callers or evaluate endpoint grants.                                                                                                                                                                                                                                                                                                                |
| 4     | `/health`                                                 | Open and payload-free: health, executor, admission, and deployment metadata.                                                                                                                                                                                                                                                                                                                                                         |
| 6     | `/mcp`, `/mcp/<pool>`                                     | Admission, then auth, then a request-local MCP server. No body is read before auth and endpoint admission. A request naming `subscriptions/listen` takes its permit only after a bounded classification read (413 past 64 KiB); a body-confirmed modern listen takes none and is refused after SDK validation. A non-maintainer at `/mcp`, a non-member, and an undeclared pool get one identical 404; see [pools](./auth.md#pools). |
| 7     | Other paths                                               | 404. Custom HTTP routes belong to the deployment.                                                                                                                                                                                                                                                                                                                                                                                    |

Every response leaves through `withSecurityHeaders`. HTML uses one common
security-header helper, including status and error pages. Operator shells
allow same-origin scripts and deny framing. Clerk pages also admit the validated
loader origin, the exact Cloudflare CAPTCHA script and frame host, Clerk images,
and first-party or blob workers. Local Clerk sign-in adds a nonce for its bootstrap.
`test/server-route-contracts.test.ts` pins the ordering and the exact refusal
bodies; it exists because the ordering is invisible in any one file and a
reordering reads like a harmless refactor.

An admitted non-preflight `/mcp` request then takes five steps in
`src/routes/mcp.ts`:

1. **Admit.** No request body is read before auth on any endpoint. A request
   whose `Mcp-Method` header names `subscriptions/listen` takes no permit
   before auth. After auth and endpoint admission connecta reads at most
   64 KiB (`MAX_LISTEN_CLASSIFICATION_BYTES`) of it: past that it answers
   413 `-33006` and stops reading. A body that confirms a modern listen stays
   permit-free, passes SDK validation, and receives HTTP 404 with JSON-RPC
   `-32601`; anything else takes a permit then, so the header alone bypasses
   nothing. Auth and classification share the configured request lifetime.
   Other requests take one permit from the deployment-wide pool, taken before
   auth so an unauthenticated flood costs a request permit before an auth lookup,
   and held until the response _body_ completes, the caller leaves, or its
   configured lifetime ends, not until the handler returns.
2. **Authorize.** Every adapter invocation passes the independent fixed
   16-active-authorization bound in `src/auth-admission.ts`, including header-named
   listens, SDK-owned auth, agent-token storage, and operator/connection routes
   outside the MCP pool. Shared state is counters and bounded plain charge
   records, never request I/O; there is no queue or shared promise. Saturation
   returns retryable 503 `authentication_busy` with `Retry-After: 1` and a
   checked payload-free log. Each request releases exactly once after the
   adapter and its cancellation cleanup settle; abort alone does not release
   capacity. At its hard deadline plus one second of grace, unfinished work
   moves to a separate allowance of 16 abandoned operations, or stays active
   while that allowance is full. A full allowance refuses all new work, logged
   as `authentication_abandoned_saturated`; only a charge's end decrements it
   and promotes an overdue active charge. A charge ends exactly once, through a
   released state in its plain record: on settlement, or when the collector
   frees its token. That token is an object held only by the closures
   attached to the adapter promise and the registered native operations (plus
   the deadline timer and the request's lifetime entry, which refers to the
   lifetime through a `WeakRef`, because workerd keeps a `Request` and its
   WeakMap entries alive past its invocation). A module-level
   `FinalizationRegistry` holds the record, never the token, so a freed token
   proves nothing can settle the charge; the next admission logs
   `authentication_unreachable`. Without `FinalizationRegistry` (workerd
   without `enable_weak_ref` before 2025-05-05) only settlement releases.
   Health exposes both counters and `unreachableRelease`. Access
   and agent verification race five-second deadlines while registering their
   uncancellable native work with the invocation's charge. The request's
   `ctx.waitUntil` keeps that same settlement continuation runnable on Worker
   disconnects. No other request touches its promise, signal or I/O. Clerk
   uses a client per authorization, with its signal and a ten-second deadline
   across verification, JWKS, handshakes, session refresh, domain and gate
   lookups. The SDK transport buffers at most 1 MiB, closes every upstream body,
   and makes no JWKS retries; no live response escapes to an SDK clone. No current adapter exposes a cheap,
   fully authenticated cache hit, so the entire adapter invocation counts.
   [Authentication capacity](./auth.md#authentication-capacity-and-ingress-limiting)
   lists exemptions and ingress requirements. `/agent/<pool>` consults only the built-in `cta_` adapter
   (`authorizeAgent`), never with the runtime context that carries
   `ctx.access`. Human endpoints refuse a `cta_` token before recognition or
   storage, and never ask the `cta_` adapter. A provider's
   synchronous credential recognition selects the sole verifier for an explicit
   credential; a refusal never falls back to another identity. With no recognized
   credential, configured providers are tried in order. A 401 takes its
   challenge from the actual protected-resource metadata owner. No providers
   means open development and warns at construction.
3. **Admit to the endpoint.** Plain `/mcp` admits a principal listed in
   `maintainers` (or, with no inbound auth, the anonymous caller) and serves the
   whole catalog. `/mcp/<pool>` admits the pool's human `members`, matched by
   principal, and `/agent/<pool>` its agent members, matched by
   `identity.agent`; both serve exactly the pool's tools
   (`src/membership.ts`, `admitsMaintainer`, `memberPool`, and `agentPool` in
   `src/routes/shared.ts`). Nothing intersects or widens either view; every
   refusal is one 404 naming no pool.
   Connector `readOnly` is enforced by catalog discovery and invocation before dispatch: effective read-only is endpoint OR connector, including on plain `/mcp`. Maintained provider construction carries the policy through the shared factory.
   The endpoint's `readOnly` is the pool's own value, else the deployment's;
   plain `/mcp` uses the deployment's. It travels to the meta-tools and the
   program as one boolean that drops writes from `CatalogService` search and
   describe and makes `writeRefusal` (`src/tool-safety.ts`) refuse every write
   call. Guides and skills are not filtered.
4. **Derive the registry view.** One `registry.scoped(...)` call with those
   connector ids, exact `connector.tool` addresses when the pool declares a
   narrower slice, and the subject and principal keys. Personal connectors use
   the principal partition and result paging the subject partition with principal,
   endpoint/pool, origin, connector, and tool bindings. Paging re-admits the
   caller at its endpoint and rechecks endpoint OR connector `readOnly`; no caller parameter selects a partition (`test/identity-scope.test.ts`).
5. **Serve.** Refuse `?toolkit=` with a 404 — the toolkits are gone
   ([#178](https://github.com/zackbart/connecta/issues/178)) but their URLs were
   handed out, and retiring a scoping boundary into fail-open is worse than any
   404 — then register the six meta-tools on a fresh `McpServer`
   (`test/server.test.ts`, `test/code-first-surface.test.ts`).

### Modern request metadata and transport refusals

The SDK lifts each modern request's client declarations from `_meta` into
`ctx.mcpReq.envelope`. Meta-tool handlers bind `clientCapabilities` and
`clientInfo` to their request-local context before dispatch. These declarations
never select an identity, grant, connector view, or pool. Direct and program
activity records retain only the self-declared `clientName` and `clientVersion`,
validated by one ASCII grammar at the record builder, SQL write/read boundaries,
and authenticated activity read route. Names match
`[A-Za-z0-9@][A-Za-z0-9 ._@/+-]{0,63}`; versions match
`[A-Za-z0-9][A-Za-z0-9._+-]{0,31}`, each as a whole string. Names allow up to
64 characters, versions up to 32. `__proto__`, `constructor`, and `prototype`
are reserved. Invalid values are absent, never truncated or escaped. Capabilities and other client metadata never enter activity.
Legacy requests without an envelope leave client facts absent.
Every emitted activity event also carries `packageVersion`, generated from
`package.json` before build and independent of the display-only `serverInfo`.
Doctor uses and reports that same generated version. SQL stores validate
package versions against a bounded release-version grammar on write and read;
the nullable `package_version` migration leaves old rows unknown rather than
assigning today's version to history. `/ui/api/activity` serves these facts
read-only with the same authorization and validation as `/ui/activity`.
Catalog changes emit discrete, payload-free activity events after accepted
refreshes. Reviewed drift observations remain in authenticated connector status
and the maintainer-run provider check; public health counts are removed.

`server/discover` advertises `io.modelcontextprotocol/skills` and `resources: {}`
with private one-hour discovery cache hints. It includes the configured identity, icons, title,
and website in `io.modelcontextprotocol/serverInfo` result metadata. The Skills
extension and its skill-only resources share `src/skills.ts` with the meta-tool
and guest API. Both direct
call tools declare `address` as `x-mcp-header: "Address"`, which the SDK mirrors
and validates as `Mcp-Param-Address` on modern requests.

Connecta's own admission, deadline, pool, and access refusals use JSON-RPC error
bodies with `Cache-Control: no-store` and the HTTP statuses below. They omit the
unknown RPC id because the route refuses before decoding the RPC body. An aborted
request releases its resources without cancelling a newly created deadline
error body. Auth adapters continue to own their challenges and refusal bodies.
Admission and Connecta-owned refusal bodies share the MCP exchange's
request-scoped sent-credential set and pass through `redactAgentOutput` before
serialization. The SDK's `server/discover` response and registered meta-tool
results use that same set; connector contexts retain only an opaque scope.

| Refusal                              | HTTP status | Application code | Previous code |
| ------------------------------------ | ----------- | ---------------- | ------------- |
| Request capacity exhausted           | 503         | `-33001`         | `-31001`      |
| Server shutting down                 | 503         | `-33002`         | `-31002`      |
| Request lifetime exceeded            | 504         | `-33003`         | none          |
| Pool missing or refused              | 404         | `-33004`         | none          |
| Origin or admitted access forbidden  | 403         | `-33005`         | none          |
| Listen classification body too large | 413         | `-33006`         | none          |

These allocations are outside JSON-RPC's reserved `-32768..-32000` range and
MCP's `-32020..-32099` range. The prior admission codes were also outside those
ranges; the migration changes the application allocation, not a reserved-code
violation. See the [2026-07-28 error-code policy](https://modelcontextprotocol.io/specification/2026-07-28/basic#error-codes).

`connecta doctor` uses SDK auto negotiation, checks the exported
`META_TOOL_NAMES` set, and reports the negotiated revision. It closes its client
on success or failure and refuses credential-bearing redirects during discovery,
legacy initialization, and tool calls.

## Layers below the meta-tools

The meta-tool handlers are thin. The work sits in six modules the registry owns
or hands out, and a change usually belongs in exactly one of them:

| Module                   | Owns                                                                                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/registry.ts`        | The connector set, identity-scoped views, personal storage partitions, address resolution, request-local complete-catalog reads, connector health, per-connector call limiters, and drift. Construction-time refusals live here. |
| `src/catalog-cache.ts`   | SQL-backed SDK tools/resource/template listing cache, intake redaction, TTL bounds, host auth partitions, invalidation generations, and completed-refresh observations.                                                          |
| `src/catalog-service.ts` | Request-local listing, search, and describe. Caches catalogs inside one request and fans discovery probes out under deadlines.                                                                                                   |
| `src/invocation.ts`      | One tool call: argument validation, call admission, one-attempt timeout, provider retry hints, result unwrapping, size capping, and the activity record.                                                                         |
| `src/catalog.ts`         | Ranking, description summarizing, and the compact and TypeScript schema renderers discovery shows.                                                                                                                               |
| `src/result-shapes.ts`   | Bounded runtime-only inference and merging for output shapes learned from successful read-only calls whose providers declared none.                                                                                              |
| `src/program-writes.ts`  | Program write accounting on writable endpoints: write budgets, dispatch draining, and known or unknown outcomes.                                                                                                                 |

`src/meta-tools.ts` and `src/execute.ts` are two front doors onto the same two
services, `CatalogService` and `InvocationService`. That is the point: a
program's `connecta.call` and a top-level `call_tool` reach
`InvocationService.invoke` by different routes and get the same admission, the
same credential resolution, and the same fail-closed read-only check: one
`writeRefusal` decision per call, from the stored classification, the calling
surface, and the endpoint's `readOnly`.
`test/execute.test.ts` asserts the parity directly, because a sandbox path that
quietly diverges is how generated code would mint a capability.

Program result paging shares `meta-tools.ts`'s direct-call stash envelope and
reader. `program-result.ts` owns executor-independent byte limits;
`execute.ts` issues bounded transfer cursors, and `guest-runtime.ts` reconstructs
values through provider preludes. Cursors hold only an ID and offset for the
current run. Result bytes, expiry, authority and capacity charges stay in the
existing storage and ledger; no executor-specific store or storage key is added.

## Admission, in two places

Request admission (`src/executor-admission.ts`, applied in `src/routes/mcp.ts`)
bounds the MCP envelope: one deployment-wide FIFO pool, plus a deliberately
smaller code pool a program takes a _second_ permit from, so one request cannot
trade ordinary capacity for unbounded sandboxes. `admission.code` is only a
fallback — an executor implementing `acquire()` owns a bounded pool already, its
settings win, and connecta warns the fallback was ignored. Invalid bounds throw
at construction, because a pool that quietly became unbounded is worse than a
deployment that refuses to boot. The queue is global FIFO across identities: a
capacity boundary, not tenant fairness, and one deployment serves one tenant.
`admission.requests.maxDurationMs` defaults to 300,000 ms and may be set to a
positive whole number up to 2,147,483,647 ms. Its clock starts when admission
grants a permit and covers authorization, tool execution, and response delivery.
The owning request aborts its derived signal at that deadline, including signals
passed to connector calls, and closes a live response. If workerd ends the
request without running that timer or cancellation, the controller reclaims
only the expired permit's scalar record on the next request (or a queued
request's own timer). It never reads the old request's signal or touches its
stream. Expired queued waiters are pruned before any handoff; every handed-off
permit has its own deadline even if the recipient never resumes. Lease identities
make an old late release harmless to a newer permit. Set the bound above the
longest admitted request the deployment expects to serve.

Call admission (`src/call-admission.ts`) answers what the envelope cannot see —
a connector's optional policy over its own `Connector.callTool` attempts,
partitioned by an optional `partitionKey` and bounded by concurrency, a
rolling-window budget, or both. Exactly one rule is accepted, because several
cannot be faked as sequential leases: consuming a rolling token before a later
rule refuses would charge a call that never reached the provider, the exact
accounting error a budget exists to prevent. Both layers are pinned by
`test/request-admission.test.ts` and `test/call-admission.test.ts`.
Every defined budget must be an object with `kind: "rolling-window"` and positive
whole `maxCalls` and `windowMs` values. Malformed budgets, including `false`,
`null`, `0`, and `""`, throw during construction, even when the rule also sets
`maxConcurrency`.

An admitted tool call can charge sequential auxiliary downstream requests with the internal
`chargeConnectorCall(ctx)` hook in `src/call-admission-context.ts`. Invocation
binds the context to its existing permit; the hook returns a Promise over an
internal Effect program. The charge uses the enclosing call's partition
and concurrency slot, so a connector with `maxConcurrency: 1` can perform a
lookup without queuing behind itself. Exhaustion returns the same
`CallAdmissionError` and retry delay as ordinary call admission, before the
auxiliary request is sent. Charges against a configured policy also refuse
after cancellation, permit release, or controller shutdown. The hook adds no
public connector option or context member. Contexts outside registry invocation
have no bound permit, so the hook does nothing there. Providers await the hook
before sending and propagate its refusal; it does not acquire concurrency for
parallel auxiliary requests.

Cloudflare's REST connector charges each uncached zone-ownership lookup used
to enforce an account pin, in addition to the enclosing tool-call attempt.
Explicitly pinned zones and cached ownership need no extra request or charge.
Its limits of three ownership lookups per call and 60 per five minutes per
connector remain: they bound pin checks separately from the connector's larger
shared call budget. The Cloudflare provider tests cover these checks through
registry invocation as well as the existing pin refusals.

Only an omitted or `undefined` `callAdmission` selects a connector's default.
The shared schema rejects malformed defined policies at factory construction,
and the registry validates custom connector policies before registration.
Falsy values such as `false`, `null`, `0`, and `""` are construction errors
(INV-11), never a way to disable admission. The generated provider fixtures
exercise these refusals and unchanged defaults in
`test/call-admission-options.test.ts`.

### Production Worker disconnects

The original production probe for [#573](https://github.com/zackbart/connecta/issues/573)
ran on 2026-09-25 with compatibility date `2025-01-01`, first with no flags and
then with `enable_request_signal`. It used Wrangler 4.114.0 and a Node 26.9.0
client. A raw Worker stream established the runtime behavior; a custom auth
provider returning a synthetic streaming 401 exercised Connecta's real admission
wrapper. Each case had its own Connecta instance with one request permit and no
queue. Health checks and subsequent MCP requests confirmed the same isolate ID.
The [recorded observations](https://github.com/zackbart/connecta/blob/a0ac904513fac735582b4bc9c817a48300134328/scripts/probes/worker-disconnect-2026-09-25.json)
contain all twelve cases, including served flags and client-end timing.

| Response and flag                                     | Raw stream abort / cancel | Connecta source abort / cancel | Admission after response; next request |
| ----------------------------------------------------- | ------------------------- | ------------------------------ | -------------------------------------- |
| Heartbeats, no flag                                   | neither                   | neither                        | active 1; 503                          |
| Idle with a pending timer, no flag                    | neither                   | neither                        | active 1; 503                          |
| Heartbeats, request signal enabled                    | abort only                | both                           | active 0; 200                          |
| Idle with a pending timer, request signal enabled     | abort only                | both                           | active 0; 200                          |
| One chunk, then no timer or I/O, either configuration | neither                   | neither                        | active 1; 503                          |

The last row is a different failure. The client observed the response end
_before_ its planned disconnect, although the source never closed itself.
The runtime ended the response without running JavaScript cleanup. This does
not show a missing abort on a still-live request. The other cases remained open
until the client aborted. Admission was sampled 1.5 seconds later, followed by
an actual MCP request; this measures retained capacity, not an infinite leak.

Enable `enable_request_signal` when deploying on Workers: it let Connecta's
abort listener cancel the source and release admission for live responses in
this experiment. It does not solve runtime-ended streams. The admitted-request
bound above recovers capacity on the first later request at or after its
deadline, even if the old request's timer never ran. This is capacity recovery,
not proof that workerd cancelled an old stream. A still-live request reaches
the same hard deadline and is aborted in its own context.
Cloudflare documents the flag in its
[Request API](https://developers.cloudflare.com/workers/runtime-apis/request/).

### Authentication release by collection on workerd

Measured on 2026-10-20 with workerd 1.20260722.1 (Miniflare 4.20260722.0),
compatibility date `2025-01-01`:

- `FinalizationRegistry` and `WeakRef` are undefined without
  `enable_weak_ref`; the flag's default-on date is 2025-05-05.
- With `enable_weak_ref` and `enable_request_signal`, an object reachable only
  through a fetch continuation is finalized once its invocation ends and
  workerd cancels the fetch; while the invocation runs it is not. Pending
  timers and listeners on the request's signal do not keep it.
- Strong values in a WeakMap keyed by a `Request` (even one the handler
  created), properties set on a `Request`, and WeakMap values keyed by its
  `Headers`, `ctx` or `env` stay reachable after the invocation ends. The
  lifetime registry in `src/auth-admission.ts` therefore stores `WeakRef`s.
- No `gc()` is exposed. Allocating large arrays (32 × 1 MiB per request)
  triggers collections, but the most recent unreachable object often survives
  them; V8 in this build scans the native stack conservatively. The inspector's
  precise `HeapProfiler.collectGarbage` freed it.
- In the vitest-pool-workers harness, an isolate that had already collected
  one scenario's cancelled work sometimes kept a later scenario's cancelled
  work reachable through 400 rounds of pressure; standalone Miniflare never
  did. `test/auth-admission-binding.test.ts` gives each collection scenario a
  fresh isolate and requires two of four sentinels collected before asserting
  that live charges stayed counted.

A second production run on the same date tested the request bound at 2,000 ms.
All twelve raw-stream and MCP cases passed with both flag configurations. Live
MCP requests still rejected a competing request with 503 before the deadline;
the first MCP request after the deadline returned all eight tools with 200 in
the original isolate. Admission then reported zero active requests. Without the
flag, the source still recorded no abort or cancellation, so recovery did not
rely on runtime cleanup. The [recovery observations](https://github.com/zackbart/connecta/blob/32d8e94/scripts/probes/worker-disconnect-recovered-2026-09-25.json)
also retain two inconclusive queue-handoff cases: concurrent client connections
reached different isolates and could not establish an abandoned queued waiter.
A [second trial using HTTP/2](https://github.com/zackbart/connecta/blob/b174812/scripts/probes/worker-disconnect-h2-2026-09-25.json)
repeated the twelve passing core cases and verified queued cancellation with
request signals enabled. Even on one HTTP/2 connection, the no-signal queue case
crossed isolates and remained inconclusive. The Node and workerd regression
suites cover expired waiters, orphaned handoffs, and identity-safe late release
deterministically.

To repeat from a repository checkout, run
`node scripts/probes/worker-disconnect.mjs` with an authenticated Wrangler.
The script is not in the npm package. It deploys a disposable Worker containing
only synthetic data, verifies the served configuration, saves observations under `eval/results/`,
and deletes the Worker in `finally`. It uses no `waitUntil`, which would change
the lifetime being measured. The production runtime build number was not
exposed by the deployment; these findings are tied to the date and flags above.

### Production Access bypass for agent endpoints

P0 of [#837](https://github.com/zackbart/connecta/issues/837) asked whether
`/agent/*` can skip a Worker-level Cloudflare Access application, so an agent
sends only its `cta_` token, while every other path keeps Access and
`ctx.access`. It can. The probe ran on 2026-10-15 against a disposable Worker on
its `workers.dev` hostname, with compatibility date `2026-09-01`, `cf`
1.0.0-beta.14, Wrangler 4.114.0, and curl 8.7.1 with `--path-as-is`, so raw
paths reached the edge unnormalized. The Worker-level application allowed only
a probe service token. Its unauthenticated refusal was therefore Access's 403
page rather than a login redirect. The [observations](https://github.com/zackbart/connecta/blob/main/scripts/probes/access-agent-bypass-2026-10-15.json)
record three identical rounds after each configuration change had produced
three consecutive matching responses.

- **Precedence.** A self-hosted application whose destination is
  `{ "type": "public", "uri": "<host>/agent/*" }`, with one `bypass` policy
  including `everyone`, overrides the Worker-level application on matching
  paths only. Unauthenticated requests reach the Worker there. `/mcp`, `/`,
  and every unmatched path still get the Access refusal. A service token is
  still admitted on them with `ctx.access` from the Worker-level application.
  This confirms Cloudflare's documented hierarchy, and that Worker-level
  protection still covers the `workers.dev` hostname.
- **`ctx.access` on a bypassed request is present, not absent.** Its `aud` is
  nonempty and is the _path_ application's AUD, not the Worker-level one.
  `getIdentity()` resolved to `undefined` for every credential tested: none, a
  valid service token, a `cta_`-style bearer token, and a forged
  `Cf-Access-Jwt-Assertion`. A service token on a protected path also gave
  `undefined` identity, carrying the Worker-level AUD. A human
  `CF_Authorization` cookie on a bypassed path was not tested, so what
  `getIdentity()` returns there is unknown. That is one more reason the agent
  route ignores Access context rather than relying on its contents.
- **API shape.** A Worker destination is exclusive to one application. A
  second application with `{ "type": "worker", "worker_id" }` plus `uri` or
  `path` was refused with 409 `destination belongs to another application`. The
  bypass must be hostname-and-path, stored with domain `<host>/agent/*`, and it
  covers only that exact hostname.
- **Propagation.** Creating or deleting each application took 15–19 seconds to
  settle across runs. While a deployment or application change was propagating,
  the edge returned transient 500 (`error code: 1104`) and 404 (`error code:
  1042` or `1043`) responses. The recorded run has one such 404, on the
  Worker-level-only service-token control for `/agent/x`. Deleting the path
  application restored the 403 on `/agent/x`.

| Raw request path           | Access outcome | Worker pathname (+ search) |
| -------------------------- | -------------- | -------------------------- |
| `/agent/x`                 | bypassed       | `/agent/x`                 |
| `/agent/assistant-alice`   | bypassed       | `/agent/assistant-alice`   |
| `/agent/`                  | bypassed       | `/agent/`                  |
| `/agent/x/`                | bypassed       | `/agent/x/`                |
| `/agent/x?y`               | bypassed       | `/agent/x?y`               |
| `/AGENT/x`                 | bypassed       | `/AGENT/x`                 |
| `/%61gent/x`               | bypassed       | `/%61gent/x`               |
| `//agent/x`                | bypassed       | `//agent/x`                |
| `/agent/%2f/mcp`           | bypassed       | `/agent/%2f/mcp`           |
| `/agent/x%2f..%2f..%2fmcp` | bypassed       | `/agent/x%2f..%2f..%2fmcp` |
| `/mcp/../agent/x`          | bypassed       | `/agent/x`                 |
| `/mcp`                     | protected      | not reached                |
| `/`                        | protected      | not reached                |
| `/agent`                   | protected      | not reached                |
| `/agentx`                  | protected      | not reached                |
| `/mcp/agent/x`             | protected      | not reached                |
| `/agent/../mcp`            | protected      | not reached                |
| `/agent/x/../../mcp`       | protected      | not reached                |
| `/agent/%2e%2e/mcp`        | protected      | not reached                |
| `/agent/%2E%2E/mcp`        | protected      | not reached                |
| `/agent%2f..%2fmcp`        | protected      | not reached                |

Access matches after resolving dot segments, including `%2e` forms. It matches
case-insensitively, decodes unreserved escapes such as `%61`, collapses a
leading `//`, and treats `%2f` as data, not a separator. The effective Worker
pathname, `new URL(request.url).pathname`, is the raw request path with case,
escapes, and slashes untouched, except that dot segments arrive resolved:
`/mcp/../agent/x` arrives as `/agent/x`. Every path that
resolves outside `/agent/*`, including every `/mcp` form, stayed protected. The
inverse is the risk: Access bypasses paths
that connecta must not treat as an agent pool. Connecta's router compares raw
pathnames without decoding, case folding, or slash collapsing, so an `/agent/`
route must keep that property. It should accept exactly
`/agent/<pool>`, with `<pool>` byte-equal to a declared pool name. It should
refuse an empty segment, a trailing slash, any extra segment, `%`, uppercase
variants, and a leading `//`, all with the same 404. It must ignore
`ctx.access` entirely, since a bypassed request still carries an AUD.
[Agent endpoints](./auth.md#agent-endpoints) implement exactly this in
`src/routes/agent-path.ts`, and `test/agent-endpoints.test.ts` replays every
row of the table above. The hyphenated row stands for any two-part pool name
such as `<agent>-<user>`. The pool names in the recorded paths were replaced
with placeholders after the run; the edge behavior for that path shape was
unaffected.

To configure the bypass, keep the Worker-level application described in
[Cloudflare Access on Workers](./auth.md#cloudflare-access-on-workers). Then,
for each hostname agents use (the `workers.dev` hostname, each Custom Domain,
or route host), add a self-hosted Access application. In the dashboard, set
domain to that hostname and path to `agent/*`, with one policy whose action is
**Bypass** and whose include rule is **Everyone**. Through the API, that is:

```json
{
  "type": "self_hosted",
  "name": "connecta agents",
  "destinations": [{ "type": "public", "uri": "connecta.example.com/agent/*" }],
  "policies": [{ "name": "agents bypass", "decision": "bypass", "include": [{ "everyone": {} }] }]
}
```

Only the `workers.dev` hostname was probed. A Custom Domain application is the
same documented hostname-and-path form, but it was not observed here. Do not
rely on a fixed wait after a change. Changes settled in 15–19 seconds, yet one
earlier round still saw a 403 on a bypassed path more than 30 seconds after
the change. Test only after the positive and negative controls agree together
for several consecutive rounds. The positive controls are bypassed paths
reaching the Worker with the path AUD and a service token reaching a protected
path with the Worker-level AUD; the negative controls are `/mcp` and `/`
returning the Access refusal. The current script requires five such rounds
after creating the bypass and three after other changes. The recorded run
predates this: after the bypass it converged only the positive `/agent/x`
control, then waited a fixed 90 seconds, and its negative controls were checked
in the recorded rounds rather than before them.

To repeat from a repository checkout, run
`node scripts/probes/access-agent-bypass.mjs --profile <name> [output.json]`.
`--profile` is required and has no default; every `cf` call passes it
explicitly. Name the profile for the account that should host the probe; it
needs
Access application, policy, and service-token writes, plus Workers script
writes. The script deploys and deletes the Worker with `cf`. `cf deploy` builds
through Wrangler 4.136.0 or newer, so the probe installs Wrangler 4.145.0 into
its temporary project. Wrangler needs no login. The script records only the
count of existing Access applications, then names everything it creates
`connecta-probe-<run>`. It force-deletes and verifies each resource in
`finally`, then checks that the non-probe application ids are unchanged.
Observations record statuses, outcome classes, pathnames, and which
application's AUD matched, compared by digest inside the Worker. They contain no
hostnames, account ids, tokens, cookies, or JWTs. `cf` delete commands prompt
for confirmation and exit 0 without deleting when stdin is not a terminal, so
the script passes `--force`. `cf deploy` printed `Deploy complete` and then
kept running, so the script stops it after that line. The recorded run deployed
with Wrangler 4.114.0 and used `cf` for Access. A standalone deploy and delete
verified the `cf` deploy and delete path. The full probe has not been rerun on
that path.

Every subprocess (`cf`, `curl`, `npm`) runs through one runner. It enforces a
deadline by killing the process group, keeps stdout and stderr in memory, and
returns only facts: success, exit code, timeout, HTTP status, numeric API
code, and an error slug from a fixed set (anything else is `unknown`). Commands
that return data are parsed inside the runner against schemas that copy only
whitelisted fields: ids, names, counts, booleans, and the Worker's `ctx.access`
summary. Credentials stay in a holder that prints as `[secret]`. An unexpected
shape, including `null` where a list belongs, is a failure, never an empty
result. Errors are fixed diagnostics plus those facts. Teardown deletes every
tracked id on its own. Then Access applications, service tokens, and Workers
each get their own bounded discovery-and-delete pass by name, for resources
whose create response was lost, so a failure in one family never skips
another. Each discovered resource is deleted independently. Access policies are
inline on their applications and go with them. A resource counts as gone only
when a successful lookup omits it, and the final inventory verifies each family
separately. Run
`node scripts/probes/access-agent-bypass.mjs --self-test` to check the runner
offline. It feeds canary secrets, suffixed slugs, malformed JSON, and a stalled
process tree through it. It also runs teardown against a fake `cf` whose
application listing always fails, after a lost token-create response, and
checks that the token is still found and deleted. It also checks that a Worker
that refuses deletion does not block another Worker's deletion. It runs no real
`cf`, `curl`, or network command. This
hardening and the joint convergence are verified offline only and have not run
against Cloudflare.

### Alchemy Worker deployment

Two throwaway deployments on 2026-10-20 verified the Worker example's
Alchemy path with alchemy 2.0.0-beta.83, effect 4.0.5, and Alchemy local
state, then deleted every resource and confirmed by re-listing. Alchemy
uploads the full Worker with `PUT /workers/scripts/<name>`, the endpoint an
earlier full deploy had been suspected of losing `ctx.access` through.

The first deployment ran a near copy of the stack with a temporary diagnostic
route. With an Access service token in a non-identity policy, the Worker saw
`ctx.access` carrying the Worker-level application's AUD and no identity, as
expected for a service token. D1, the Worker Loader, R2, and secret bindings
worked; `/agent/*` reached connecta through the bypass; `/ui/api/config`
returned 403 `Cloudflare Access human identity required`; and
`connecta doctor` passed with a `cta_` token issued inside the Worker. A code
update through `alchemy deploy` kept the script tag, `ctx.access`, and D1 rows.
Three consecutive probe rounds agreed.

The second deployment ran the shipped `alchemy.run.ts` from the packed package
in a separate project on Node 26, changing only resource names and the Access policy
(a service token). The edge checks in the example's "Verify after deploying"
held for three or more rounds after each deploy. `alchemy destroy` deleted the
Worker and both Access applications and orphaned the retained D1 database; the
next deploy adopted it by name with its rows. After deleting local state, a
deploy reused the Worker with the same script tag, and `applicationId` took
both Access applications over with unchanged AUDs and no duplicates. Removing
`applicationId` afterwards planned an in-place update, and a further deploy
planned no changes. The account API token needed only Workers Scripts Write,
D1 Write, Access: Apps and Policies Write, and Access: Organizations, Identity
Providers, and Groups Read.

Four findings shape the operator rules. Alchemy local state under
`.alchemy/state/` records secret binding values in plaintext. Alchemy sends no
`keep_bindings`, so each deploy deletes secrets set outside the stack.
`alchemy dev` does not provide `ctx.access` to a plain fetch Worker, so local
development stays on `wrangler dev` and its `access.dev` identity. D1 needs
`RemovalPolicy.retain()` so `alchemy destroy` cannot delete a deployment's
state. Not verified: `Cloudflare.state()` remote state, custom domains, and
taking over a Worker first deployed with Wrangler.

npm strips `.gitignore` from the package, so the copied Worker example's
ignore rules ship as `examples/worker/gitignore`, renamed by the README's copy
step. `test/deployment-shapes.node.test.ts` checks a copy of the source tree,
and `scripts/check-package.mjs` extracts the packed example with the README's
`tar` command; both confirm git leaves `.alchemy/`, `.env*`, `.dev.vars*`,
`.wrangler/`, and `node_modules/` untracked.

## Storage, credentials, and connectors

A deployment has one store. On Workers it is one D1 database
(`d1Storage(env.CONNECTA_DB)` from `@zackbart/connecta/d1`); on Node it is one
SQLite file (`sqliteStorage(path)` from `@zackbart/connecta/sqlite`, over the
built-in `node:sqlite`). Both are the same SQL key-value store
(`src/storage/sql.ts`) over a three-method driver, so every statement runs
unchanged on each, and the same module carries the activity table beside it.
Each store creates its tables on first use. `memoryStorage()` is the default
and the test double. Workers KV and the 0.28 JSON file store are gone: KV is
eventually consistent and cannot compare-and-set, and the file store rewrote
its whole file on every write. Each has a one-shot copy into its replacement,
`copyKvToD1` on `/d1` and `connecta migrate-state` on Node. Both copy live
entries verbatim, because physical keys did not change, and both keep any key
the target already holds. `copyKvToD1` reports counts per key family
(`familyOfKey` in `src/storage/keys.ts`), never a key. It resumes through a
source-bound, atomically claimed token, because Workers KV's own list cursor
can spell a key. Copy under maintenance after KV stabilizes, verify hashes
and expiries, and mark cutover before reopening traffic; the permanent D1
marker refuses stale copies afterward.

`KVStorage` is `get`/`set`/`delete`/`list(prefix)`/`compareAndSet`, all
required, and `createConnecta` refuses storage missing one (INV-11).
Adapters must also declare `capabilities: { absoluteExpiry: true }`.
Construction rejects missing or false capability declarations with an error
naming `capabilities.absoluteExpiry`. The memory, SQLite, and D1 adapters carry
this marker. Custom adapters may declare it only after implementing absolute
expiry on both writes; a legacy `ttlSeconds`-only adapter is rejected by the
published types and at runtime.
`compareAndSet(key, expected, next, options?)` is an atomic claim: `null` means
absent (expired counts) on the way in and delete on the way out, and a
successful write takes the same expiry options as `set`. Relative `ttlSeconds`
is created and checked by the database clock inside each statement, so isolate
clock skew cannot expire a live holder's record. Absolute `expiresAtMs` is a
safe-integer epoch-millisecond deadline stored verbatim and checked against the
storage clock. Supply at most one option. Custom adapters must implement both;
a delayed absolute-expiry write must not restart a relative TTL at commit time. Each SQL claim
is one statement, which SQLite executes atomically and D1 serializes on its
primary. Everything that must claim a key exactly once relies on it with no
read-then-write fallback: agent-token slot swaps and
adoption, OAuth handoff ownership, single-use connect links, every downstream
OAuth grant write and consent claim, and the result stash.

Every key is built in `src/storage/keys.ts`, which lists each family with its
scope, version, codec, and TTL policy; `test/storage-keys.node.test.ts` fails when
two families overlap, another source file spells a prefix (constant concatenation
folded), or a storage call passes a key holding literal text. Core hands
subsystems namespaced views: `conn:<id>:` per connector, `principal:<key>:` per
personal registry, `results:` and `subject:<key>:` for result paging.

Keys and list prefixes must not contain U+0000 (NUL). D1, SQLite, and memory
storage reject them with `TypeError` before accessing storage: Node 22's
`node:sqlite` truncates TEXT results at NUL. Builders reject NUL in unencoded
components.
State-file import validates all keys before writing. The `connecta_kv` table
keeps its existing TEXT keys, including compatibility with the 0.28 schema.
Storage writes no log lines. A refused import names the file and an entry's
position, never a key, a value, or the JSON parser's account, which quotes
the file (INV-6). Database failures report only a fixed import step and an
entry's position, including errors raised by target-database triggers.

Remote MCP catalogs use the SDK `ResponseCacheStore` over this same SQL KV.
The `response-cache:v1:` family binds connector id, a hash of its configured
endpoint/auth/protocol settings and TTL policy, an invalidation generation,
and a hash of the listing method and host-computed auth partition. Later pages
can only narrow the aggregate TTL and sharing within that partition. Request
tokens and personal OAuth or credential auth always use private entries,
including when the downstream declares `public`. Private partitions bind the
admitted principal, subject, identity, pool, endpoint, credential digest, and
OAuth epoch. Operator-shared credentials and unauthenticated connectors may
share public-hinted listings across principals within the same admitted pool
and endpoint. Private hints retain principal isolation even with shared auth.
The adapter refuses the SDK's empty shared slot for private auth modes. OAuth
listings resolve the current credential digest even within one epoch; a
credential change during a walk prevents publication under the old digest.
Each remote connector instance owns its request's cache lifetime separately,
so closing a temporary client does not end another instance with the same id.
Only complete, intake-redacted tools/list, resources/list and
resources/templates/list successes are stored. Resource payloads are not cached. SDK default
in-memory caching is replaced, so raw catalogs never enter it.

`discovery.catalogTtlSeconds` (300 by default) is the fallback for legacy
listings without `ttlMs`. Positive hints are bounded by
`catalogMinTtlSeconds` (0) and `catalogMaxTtlSeconds` (86400, also the SDK
ceiling); an explicit zero is never reused. Both bounds are nonnegative finite
seconds (fractions round down to milliseconds), with min <= max <= 86400. `persistCatalog` and `staleCatalogSeconds`
have been removed. SQL storage is always used for remote catalogs; dynamic
custom connectors are listed anew in each request; authenticated callers may
retain a complete private fallback, and static catalogs remain
in configuration. After a transient first-page tool listing failure, ordinary calls
may use a complete catalog for up to five minutes after its expiry in the same
auth partition. Partial walks, permission and auth failures do not use this
fallback. Resources require unexpired inventories. There is no deferred refresh.
Host-only provenance carries each catalog's original fetch time, TTL and expiry,
and whether it was a fallback, through classification and request-local copies.
Zero TTL and stale fallbacks cannot authorize post-entry auth recovery.

A manifest is published by CAS only after every UTF-8 chunk is written. It
records the original fetch time, absolute expiry, revision, fingerprint, and
monotonic stamp. Readers verify all chunks and fingerprint before accepting it.
Freshness expires at the bounded TTL; tool facts remain for the five-minute
fallback window, and generations expire after 48 hours; invalidation
rotates the generation, and old chunks expire without becoming reachable
again. Remote clients pin that generation before listing, including SDK cache
refreshes. Each new listing pins the current generation, so a live client can
publish a new catalog after invalidation without letting an older listing
adopt its generation. A public transport observer starts a generation rotation
before the SDK processes tool or resource list-changed notifications; its lifetime is
the connection's, including after a successful resource read or listing ends.
Opposite-scope cleanup only deletes its entry. SDK listings serialize per client
because the cache store has no per-call options. Their operation binding lasts
through the SDK's cleanup, and each cache method captures that binding before
awaiting. Cache I/O checks cancellation and scope teardown at every await
boundary. Cancelled storage waits release the listing without starting more
I/O when an already-dispatched storage operation settles. Teardown waits a
bounded time for generation rotations already started. Catalog age remains the
original fetch age across process restarts and cache hits.
`test/catalog-cache.test.ts` runs against real SQLite and D1.

`observeCompletedCatalogRefresh` in `src/catalog-cache.ts` is the accepted
refresh publication hook. The SDK tools/list wrapper calls it once after a
complete, unfenced wire refresh, including zero-TTL results. Custom dynamic
connectors publish their complete intake through the same hook. Cache hits,
rejected or abandoned walks, and identical catalogs emit no change event.
`Registry.recordCatalogDrift` compares the previous and next tool fingerprints
from this hook, preserving the requesting actor, request id, pool and deferred
activity write. The first complete catalog is a baseline.

Hash-only baselines publish bounded chunks before a manifest. They store the
catalog digest and hashes of each tool name and fact, so added, removed and changed counts require no persisted tool names or
schemas. They use the exact host auth/config cache partition, survive catalog
expiry and invalidation, and expire after 48 hours. There is no connection-wide
fallback baseline across partitions. Private catalog events use the admitted
principal actor basis even for shared-auth connectors; activity disclosure
requires that same owner and the recorded pool's grants. Ownerless private
observations cannot be disclosed. Public-hinted shared-auth catalogs retain
shared history within their admitted pool and endpoint.

Result paging stores each oversized result for 15 minutes, chunked so a page
reads only what it covers. Its bounds (`results.maxStashBytes`,
`results.maxStashEntries`) are the deployment's, not an isolate's: every charge
is a row in one ledger record, booked by compare-and-set before any chunk is
written, so isolates and processes sharing the store see one count. Every
reservation starts with a finite deadline of booking time plus the 30-second
write budget plus the chunk TTL, normally 15 minutes. Pending writes retain
that charge until its deadline. Booking retries recognize their own reservation
ID and reuse its stored deadline, including a final read after an ambiguous
last CAS. A lost swap or transient storage error backs off and re-reads, up to
32 attempts. A full ledger or unconfirmed exhausted booking returns no result id.

Caller time only nominates charges for pruning. Before discarding one, the
ledger writes a probe with that charge's absolute deadline and reads it back.
Only an absent probe proves storage has passed the deadline; a live probe keeps
the charge, and a storage error cannot free capacity. Each deadline has its own
key in `stashExpiryKeys`, so concurrent probes cannot overwrite a different
deadline's proof. Probes expire at the deadline they check and need no cleanup.
This uses the same absolute-expiry contract on memory, SQLite and D1 without a
storage API or schema change. An ahead caller clock cannot admit a second stash
while the first remains readable.

The whole chunk-write phase has a 30-second timeout measured from booking, with
a clock check before and after each write. Trailing chunks precede the header;
failure or timeout returns no result id and stops the write loop. Chunks use an
absolute expiry at booking time plus their TTL, so slow writes shorten the
remaining paging window. Storage promises cannot guarantee cancellation of an
already-dispatched database operation, and a rejected client response does not
prove that operation cannot commit later. Even a commit after timeout or process
interruption keeps that absolute expiry, rather than starting another TTL.

Settlement and release only shorten or remove a reservation. Successful writes
attempt to shorten the charge to the fixed chunk expiry. Cleanup releases it
only after all deletions succeed and every dispatched write returned confirmed
success. Failed cleanup or exhausted release attempts finite settlement when
no write is unconfirmed. A rejected or timed-out write keeps its original
reservation because it may still commit after deletion. Each completion path
has one 15-second budget covering deletion, release, fallback settlement, and
their storage waits and retries. Successful-write settlement has the same
15-second budget. A stalled operation stops being awaited when the budget
expires; its late response starts no further I/O, and no background cleanup
fiber is started. The caller returns its write outcome even if these
optimizations cannot finish. Ledger updates retry within the same 32-attempt
budget. If they fail, time out, crash, or exhaust,
capacity may be over-held until the booked deadline, at most 15 minutes and
30 seconds for the normal TTL. The ledger row itself has an absolute expiry at
its latest live reservation deadline. There are no completion receipts or
separate recovery rows; expiry probes carry no completion state. Expired data reads as absent and normal storage sweeps
reclaim the physical rows. A full stash returns the successful call's preview
and a paging-unavailable notice rather than a result id. Shared failure cases
live in `test/stash-charge-contract.ts`, exercised by the memory and SQL suites.

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
shapes — by principal, and _only_ connecta-owned context: a secret a custom
handler closes over is shared JavaScript state, and `remoteMcp()` refuses the
literal-headers-plus-personal version of that mistake. Visibility (maintainers
and pool `tools`) is a separate rule; hiding a connector does not change who
owns its auth.

### Errors and records

A failure has two audiences with two rules. The agent that made a call may read
the downstream's own answer to it: a JSON-RPC error message, an HTTP 4xx
refusal, `isError` content, or the words a handler put in a
`ConnectorCallError`. Each upstream request owns a memory-only sent-secrets
set. Every connector context links its local set into that request, including
listing, discovery, registry refresh, OAuth refresh, and provider handlers.
Direct meta-tool invocations and program runs get fresh request identities;
all operations within one HTTP request share its identity. Credential-slot reads, static
auth headers, raw confidential OAuth client IDs and secrets, and outbound
bearer tokens join the set, including tokens rotated during a call. Token and
revocation requests register client credentials before dispatch, decoding OAuth
Basic form components so a raw echo is covered too. Public client IDs remain
visible. Before any diagnostic is truncated or returned, the
agent boundary replaces these values and their auth prefixes, mixed JSON
escapes, URL encodings, and base64/base64url forms with `[redacted]`. Final
transports register sensitive headers and query values after assembling the
request; custom API handlers use `ctx.fetch`. Values shorter than eight
characters do not enter the matcher, including Basic usernames, passwords
and explicitly secret fields such as `client_secret`. Configured short
credentials produce one payload-free warning per connector; use secrets of
at least eight characters. Encoded and JSON-escaped echoes of registered
credentials follow the same redaction rules. Connecta's own messages
never quote a credential.
Core uncertainty and retry envelopes share one schema-filtered argument snapshot,
captured before dispatch and byte budgeting. `writeOnly: true` omits values of
every length, including nested properties, array items and prefixes, local
`$ref`/`$defs`, and `allOf`. `oneOf`/`anyOf` must agree on sensitivity. Unresolved
references, sensitive dynamic-property schemas or other unsupported applicators,
and traversal limits withhold the entire echo. A private array element withholds
its containing array to preserve indices. `argsRedacted: true` marks a partial
or withheld echo as reconciliation context; retries require the original arguments.
OAuth discovery and consent URLs are refused as a typed, non-retryable failure
when they contain a known credential, before persistence or reuse. This guard
checks the request's sent credentials and the current grant's credentials,
including confidential client secrets. The consent URL's expected `client_id`
parameter remains public, while echoes elsewhere are refused. URLs are never
rewritten. OAuth failure
origins are recorded only for the configured MCP or issuer origin, or the
origin of discovery metadata whose issuer matches its authorization server.
An origin matching a sent credential is omitted.
The matcher is cached until its set changes; the empty set has a fast path.
`redactAgentOutput` is the agent-facing choke point. Every meta-tool exit,
including errors, and every host-to-guest value or rejection passes through
it. Both MCP transports also pass their serialized response through it, covering
JSON-RPC errors, HTTP diagnostics, structured content, and paging responses.
Per-call redaction remains before diagnostic truncation, paging, and emits. Paging stores only request-redacted text before encoding
chunks, so a later request needs no original credentials. Programs retain the
request set only for the run so later outputs cannot reconstruct an echo.
Discovery registers sent credentials under the same rules, including
`server/discover`, legacy initialization, and every `tools/list` page on a
reused transport. Remote MCP sanitizes every list page before SDK aggregation, automatic cache
writes, derived indexes, or request-local definitions. Invalid `x-mcp-header`
declarations refuse the entire listing before the SDK can log downstream names
or silently exclude a tool. Registry intake also sanitizes custom, API and
provider listings before observation or request-local storage. Failed listings
are redacted in their own request and are never cached. Successful catalog caches and result
stashes retain only intake-redacted values; there is no tool-response cache.
Every nested string and object key passes through the redactor,
including titles, descriptions, schemas and annotations. If a tool name would
change, the complete catalog is refused. Rewriting a name changes dispatch;
dropping only that tool would publish a partial catalog, against INV-8. Later
cached reads need no credential set because the stored facts are already clean.
Echoed sensitive header lines are also withheld. The set is never persisted
or logged. Anything else (a transport, parser, stream, validator, or
runtime error) reaches it in connecta's words: step, origin, HTTP status, and
class, classified as the original would have been ([auth](./auth.md#what-a-servers-errors-may-say)).
Operators read logs, status messages, and activity, and none of them carries
any error's text, allowed or not (INV-6). `src/operator-record.ts` builds every
failure record from an explicit list of fields, each checked against a constant
table or grammar (connector, catalog-listed tool, step, origin, HTTP status,
class, code, retryability, errno, counts), and `logFailure` writes a fixed
`<rejected>` for a record it did not build, never throwing. Provenance is by
identity, never by shape: an error's class is read from its prototype chain,
never its `name`; a classification only from one connecta registered; a tool
only from the catalog entry a call resolved to, and only if it fits MCP's
tool-name grammar (else `<withheld>`, in activity rows too); and a status
message only from the snapshot connecta took of a status it created, so a
plugin `status()` or a decorator contributes its state alone. workerd quotes a
body's Content-Type in its own output when a text read meets a type it does not
parse as text, so connecta reads downstream bodies as bytes
(`src/byte-read-response.ts`), `ctx.oauth.fetch()` answers included. The
operator page may show catalog metadata the operator loaded (descriptions,
schemas), but withholds a tool name outside the grammar as it does in records.
`test/operator-record-sources.node.test.ts` is a secondary lint over every other
log call in `src/`. Fix the sink, not the source: a filter at each source missed
the next one.

## Configuration

`ConnectaConfig` is one schema (`src/config.ts`, combinators in
`src/config-schema.ts`). The same value produces the TypeScript type a
deployment writes, the unknown-key walk createConnecta runs before reading any
value, every default (`src/config-defaults.ts`, which the enforcing modules
read too), and one validation policy: a present value that is wrong throws
with its path at construction (INV-11). Nothing warns and falls back. The walk
reads property descriptors, never properties, and builds the plain copy that
is resolved in place of the caller's object, so no getter or Proxy trap runs;
an accessor on a config object or array is refused by path, as is an object
that cannot be inspected. A closed object or record slot takes a plain object
only: an array or a class instance there is refused by path, unread. String
maps (static `headers`, `api()`'s `authorizationParams` and
`tokenRequestHeaders`) are copied the same way and each value must be a
string. A discriminated union (`remoteMcp()`'s `auth.type`,
a provider's `auth.type`) with a missing or unrecognized discriminant throws
with the valid values. Only plain data is copied. Connectors, modules,
executors, storage, loggers, handlers, and schemas are opaque and never
entered. An `api()` tool carries its handler, so it is checked in place (own
keys declared, no accessor at a declared key, inherited ones included) and
passed through as given: a class-instance tool keeps its prototype `handler()`
and its private fields. Configuration is operator-authored and trusted, as in
#698; the walk refuses mistakes by path and never echoes a value, and is not
a sandbox for hostile objects. Records keyed by deployment
names (pools, `classification`) have no prototype, so `__proto__` is a name.
Built-in factories (`api()`, `remoteMcp()`, every provider, and each module
factory) walk their own options the same way, against shapes the compiler
checks against their option types (`optionsOf<T>()`). Provider definitions
declare their closed `options` shape; `defineProvider()` validates it by the
same descriptor walk before `create` reads a value and stamps the definition
name onto `describe().source.provider`. `classify` is accepted by the remote
shape and validated by the shared reviewed-classification validator. Custom
connectors remain opaque, including their `classification` field, which the
registry validates. Checks
that need the connector set — pool members, exact classification overrides, a
connector's own `maxResultBytes` — throw from `src/index.ts` and the registry
under the same policy. `storage` stays opaque, but its check requires `list`
and `compareAndSet` as well as `get`, `set`, and `delete`, so a leftover
Workers KV adapter is refused at boot with the replacements named, not at the
first OAuth callback.

`resolveConfig` returns a frozen `ResolvedConfig`: defaults applied, auth
ordered, `serverInfo` named and versioned.
Routes and meta-tools read limits from it (`ServerOptions.config`) instead of
from fields copied out one at a time. `Connecta.describeConfig()` is a
secret-free snapshot of it, built once (`src/describe-config.ts`): an allowlist
serializer that copies named fields and never spreads a config object, plus
`Connector.describe()` on `remoteMcp()`, `api()`, and the providers. Header values, keys, client secrets, credentials, URL
userinfo, queries, and fragments, and function bodies never appear; every URL
a description emits, from `describeConfig()` or a direct `describe()`, passes
through the sanitizers in `src/described.ts`, which keep http(s) URLs only
(`blob:` wraps a URL with its userinfo in the path);
`test/describe-config.test.ts` plants one in each position. Both deployment
shapes write their configuration as `defineConfig((env) => …)` in
`src/connecta.config.ts`, with optional modules as type-checked expressions
switched by the environment, and keep their entries under 30 lines.

### Providers and reviewed classification

Infisical separates explicit value reads from identifier results. `get_secret`
and `list_secrets` with `includeValues: true` return secret values and comments.
All other results, including imported secrets and pending approvals, allow only
checked IDs, keys, environment and tag slugs, paths, timestamps, positive versions
and enum fields. They omit project slugs derived from free-text names, comments,
descriptions, free-form names, reminder notes and arbitrary nested objects.
`metadataOmitted: true` reports withheld or unavailable metadata.
This assumes an honest server and protects against careless human entry in free
text. A malicious server encoding values into valid identifiers is out of scope.
Known, accepted residual risk: environment slugs are returned as required
routing identifiers. Infisical's UI derives them from environment names by
default, so secrets entered in those names can appear in returned slugs.
Operators must not put secrets in environment names or slugs. Secrets placed in
identifiers or key names are out of scope.
Write input schemas mark secret values, secret comments and folder descriptions
as `writeOnly`, so recovery argument echoes omit them without changing dispatch.
Submitted values never join the request's sent-credential set, preserving later
program arguments. Client credentials and tokens still join that set on every
call. The [provider guide](https://github.com/zackbart/connecta/blob/main/src/providers/infisical/SKILL.md) owns routing and
value-read conventions.

A maintained provider is one `defineProvider()` call (`src/provider.ts`): a
name, title, kind (`"mcp"`, `"api"`, `"composed"`, or `"dual"`), a maintained skill, an
optional reviewed classification, a closed `options` shape declared with
`optionsOf<O>()`, and a synchronous `create`. The root exports the option-shape
combinators and `PROVIDER_COMMON` so provider authors use the same validation
path. The factory refuses undeclared keys and accessors before reading any
option, copies plain data, preserves behaviour objects, then validates common
values (purpose, title, instructions, `authScope`) before `create` runs, and renders the guide: heading, the
connection context `create` supplies, the maintained text, then deployment
instructions, which append and never replace. `src/provider.ts` imports neither
transport, so an `api()` provider gains no MCP client or Effect graph from it
(`test/purity.node.test.ts`). The factory carries its `definition`, which build and
check tools read instead of keeping provider lists. Providers
live in their own folders. Hosted implementations, including the
MCP branches of Notion, Vercel, and Cloudflare, use reviewed presets over
`remoteMcp({ classify })`. The migrated API-only factories retain an internal
adapter to the same definition and description-stamping path. GitHub composes hosted tools with a scope-enforced REST complement.
A `"dual"` provider selects one implementation at construction, usually through `auth`
([decision 0005](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)):
`variants(["auth", "type"], …)` closes each case's options, and
`byAuth()` in `src/providers/_shared/rest/dispatch.ts` sends OAuth to
`hostedOAuth()` (`remoteMcp()`, OAuth only, the reviewed classification) and a
key to Connecta's REST connector. Stripe, Notion, Cloudflare, and Vercel require `auth`. Mixpanel is also dual,
with explicit `via: "mcp" | "api"` and MCP as the unchanged default: service accounts
reach both implementations, so auth cannot distinguish them. API mode requires
operator-managed service-account credentials and never falls back to MCP.
Mixpanel uses the same REST transport, operation matching and value-safety engine
for a narrow reviewed subset. Its official contracts are YAML and app identity
has no published response schema, so its guide and drift record carry explicit
manual review evidence instead of claiming a machine-checkable JSON pin.

[Decision 0011](https://github.com/zackbart/connecta/blob/main/decisions/0011-provider-standard.md)
sets the provider standard the providers above are migrating to. It fixes
one folder layout per kind and fixed evidence names. `drift.json` gets a
generated block and the guide a generated Conventions section, and every
`api()` surface gets one agent-facing shape. It also folds `"composed"` into
`"dual"` with an optional tool-ownership map. Each provider migrates in two
PRs: onto the kit with unchanged output, then onto the standard surface.
`PENDING` in `test/provider-standard.ts` lists the providers that have not
landed each step, and this section describes their current shapes.
`test/provider-standard.node.test.ts` holds every other provider folder to the
standard, and `test/provider-conventions.test.ts` checks the surface rules on
both runtimes. `providers:generate` writes the standard's derived parts and
refuses a provider past step 1 that breaks the `drift.json` rules, or one past
step 2 that breaks the guide rules: `drift.json` version 2's `generated` block
(operations from the kit's `ProviderKitFacts`, hosted names from the reviewed
classification, evidence digests), and a guide's `## Conventions`, rendered
from the definition's declarations into `skill.generated.ts`.
`ProviderContext.usageGuide` selects a guide's `<!-- when: <key> -->` blocks
with the definition's `blocks`. `providers:check` reads both record versions,
reports a manifest operation no endpoint row records at the provider's level,
and lists manual checks last verified more than 180 days ago. Its offline
record validator, `scripts/drift-validate.mjs`, also gates `providers:generate`
and the standard suite, so a record they accept is one `providers:check` reads.

The generic REST connector (`src/providers/_shared/rest/`) serves
`<vendor>_api_search`, `_api_details`, `_api_read`, and `_api_write` over an
`OperationIndex` that `pnpm run providers:spec` compiles offline from the
provider's pin (`evidence/openapi.json`; `openapi.source.json` until its step 1)
into `openapi.generated.ts`. A `vendored: true` pin compiles the reviewed
conversion in `evidence/openapi.document.json` instead of fetching, and the
generated header records that document's digest beside the pin's, so the
offline freshness check sees a changed conversion.
Each call is matched to an operation and checked against its parameters before
transport; `_api_read` admits GET and the vendor's reviewed read-only POSTs in
its handler, since classification is per tool name. Vendors configure only a
transport, failure mapper, scope, framing, cursor extraction, a reviewed
value-safety table (required; see below), argument-dependent refusals, and an
idempotency header, plus optional hooks: `path` (fill default ids before
matching), `admit` (an awaited check in `callRest` every tool passes, such as
Cloudflare's account and zone pin), `result` (unwrap a vendor envelope;
redaction runs after it and before cursors and `select`), a reviewed
request-header allowlist, text bodies, and index `slashParams` that admit an
encoded `/` in a final key segment (`test/rest-connector.test.ts`).
Large documents opt into generator options that drop restated operation ids
and plain path parameters and cap one operation's details (`opBudget`).
`check:providers-generated` checks each index header against its source record
offline; `providers:check` reports a pin that differs from the live document.
No maintained provider selects an implementation with `surface` any more. See
the
[provider auth migration](./provider-auth-migration.md). Notion's token
connector keeps its `integration_*` projections and authoring helpers beside
the generic REST tools.

#### Value safety for REST vendors

The bar ([decision 0005](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)):
no REST tool response, success or error, returns a credential that grants
access to the vendor or a third party, or a stored secret value, unless a
reviewed named tool exists to return it. The threat model is Infisical's
above: an honest server, with secrets people type into free text out of
scope. Field-by-field redaction over a whole vendor API does not converge, so
every vendor ships one reviewed table through one mechanism
(`src/providers/_shared/rest/value-safety.ts`):

1. **Candidates from the pinned spec.** `scripts/value-safety.mjs` flags every
   operation whose success response names or describes a credential, keyed
   value, header, environment, or binding container, or whose path, id,
   summary, or description names a secret family (tokens, secrets, keys,
   signing, webhooks, drains, transfer, claim, and invite codes). It is the
   union of the detectors Cloudflare and Vercel shipped first, and
   deliberately over-inclusive. `providers:spec` writes
   `evidence/value-safety.json` (`value-safety.candidates.json` until the
   provider's step 1) when the source record sets
   `options.valueSafety` (vendor `operationWords`; Stripe's `expansions: false`
   skips id-or-object expansions, which are their own operations' candidates),
   stamped with the pinned digest, the detector format, and its options. The
   file is test evidence and never ships.
2. **One reviewed verdict per candidate**, in the vendor's `safety.ts`
   (`value-safety.ts` until its step 1):
   `refuse` (the generic tools refuse it before transport, naming the
   operation and the reason), `redact` (reviewed field paths), or `safe`, each
   with a reason. Paths are dot paths into the data a tool returns: a list on
   the way is traversed, `[]` and `{}`/`*` address list items and map values,
   `@keys` replaces secret map keys, `[?env]`, `[?credential]`, and
   `[?header]` filter list items, `url:` sanitizes a URL, and `origin:` (or a
   `#url` suffix) keeps only scheme and host. `keep` names reviewed metadata
   the heuristic leaves (children are still checked). A vendor whose objects
   repeat across operations (Stripe) reviews a field once in `fields`,
   `redact` or `keep`, wherever it appears, and states `resources`: rules
   keyed on the object's type discriminator (Stripe's `object`) that apply to
   every such object wherever a response embeds it (an expansion, a list, an
   event's `data.object` and its `previous_attributes`). A resource rule can
   return a reviewed payer-facing URL verbatim only while a declarative guest
   condition holds (deny by default: a Checkout page only when every field
   that can bind the session to a Customer, an Account, or saved payment
   methods is empty and the session only takes a payment) and withhold it
   otherwise. `providers:spec` derives the binding fields from the pinned
   schema, and the harness fails until the condition lists each one. Argument-dependent refusals (Stripe expansions,
   Vercel `decrypt`) stay in the vendor's `refuse` hook.
3. **Redaction on every success body**, in `callRest` after `result` and
   before cursors and `select`, so named tools, HEAD data, and uploads pass
   through it too: the operation's reviewed paths, then the key-name
   heuristic as defense in depth. The heuristic is the union of the former
   vendor engines: a credential word anywhere in a non-metadata name removes
   the value whole, a credential suffix removes the strings below it,
   labelled or typed secret records lose their value, environment containers
   lose their values, header, cookie, and query rules lose theirs, external
   destinations keep their origin, and every URL loses userinfo and
   credential-named query parameters or fragments under its URL policy.
   Exemptions are never shared; each vendor states its own. Every REST vendor
   reviews the pinned spec's free-text fields for embedded vendor-minted links
   and records its verdict and source limitations beside its value-safety table.
   Stripe, Vercel, and Cloudflare use **reviewed paths plus global signing
   parameters**. Literal AWS SigV4/Google V4 `X-Amz-`/`X-Goog-` Signature,
   Credential and Security-Token values are withheld across all decoded string
   values. Generic credential names (`code`, `key`, `token`, `signature`, `sig`,
   etc.) and credential-looking fragments apply only to reviewed diagnostic
   paths and vendor error text. Matching destinations lose their entire query
   and fragment. The tables list exact operations/resource paths with evidence:
   Stripe charge failure/outcome messages, Vercel deployment failures and
   build/runtime log text, Cloudflare Workers/Pages build logs and telemetry
   message/error and raw string/object source payloads in both events and
   invocation maps. The shared review harness rejects embedded-URL operation
   keys absent from each vendor's pinned index and invalid path syntax.
   The current Vercel pin was reviewed from its full response document; its unversioned URL does not retain older documents.
   Generic parameters in descriptions, metadata, nicknames, billing footers,
   notes, DNS TXT, KV values and operator HTML retain their original bytes,
   including whole URL strings. Ordinary code/key URLs can be false positives
   in reviewed diagnostics. Existing structured-field/resource rules, reviewed
   `url:` per-parameter rules, and payer-facing exceptions still apply.
   Scans read the original escaped text before URL parsing or serialization;
   adjacent HTML or Markdown is text even without whitespace. Relative Markdown
   destinations are checked at their own query/fragment, without re-anchoring
   a nested proxy URL. Ordinary proxy parameters retain their bytes.
   Scans precede success/select/named projections and error mapping. Named
   Vercel streams use the same paths before clamping. Binary responses encoded
   as base64, including Cloudflare Worker JavaScript served as
   `application/javascript`, are returned unchanged, without decoding/scanning.
   Cloudflare omits an envelope cursor that URL sanitizing would change;
   ordinary cursors retain their bytes. No vendor-wide host/bucket policy is
   inferred. Each string is scanned with bounded linear passes over disjoint
   destinations, including large inputs.
   These three vendors enforce write admission with the shared
   `carriesWithheldLink(value)` scanner and `refuseWithheldLinks`/
   `refuseWithheldUpload` helpers, plus `refuseWithheldBase64` for documented
   base64 JSON fields. Every supported write transport (JSON,
   form-encoded, raw/base64 bytes, multipart parts and named writes) refuses
   with `invalid_args` and zero dispatch when a URL destination's own query
   or fragment contains the exact `[redacted]` placeholder, plain or up to four
   layers encoded. Upload admission reads decoded bytes and each multipart
   string/blob. Vercel deployment `files[].data` with `encoding: "base64"`
   and Cloudflare KV bulk `value` with `base64: true` pass through the same
   byte inspection with one decode, bounded by the field's own encoded length
   (decoded bytes are at most three quarters of encoded characters). Cloudflare
   KV additionally enforces its documented 25 MiB decoded value limit;
   malformed base64 and values beyond that limit refuse with `invalid_args`.
   The host's inbound request cap still applies (Node `maxBodyBytes`, or the
   Workers platform); response and raw-upload limits do not bound JSON fields.
   JSON admission iteratively checks every key and value, with no separate
   depth or node-count ceiling below the accepted request's size. Cyclic
   direct arguments refuse with `invalid_args`; repeated non-cyclic references
   are inspected. The scans remain linear in the supplied and decoded bytes.
   Withheld values must not be written back; obtain the original
   link or omit the field. A placeholder outside a destination is ordinary
   text. Notion keeps its stricter reviewed-host admission and proxy policy.
   Vendors whose responses embed the file links they mint can
   use `withholdSignedLinks(text, hosts)` or
   `withholdSignedLinksIn(value, hosts)` with a reviewed `FileHosts` policy
   (`domains` and S3 `buckets`). Notion applies the latter in its `result`
   hook and before mapping errors, so Markdown, async task results, paging,
   named-tool results, and `select` all pass through it. The linear scan
   matches only the current URL/destination's actual authority: a reviewed
   domain or subdomain, or a reviewed S3 bucket, virtual-hosted or exactly
   the first path segment on an S3 endpoint. A secondary scheme or `//` in
   another URL's path or query cannot re-anchor it; those proxy links keep
   their bytes. Schemes and slashes may be escaped. File links lose their
   whole query and fragment from a literal, percent-, entity-, or
   `\u`-encoded opener through the next whitespace, quote, or angle bracket;
   trailing closing punctuation comes back. AWS SigV4 and Google V4
   `Signature`, `Credential`, and `Security-Token` parameter values are
   withheld wherever their literal signing names occur, at any host, with
   plain or encoded equals signs. `carriesWithheldLink(value, hosts)` is
   the shared write-admission helper: Notion refuses a write before dispatch
   when a file link's own query/fragment carries the exact `[redacted]`
   placeholder, plain or up to four layers encoded. Admission resumes at
   each actual Markdown destination's close, including adjacent links and
   images and balanced/escaped parentheses; leading spaces, tabs, and one
   line ending before the destination are recognized. A marker after the close is
   ordinary text. This boundary is independent of redaction's fail-closed
   span. Each string is scanned alone; split rich-text runs, encoded hosts
   or signing names, bare hosts without `//`, and userinfo before a reviewed
   host are outside this scan's threat model.
4. **Errors.** A reviewed operation, or an unreviewed one whose request
   accepts a credential-named field, answers failures with the vendor's codes
   and status but not its text, unless its verdict is wrapped in
   `vendorErrors()` because a review found its errors cannot echo a stored
   secret. Credentials Connecta sent are always removed by the sent-secrets
   matcher.

`providers:spec` (run under tsx) also checks the table against the pinned
spec: every `redact` path and `keep` must name something the operation's
response schema can return (through `options.valueSafety.dataRoot` for an
envelope such as Cloudflare's `result`), and every resource rule path
something the resource's schema can return. It stamps the paths that resolve
into the candidates file and fails on the rest, unless the table's `absent`
field (`value-safety.absent.json` until the provider's step 1) acknowledges
them with a reason (shared verdicts applied to operations whose schema lacks a
path, or fields a schema leaves undeclared; such paths still apply at
runtime).

`test/fixtures/value-safety.ts` is the shared harness each vendor's
`value-safety.node.test.ts` (`provider.safety.node.test.ts` after its step 1)
runs; `reviewProblems` is pure, and
`test/value-safety-harness.node.test.ts` proves wrong paths fail it. It fails
on candidates from another pin, format, or option set; an unreviewed
candidate; a verdict for an operation the index lacks; a table path the stamp
lacks (unresolved, or edited since `providers:spec`); a flagged field no path,
keep, field review, or scope map covers; a flagged field, built in the shape
the pinned schema gives it, that survives redaction or that no redact path
reaches; a keep that exempts anything below it or a vendor-wide keep of a
credential name; a redact path or resource rule that leaves its value at the
top level, in a list, an expansion, or an event; a refusal that reaches
transport; a reviewed operation that echoes vendor error text; and a moved
verdict count.
`RestVendor.valueSafety` is required, so a new REST vendor cannot ship without
a table.

`remoteMcp({ classify })` is the public way to declare what a downstream's
tools do: `{ tools: { name: "read" | "write" | "destructive" | { verdict,
reason?, schemaDigest?, optional? } }, unlisted?: "hide" }`, validated at construction. It fails closed
(INV-1): a reviewed read fills silence but yields to an explicit write
annotation, a reviewed write stays a write whatever the downstream claims, an
unlisted tool is a read only when it says so, and a reviewed tool whose
`schemaDigest` no longer matches, or cannot be checked, is a write on discovery
and every invocation path until a release reviews it again. A digest covers
the whole schema; one too large to hash whole is unchecked. `unlisted: "hide"`
removes every unreviewed name, even an explicitly annotated read, on every
registry read, including persisted catalogs. `remoteMcp` also refuses direct
calls to unlisted names before authentication. Tool classification does not
authorize targets; providers such as GitHub check arguments and configured
scopes separately before minting credentials.

Connectors report facts; the registry is the only classifier. A reviewed
connector carries its review as data, the deep-frozen
`Connector.classification`, and its `listTools` returns the downstream's
listing unclassified. The registry validates the field when it first reads a
connector (INV-11) and classifies the intake-redacted facts on every read into
fresh objects. Remote MCP caches the underlying SDK response before connector
decorators; decorators run again on every read. Neither a cache layer nor a
decorator holding a served or listed tool can carry a verdict. The request-scoped catalog also owns a deep copy
and returns fresh copies to discovery and invocation. Each connector call
receives a separate deep copy of its definition, so mutations cannot change
classification, schemas, or write accounting later in the same program.
A restart applies the current review to cached SDK facts. Retired registry
manifest versions 2 and 3 are ignored and expire on their original TTL.
During listings the registry counts drift against the same record. Optional
reviewed tools do not count as unserved when gated out. Reports carry an explicit
reviewed-baseline fact, counts of live reviewed tools with and without schema
pins, and complete/unavailable schema verification. A digest failure replaces
the previous observation rather than retaining a stale clean result (INV-1,
INV-6). Observation and classification share the same verification result for each
listing; classification still fails closed.

Reports are in-memory only, weakly keyed by connector and a registry-owned
catalog partition token. The partition uses the same admitted principal,
subject, caller identity, authenticated flag and pool as catalog caching, plus
connector id and endpoint URLs. Personal registries do not share tokens with
each other or the root. Each registry retains at most 1,024 tokens; eviction or
restart yields no observation, never another subject's counts. No new storage
key or durable catalog record is introduced.

New schema pins use `sha256-sets-v1:<hex>`. Canonicalization sorts object keys
and schema `required`, `enum`, and `type` arrays, including schema-valued
legacy dependencies. Tuple arrays and JSON data
inside defaults, constants, enum members and examples retain order. Existing
`sha256:<hex>` pins continue using the original key-sorted, literal-array
algorithm; their reviewed digests are unchanged. Migrating a legacy pin requires
reviewing the complete schemas and recording a new versioned digest. Legacy
pins may still report conservative drift for array reordering until migrated.
The iterative digest retains the whole-schema node ceiling in both formats.

Contributor evidence: `test/provider-schema-pins.test.ts` checks every provider
construction case in the generated roster. Every pinned digest requires a
complete captured schema that passes runtime verification; changed input or
output schemas must fail it. The guard also exercises both digest prefixes.

The maintainer `scripts/drift-check.mjs` compares published inventories with
provider evidence. Table inventories can require `inventory.accessColumn` and
record `reviewedAccess` (`read` or `write`, with destructive verdicts recorded
as write). These access snapshots must agree with the provider's runtime
classification. A documented access change or disappearance of a reviewed explicit Access
value is advisory drift, never an
automatically accepted verdict. An explicit access value makes an
`acknowledgedUnclassified` entry stale: report it and resume reporting that
unreviewed tool as an addition. Missing tools and already reviewed names also
invalidate such acknowledgements. Duplicate explicit access values must agree;
a blank duplicate does not erase an explicit value elsewhere. Missing required
columns in any tool table, unknown access values and conflicting rows are provider-local parser
findings. The internal `withVettedCatalog()`
helper has been removed. Public provider `*_VETTED_CATALOG` exports remain
deprecated aliases derived from each definition
(`test/classified-decorators.test.ts`, `test/hosted-presets.test.ts`).

Wrappers must forward `classification` to keep the review. `{ ...connector }`,
`Object.assign`, and `Object.create` keep it. A forwarding class that omits it
serves an unreviewed connector: the downstream's annotations are its own
claims and fail closed when absent, and nothing it persists carries safety.
Phase 2's deployment-level classifier overrides, keyed by connector id and
tool ([#706](https://github.com/zackbart/connecta/issues/706)), apply
regardless of wrapping.

#### Characterization goldens

Every maintained provider with an `api()` surface has goldens under
`test/goldens/<provider>/`: the oracle a provider migration must match byte
for byte. `catalog.json` holds the connector metadata, the rendered guide,
and each tool's name, description, schemas, and annotations. `calls.json`
holds at least one fixture call per tool, then an echo call: the exact
requests sent (method, URL, sorted headers, body), grouped into causal
steps, and the agent-visible outcome. `failures.json` drives one read and
one write through 400, 401, 403, 404, 409, 422, 429 (with `retry-after`)
and 500 responses, a 401 whose message echoes every sent secret, a refused
connection, and a transport timeout (a `TimeoutError` after the request
left). `setup.json`, for a provider whose spec completes an OAuth consent,
holds the consent's steps. Calls run through `Registry` and
`InvocationService` with a real credential vault, so the outcome is what
`call_tool` returns before MCP rendering.

`test/goldens/<provider>/spec.ts` says only how to build the provider and
which calls to make, including an `echo` call whose vendor reply carries the
text the harness passes. `test/goldens/harness.ts` owns everything else:

- The fake network records each request as `new Request(input, init)`
  builds it, so `init.headers` replaces a Request's headers as Fetch does,
  and a body gets its implied `content-type`. Form bodies are recorded as
  fields when they re-encode to the exact bytes sent; FormData as its parts,
  with the runtime's boundary as `<boundary>`. A JSON body is recorded as
  `json` alone only when it is exactly that value's compact serialization;
  any other spacing, key order, or escape also keeps the exact `text`.
- A step loop drives each scenario under fake timers. It drains microtasks,
  fires timers due now synchronously, and waits for request construction and
  counted real work to finish. Newly waiting requests form one step, sorted
  by method, URL, headers, and exact body. The loop releases **one answer at
  a time**, running to quiescence after each. Previously recorded requests
  keep release priority over new requests. Every capture runs twice: canonical
  cohort release order and reverse cohort release order, each with its own
  fresh module graph, clock, network and cache namespace. Queue replies are
  assigned in canonical request order in both runs; only answer delivery
  changes. Steps remain readable admission cohorts, not simultaneous answers.
  Both orders must match the oracle. Identical observations collapse to one
  row; differing reverse observations appear in `variants`, each with
  `order: "reverse"`, complete `steps`, optional `waitedMs`, and `result`.
  Setup uses the same rule, with `{ steps, variants }` only when orders differ.
  This bounded two-order model deliberately does not enumerate all interleavings.
- Every request records integer `after`: the number of answers delivered
  when the provider called fetch, before harness jitter or body inspection.
  It identifies a prefix of that run's release sequence; it includes auxiliary
  requests and resets for setup and invocation. The canonical run releases
  each cohort forwards, the reverse run backwards, with older cohorts first.
  For concurrent A and B, C awaiting only B and C awaiting both have canonical
  `after: 2`, but reverse `after: 1` and `after: 2` respectively. The differing
  variant preserves that dependency. One integer per request keeps frontiers
  linear, including a 300-page sequential call. A write sent before login and
  a write duplicated concurrently or sequentially also differ.
- Distinct queued replies for indistinguishable concurrent requests are a
  fixture authoring error: the harness rejects them with a diagnostic. Use
  identical replies or a request discriminator the provider controls. The
  arrival order of identical requests cannot assign distinct responses.
- `test/goldens/setup.ts` installs source dispatchers before a golden test
  file imports any provider, connector or Effect module. `vi.resetModules()`
  and dynamic imports refresh those graphs for each capture and release order.
  The dispatchers retain their identity across captures: saved and prebound
  functions, and functions captured by Effect, still consult the current
  capture. Their defining prototypes are wrapped too. Native implementations
  remain private to the source controller; outside captures the dispatchers
  delegate unchanged, preserving Vitest's real clocks and runner timeouts.
- The supported asynchronous model is explicit: fake fetch answers; fake
  timeout, interval and immediate timers, including `AbortSignal.timeout`; Web Crypto's promise-returning
  subtle methods; Request/Response/Blob body reads (`arrayBuffer`, `blob`,
  `bytes`, `formData`, `json`, `text`, where present); default stream-reader
  `read`/`cancel` and stream `cancel`/`pipeTo`; and promises/`queueMicrotask` chains rooted in those sources or
  synchronous work. Effect's scheduler and sleeps use the same microtasks
  and fake timers. A synchronous TextDecoderStream pipeline is supported.
  Timer delays must coerce to finite nonnegative integer milliseconds within
  the signed 32-bit timer range; other delays poison the capture. This keeps
  Date and nanosecond clocks integral. New host asynchronous sources must be
  registered and counted before use.
  Native CompressionStream/DecompressionStream, `scheduler.wait`, and
  native socket/worker/event-source constructors are rejected explicitly,
  including when their errors are swallowed by a provider. CompressionStream
  async iteration bypasses the reader-method spy and cannot establish
  quiescence. No golden may silently bless that path.
- A no-stimulus audit follows declared quiescence: request, counted-work,
  timer, or call-settlement progress before an answer or clock tick fails
  with an unsupported-source diagnostic. Waiting without a request, counted
  work, or fake timer also fails. The audit is a secondary assertion: source
  control starts at module load, and supported host promises and microtasks
  are counted from entry through completion. Quiescence requires zero active
  counted work, zero queued controlled microtasks, and no due timers; future
  virtual timers are explicit harness stimuli. Unregistered native producers
  are unavailable or throw, including saved constructors and swallowed errors.
  `process.nextTick`, `process.uptime`, `Atomics.waitAsync`, native messaging
  constructors, and performance timeline methods are unsupported. The
  test-only `golden-source-boundary` transform rejects Node host-module imports
  in provider graphs and rejects lazy module loading during scenario work,
  before either can capture native references or schedule uncounted I/O. Only
  the harness's fresh-graph loading phase admits test fixture imports.
  Invalid captures cancel and drain their concurrent fake requests.
- The network answers in zero virtual time. Before advancing to the next
  timer, the loop requires eight quiet real event-loop turns and an audit.
  A row records nonzero `waitedMs`, the virtual time spent on provider
  timers. Elapsed-time readings count only those timers. A timer of 0 ms
  set outside a timer callback is due at once and stays in the current
  cohort. Unjoined timers at completion fail. Since `AbortSignal.timeout`
  cannot be cancelled, remaining signal deadlines fire during teardown, outside
  `waitedMs`; any resulting request or result mutation fails. Every successful
  drive and scenario boundary has zero outstanding controlled work and timers.
- Auxiliary routes answer token exchanges and other requests that are not
  the tool's own, and are recorded by name with headers and body. A JWT in a
  header or field is recorded as its decoded header and claims, with
  `<signature>` for the per-run signature.
- `setup` runs before each scenario; its requests must be identical in
  every scenario and are recorded once.
- Determinism: a fresh fake clock per scenario (timers, `Date`, and
  `performance`, and Node `process.hrtime`/`hrtime.bigint`, starting at
  2026-01-02T03:04:05Z), counted
  `crypto.randomUUID`, and fixed `crypto.getRandomValues` and `Math.random`,
  all restarted per scenario. `create(scenario)` receives a slug unique in
  the process: the scenario name plus a per-capture suffix the goldens never
  show. Load-time hrtime dispatchers also control Effect wall and monotonic
  nanoseconds on the virtual clock. Default-date Intl formatting also reads
  the virtual wall clock.
  A process-wide cache (Google's delegated tokens) never carries
  over from an earlier scenario or capture.
- Secrets: every credential field and secret becomes `<secret:field>`, with
  HTTP Basic shown decoded. Before that placeholdering, the harness fails
  the capture if any secret reaches a caller-visible result (INV-5). The
  guard decodes the result itself: JSON escapes, percent escapes in either
  hex case, and base64 or base64url at any alignment, up to three layers
  deep. It also finds any start of a secret that reaches 12 characters past
  its public framing, so a truncated echo is a leak. Framing is a PEM armor
  line and the DER structure that opens every key of its type (tags,
  lengths, version, algorithm identifier), which guides and example keys
  print. A later fragment, a shorter one in any encoding, or a secret with
  its case changed is not detected. A base64 run is decoded only from 11
  characters (8 bytes), shorter than the base64 of any start the guard
  looks for.
- The echo call carries every secret not listed in `unsent` in each
  encoding redaction covers: raw, percent-encoded with upper- and lowercase
  hex, base64, unpadded base64url, and `\uXXXX` escapes with upper- and
  lowercase hex, plus the base64 of each `basic` pair. Every sent secret
  contains `/`, `+`, and `=`, so its percent and base64url forms differ from
  its raw and base64 forms. The `401 echo` case echoes the raw secrets only.
  Some providers cap a vendor message before redaction sees it (Google at
  500 characters), and a cut through a secret would leak its start.

Object keys keep the order the provider produced. A migration changes the
provider, never the spec or harness.

`test/goldens.test.ts` compares on both Vitest projects and fails if a
provider folder is neither covered nor listed as remote-MCP-only, a tool
has no call, or a golden file is missing or extra. It never writes.
`test/goldens-harness.test.ts` proves the harness catches the mutations it
exists for: Authorization moved onto a Request that `init.headers`
replaces, an emptied, respaced, or reordered Infisical login body, a write
sent before the login is answered, a write sent twice at once or in turn,
and sent-secret redaction disabled or missing its percent, base64, or
base64url forms. It checks the leak guard against each encoding directly
and against PEM framing. A Planning Center request delayed by its
provider's own 0, 1, 5, or 50 ms timer must give one capture under seven
schedules. It also captures every spec twice in one process with seeded
scheduling jitter (requests delayed by microtasks, timers due now, and real
work before request inspection; both answer orders tested independently) with
committed seeds 1 and 2 (`CONNECTA_GOLDENS_SEEDS=3,7` adds seeds) and compares every file for every spec
with the stored goldens. Partial-dependency mutations run under ten seeds,
and saved immediate/timeout/abort-timeout, Effect scheduler, prebound crypto,
prebound performance/Date/hrtime, module freshness, runner timing, unsupported
sources, ambiguous replies, and cross-capture nanoseconds run on both projects.
CI uses two characterization tiers. Every PR runs byte comparisons of every
provider on both runtimes: Node captures fresh forward and reverse module graphs;
Workers captures a fresh canonical graph and compares only the stored canonical
observations. Projection removes variants only at harness observation positions,
never from vendor results or schemas. Both tiers retain load-time source controls
and runtime-independent mutation/source checks; always runs one seed per check.
The reverse-only C-awaits-B-versus-both mutation runs on Node in always and on
both runtimes in full. Planning-only PRs run these suites too.

The full tier repeats all provider captures and the complete jitter matrix on
both runtimes, including Workers reverse order. It runs on every main push and
on PRs changing provider, connector, HTTP, storage, golden/harness, fixture,
Vitest, dependency or selector inputs. The selector derives transitive core
imports using TypeScript parsing and module resolution. Unknown paths or
dependencies and classifier errors select full; every step-1 provider migration
selects full. The `changes` job exports `goldens` to both runtime jobs through
`CONNECTA_GOLDENS_TIER`. Only `always` reduces the tier; local unset/invalid
values run full, retaining the complete `pnpm run check` gate.

JWT fixture specs import fixed, public throwaway RSA PEM keys, with an
import/sign/verify self-test. This avoids expensive key generation on every
fresh module evaluation without changing characterized JWT claims or bytes.
The harness never caches evaluated module graphs. Global controls prohibit
`it.concurrent`; parallelism must use isolated files/workers. Transformed code
may be cached.

`pnpm run goldens:update [provider...]` rewrites the named goldens (all
when none are named) on Node; it is not part of `check`. A PR
that changes agent-facing output on purpose regenerates the affected goldens
and says why in its description; any other golden diff is a regression.

## Optional deployment modules

`createConnecta` takes closed typed `ui`, `vault`, and `activity`
slots, with factories at `/ui`, `/credentials`, and `/activity`
and agent tokens at `/auth/access-tokens`. Root exports the contracts, never the implementations, and there
is no module array, runtime registration, or plugin lifecycle. Core keeps
discovery, the executor contract, invocation, permissions, and OAuth callback
verification; an omitted module contributes no runtime work at all.

The operator UI — `src/ui.ts` (data-free shell and `/ui/data` payload),
`src/routes/ui.ts`, `src/operator-ui/` (the React app, owned Radix primitives and its pure rules) —
shows a human what a deployment exposes and manages only the authentication
material code explicitly permitted; it never edits the connector set, catalog,
annotations, scopes, or permission rules. Two invariants shape it: a status read
never starts authorization, since OAuth begins with an explicit authorized POST,
and each lazy details request owns a bounded downstream scope, so one failing
provider leaves the other connections usable. A connector's status message
never reaches the page: it can quote a downstream error body, and that body can
quote the secret it rejected, so the details payload carries only a classified
`problem`, which picks fixed on-screen copy and a fixed fix prompt. Server
logs contain only checked failure records, with no raw text. OAuth and
credential Test notices keep the same rule: those routes answer failures in
fixed words (a Test answers only `{ ok }`), log checked facts, and let the page
pick a sentence by outcome. Credential handoff URLs exist only while the UI is
mounted; OAuth callbacks never need it.

Its appearance is one token layer, and it is not the UI's alone: every page
connecta shows a person — the operator shell, the OAuth callback, a browser's
404 — reads it. `src/operator-ui/tokens.css`
resolves every color, radius, and font through a custom property and mixes the
rest from those with `color-mix`; `page.css` holds the base typography and the
pieces server-rendered pages share (top bar, buttons, badges, messages, the
one-message status page). The UI's `browser.css` imports both, then one file
per area under `src/operator-ui/styles/` (fonts, shared components, shell, and
each page). The build writes the shared CSS, minified, into
`src/page-styles.ts`, with the hashed font paths, a module that core imports
without the UI bundle, so an OAuth callback still renders with the UI omitted.
Those pages link the fonts only when the UI module serves them.
`renderPage` in `src/branding.ts` is the one layout: head, favicon (the default
is linked only when the UI serves it), `data-scheme`, the tokens with the theme
after them, and the masthead. So `branding.theme` only has to append a `:root`
block after the stylesheet. The five tokens it accepts are gated in
`src/branding.ts`, each by a narrow syntactic check: deployment config reaches a
`<style>` element here, and an unvalidated value would be CSS injection. The
dark palette is the same tokens under `prefers-color-scheme`; `colorScheme` pins
one with a `data-scheme` attribute on the page.

Maintained providers act as the caller downstream. `src/connector-caller.ts`
attaches the admitted identity beside the request-scoped context, readable only
by in-repo code and set from authorization, never arguments. Google Workspace
domain-wide delegation
(`src/providers/_shared/google/`, first consumed by `./providers/gmail`) hands the
admitted identity to a deployment-config `subject` function and mints a
service-account token as whatever Workspace address it returns. The caller
carries whether an inbound provider _authenticated_ it: an open deployment
admits everyone as the anonymous actor, and the function is never asked about
them. It also carries the admitted pool's `owner`, which core copies from
config: an agent acts as it, before and instead of the function. In a pool
without one, the scoped registry view omits a mapping-subject connector for an
agent (`src/registry.ts`, keyed on the tag in `src/workspace-subject.ts`), as it
omits a personal connector, and the provider still fails closed if reached. A fixed `subject` address is every
caller's. No caller, an unauthenticated one, or no address fails
`auth_required` before any request leaves. The provider never chooses the account and a
deployment's own connector still cannot read the caller (PRINCIPLES.md, INV-3; `test/google-workspace-delegation.test.ts`). Its tokens live in a
bounded module-level map, in memory only, keyed by the key's own digest as well
as the account, subject, and scopes. A mint in flight is shared across requests
the way OAuth flights are: the owner settles a plain outcome
inside its own request — a token, Google's refusal, or `abandoned` — and each
follower waits on a promise of its own under its own signal and timer to the
flight's deadline, never touching the owner's signal or response.

## Import-graph purity

Nothing reachable from `src/index.ts` may import a `node:` builtin, so the same
core runs unchanged in workerd and in Node. The Node-touching paths — `src/node.ts`
(the `node:http` adapter), `src/sqlite.ts` (`node:sqlite`), and the QuickJS process pool
(`src/executors/quickjs.ts` plus its child) — each sit behind an explicit subpath
and must stay unreachable from the root. `./auth/clerk` is separate because
`@clerk/backend` is an optional peer rather than a dependency, and
`./auth/cloudflare-access` for a third reason: it is Web-API-pure, but its trust
contract is specific to a direct Worker invocation carrying `ctx.access`.

`test/purity.node.test.ts` walks the relative-import graph and fails on any `node:`
specifier in a reachable file, or on any of those modules — plus the UI bundle,
encrypted vault, and activity implementation — being reachable at all;
`test/package-surface.node.test.ts` and `scripts/check-package.mjs` guard the same
boundary in the published tarball. The failure mode is not theoretical: one
convenience import of `node:crypto` in a shared helper stops the whole Worker
shape from building, in someone else's repository rather than this one.

## Effect inside

The core runs on Effect v4, pinned to exactly `4.0.5`; no API a deployment
touches does. `createConnecta`,
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
and `pnpm run check:declarations` fails if what remains names an Effect type.

### One runner

`src/runtime/run.ts` is the only place a fiber starts, and
`test/purity.node.test.ts` fails if any other file calls `Effect.run*`, `runFork`,
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
with the labelled timeout error _before_ interrupting it, so work that honors
the signal sees the same reason the caller does, and `fromSignal`, which turns
an `AbortSignal` into a failure to race against. Nothing runs Effect at module
scope, where a Worker may not start work, and nothing logs through
`Effect.log`: logging goes through the configured `Logger`, which is what
honors `logger: "silent"`.

There is no per-Connecta runtime. createConnecta resolves its configuration
into plain values once (`src/config.ts`), and nothing needs a service context
built from them. The request pipeline runs on no runtime, so `/health` and a
closed deployment's 503 keep answering after `close()`. A registry provides its
own `Storage` and `Logger` services (`src/runtime/services.ts`) to its programs
(`runOnPartition` in `src/runtime/storage.ts`), because a personal registry's
storage is the root's namespaced to its principal.

### What runs on Effect

| Area                                                                   | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests (`src/server.ts`, `src/routes/mcp.ts`, `src/routes/oauth.ts`) | One fiber per `fetch`, tied to `request.signal`. An `/mcp` request's admission permit and every `McpServer` it builds live in a Scope the response carries out, closed when the body ends, fails, or is cancelled, when the signal aborts, when its admitted-request lifetime ends in that request, or at once if the handler fails first. If workerd runs none of those callbacks, the next request reclaims only the expired admission record; it cannot close another request's Scope. The OAuth callback is uninterruptible: a single-use code's exchange and catalog invalidation are one commitment. |
| Admission (`executor-admission.ts`, `call-admission.ts`)               | Queued waiters are Deferreds settled by whoever removes them from the queue; a wait is one flat race of grant, Clock timeout, and signal. The uncontended path stays synchronous. Two controllers, as [#453](https://github.com/zackbart/connecta/issues/453) requires.                                                                                                                                                                                                                                                                                                                                    |
| One tool call (`invocation.ts`)                                        | One fiber: resolution, the read-only and schema refusals, admission, and the downstream attempt sit under a single `withDeadlineEffect`, whose expiry interrupts the call wherever it is. The permit is an `acquireRelease`; the connector call is `Effect.tryPromise` over the unchanged `Connector`.                                                                                                                                                                                                                                                                                                     |
| `execute_code` (`execute.ts`)                                          | One fiber whose Scope owns the run's signal and executor lease, so a result, a throw, the watchdog, and cancellation all release the lease and abort the signal the same way. The executor's `acquire()` and `execute()` stay Promises raced against the signal and `execute.watchdogMs`. Each guest host call is a fiber of its own.                                                                                                                                                                                                                                                                      |
| Discovery (`catalog-service.ts`)                                       | A request-scoped cache: one shared read per connector (`runtime/shared-read.ts`), settled by the read itself and carrying its own signal and the probe timeout whichever asker starts it. Each asker waits under its own deadline and signal, so one that times out or is cancelled fails alone, and the read is cancelled only once every asker has gone. Fan-out is `Effect.forEach` under the discovery concurrency.                                                                                                                                                                                    |
| Registry (`registry.ts`)                                               | The result stash is a program over `Storage`. Same-request catalog loads share one read the way discovery's do. Remote MCP caching uses the SDK ResponseCacheStore adapter over SQL-backed KV, with no cross-request catalog flight.                                                                                                                                                                                                                                                                                                                                                                       |
| Remote MCP (`connectors/remote-mcp.ts`)                                | Each request scope's state holds a Scope, each connection is a lease forked from it, and a connect in flight is a Deferred carrying the client it connected. Closing a session and the transport are each bounded to a second.                                                                                                                                                                                                                                                                                                                                                                             |
| Downstream OAuth (`auth/downstream-oauth.ts`)                          | A refresh flight is a Deferred. Preparation follows caller cancellation; after dispatch, the HTTP exchange owns a 20-second deadline and the grant commit continues through the runtime deferred-work hook.                                                                                                                                                                                                                                                                                                                                                                                                |
| Operator and activity data (`routes/operator.ts`)                      | Each JSON route is one program run by `serveOperator` behind the Promise `handle()`. Reads run under the request's signal; writes do not, so a vault write or OAuth disconnect that started reaches its cache invalidation.                                                                                                                                                                                                                                                                                                                                                                                |
| QuickJS pool (`executors/quickjs.ts`, Node only)                       | Each child is a scoped resource whose release sends SIGTERM, then SIGKILL after a second; crash respawn backoff is a `Schedule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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
- **The Node and browser leaves.** `node.ts`, `sqlite.ts`, the QuickJS
  child, runtime, and protocol, and the operator UI's browser app.

### Across requests

Organization-mode Clerk Backend API reads share only plain membership verdicts,
start times and sequences, active-call counters (16 per isolate, two per
identity), and a bounded 429 backoff timestamp. They never share a promise,
queue, signal, controller, or body across requests. A refused busy lookup is
not cached. Each admitted read owns its ten-second deadline and cleanup;
`finally` releases its counters after ending its upstream I/O, and the owning
request's abort handler also releases them idempotently if workerd discards the
pending continuation on disconnect. Membership cache
hits precede these bounds; see [organization admission](./auth.md#one-clerk-instance-one-organization-per-deployment).

Asynchronous work shared across requests meets only through a Deferred that the owning
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

**Catalog I/O belongs to its request.** Listings share work only within one
request and authorization partition. Independent requests may read the same
complete SQL cache entry, but never await another request's listing, retain
its client, or inherit its sent-secret set. A rotated cache generation makes
late publication from an invalidated request unreachable. Missing chunks,
expired entries, storage errors, or a failed page trigger a fresh complete
listing. A transient first-page tool-listing failure may use a complete catalog
within five minutes of expiry in the same auth partition. Partial walks and
auth or permission failures refuse fallback; resources require unexpired
inventories, and stale fallback cannot authorize post-entry auth recovery.

### Why not Schema or HttpApi

Both were measured and both lost. `effect` is imported through its barrel,
which defeats tree-shaking: the first conversion step measured about +20 ms
of Worker cold start for it, and that cost was accepted over deep imports at
every call site. The catch is that a module the barrel reaches is paid for in
full, however little of it is used. Effect Schema for config validation and the
meta-tool inputs came to about +62 KB gzip and +13 ms of cold start in the
root, for a validator no clearer than the hand-written schema in `src/config.ts`; the
meta-tool inputs stay zod, which the MCP SDK bundles regardless. `HttpApi` for
the operator and activity routes cost about +100 KB gzip on `./ui` and +130 KB
on `./activity`, and matching the wire format meant opting out of most of what
it does: unowned paths fall through rather than 404, a wrong method is a JSON
405, and the content-type and size checks run before a body is read. The root
entry currently imports only `effect` itself (`test/purity.node.test.ts`).
Effect 4.x is a long-term-support line, but its area barrels `effect/http`,
`effect/http-api`, `effect/schema`, and `effect/sql` are still tagged
`@stability unstable` and can change within it; only core modules such as
`effect/Schema` are stable. That is why Effect is pinned to one exact version
and every Effect upgrade is its own deliberate pull request. A deployment
that also depends on Effect, such as the Worker example's Alchemy stack, must pin the
same version to resolve a single copy. Connecta's own lockfile and packed
install are checked for one copy (`test/package-surface.node.test.ts` and
`scripts/check-package.mjs`).

The stable `4.0.0` release was re-evaluated on 2026-10-01 with
[`scripts/probes/effect-v4-evaluation.mjs`](https://github.com/zackbart/connecta/blob/main/scripts/probes/effect-v4-evaluation.mjs).
Run `pnpm run build`, then `node scripts/probes/effect-v4-evaluation.mjs output.json`.
The [raw observations](https://github.com/zackbart/connecta/blob/main/scripts/probes/effect-v4-evaluation-2026-10-01.json)
are synthetic Node requests and neutral esbuild bundles, not live-client or
workerd lifetime verification. Bundle figures add representative prototypes
alongside the current code; they do not claim savings from removing old code.

Two native input schemas with validation and JSON Schema rendering add 62,148
bytes gzip to the root, taking it from 303,083 to 365,231 against a 339,526
cap. Effect can reject excess properties when both decoding and rendering use
`onExcessProperty: "error"`; its default strips them. The generated schemas
still differ from the exact meta-tool goldens, including record rendering and
composed numeric bounds. A Schema replacement would need to preserve that
contract and memoized rendering. Both MCP SDK packages still depend on Zod,
so changing our inputs alone does not remove Zod from an installation.

A one-endpoint `HttpApi` prototype adds 106,634 bytes gzip to `./ui` and 106,453
to `./activity`. Even plain `HttpRouter` adds 45,324 to `./ui`, taking it to
130,023 against a 128,983 cap. Both default handlers return an empty 404 for a
wrong method and an unowned path; our routes need a JSON 405 for the former
and module fallthrough for the latter. Their `toWebHandler` also builds its
layer immediately and owns a runner, so adopting it would require proving
global-scope safety and preserving our scheduler and response-lifetime rules.
The existing Effect route programs keep those rules without this routing layer.

Effect's MCP server has a separate compatibility gate. Its `2026-07-28`
adapter accepted a stateless `tools/list`, but its `2025-06-18` adapter refused
a fresh request with 400. Initialization issued a session, and that session's
next request returned 404 on a fresh handler; Connecta served the same fresh
legacy list with 200 JSON and no session. The stable package exports no MCP
client, so it also cannot replace our downstream SDK and OAuth implementation.
[Issue #622](https://github.com/zackbart/connecta/issues/622) records the server
parity requirements. These measurements support keeping the current MCP,
validation, and routing implementations; stable v4 alone does not establish a
replacement's benefit or compatibility.

The core's cost is recorded rather than guessed. Against 0.24.4 the root entry
grew from 235,346 to 279,526 bytes gzip, the Worker example from 263,949 to
314,336, and each provider by about 36 KB, since each reaches Effect through
`remoteMcp()`. `pnpm run check:bundle` caps the deployed shapes (the root,
`./worker`, `./ui`, the operator UI assets, `./d1`, `./auth/access-tokens`,
the Worker example, and the other non-provider entries) against
`scripts/bundle-budget.json`. Per-provider entries are reported with their
size and change from baseline but not capped: every deployment already imports
the root, which carries the Effect core, so a provider's standalone bundle
counts that core a second time. An install carries about 53 MB of `effect`, with
no dependencies of its own.

## Where else to look

Beyond the modules already named:

```
src/
  server.ts           route ordering, HTTPS upgrade, security wrapper
  routes/             one file per surface; shared.ts holds the auth gate
  skills.ts           MCP instructions, the usage skill, connector guides
  catalog-drift.ts    reviewed classifications and the drift counts a refresh produces
  provider.ts         defineProvider(): the one maintained-provider shape
  activity.ts         optional history factory and best-effort recorder
  auth/               Cloudflare Access, clerk (optional peer), downstream OAuth (remote and static)
  executors/          the QuickJS pool and child (Node only)
  node.ts             listen() (Node only)
  d1.ts, sqlite.ts    the two storage drivers; storage/ holds the SQL core and key families
```

There are exactly two deployment shapes — `templates/node/`, which
`connecta init` copies with its container files, and `examples/worker/` — and
`test/deployment-shapes.node.test.ts` with `pnpm run check:examples` keeps both
compiling and configuring the real thing.

## Sharp edges

- **The root registry is shared; identity views are partitioned.** Public remote catalogs are shared only after intake redaction, keyed by the
  connector configuration. Private entries include the admitted principal and
  pool even for shared-auth connectors. Personal connectors use a bounded
  principal registry and transient results the authenticated subject. Putting a downstream client or credential on the wrong
  side of those lines is the highest-severity mistake available here.
- **Route order is behavior.** Moving a mutation route below the wildcard
  `OPTIONS` opts it into CORS preflight; reordering admission after auth makes
  the cheapest possible attack the most expensive request.
- **Call state rides beside the context, keyed on the object.** The caller
  (`src/connector-caller.ts`), admission permit (`src/call-admission-context.ts`),
  recovery facts (`src/call-recovery.ts`), sent secrets (`src/sent-secrets.ts`),
  the call's classification (`src/call-classification.ts`), the OAuth sealer and
  owner partition, and catalog-cache policy live in side tables keyed on the
  `ConnectorContext`. A `{ ...ctx }` copy is a new key and starts without any of
  them. In-repo code copies a context only through `deriveContext`
  (`src/derived-context.ts`): every table resolves the copy to its origin, so
  state recorded through either object reaches the other, and the copy keeps the
  request scope. `api()` hands handlers such a copy and never mutates the
  registry's context (`test/derived-context.test.ts`). A deployment handler that
  spreads its context still loses this state; decision 0009 (B.1) replaces the
  tables with `Context` services.
- **A write leaves once (INV-9).** `src/write-outcome.ts` owns the shared rules
  every transport applies to a write: `unknownOutcome` turns a retryable
  failure that may follow the downstream acting (a 5xx, a gateway's 502 to
  504, a lost connection or reply) into a non-retryable `connector_call_failed`,
  and `unsentAfterUnauthorized` reports a write answered 401, which is never
  resent whatever credential renewal meets. Both mark the error
  `writeOutcome: "unknown"`, which `classifyWriteOutcome` honors before any
  refusal provenance, so an authorization verdict reached after the write left still
  counts as unknown in program write accounting (`src/program-writes.ts`),
  whose result is then that verdict with its handoff, caught or not.
  `remoteMcp()` classifies by the invocation's verdict
  (`src/call-classification.ts`), falling back to `classifyTool`, and holds a
  write to one send per logical call, never per JSON-RPC message: `callTool`
  puts a dispatch record on the `tools/call` params under a symbol key (spread
  copies it; `JSON.stringify` drops it), the transport's `send` refuses a
  second message for that call whatever its id, and the tracked fetch refuses
  a second request within one message (the SDK's resend after a 401 or a
  step-up, a redirect hop) and fails a write answered with a redirect. Both
  layers refuse a missing record unless the active calls for that tool are
  all reads; catalog hints cannot overrule a served write verdict. Tracking
  loss gives a non-retryable unknown outcome, never a fresh write attempt. A write
  always gives the SDK a tool definition, so `callTool` never relists and
  resends it after a `HeaderMismatch` answer. `api()` OAuth
  (`src/auth/static-oauth.ts`), the Google Workspace client, and Infisical
  apply the same one-send rule to credential recovery. All maintained API
  provider failure mappers run inside `guardedFetch`. Each `api()` entry owns
  a fresh request ledger (`src/provider-call.ts`) on its derived handler context;
  further `deriveContext` copies share that ledger without sharing it with
  concurrent calls. Every guarded request records dispatch, response status,
  and provider-declared auxiliary status. Plain handler fetches and OAuth
  resource sends record their dispatch too; OAuth credential checks precede
  the resource dispatch record. Token exchanges, GitHub installation
  and repository binding lookups, token minting, and Cloudflare zone-ownership
  pin lookups are auxiliary: they cannot perform the logical resource write.
  No transport rejection proves a dispatched write unsent, whatever errno it
  names. One `fetch` call can hide several attempts: Node's fetch sends a
  request again after a 421 (even under `redirect: "manual"`) and after an
  HTTP/2 `REFUSED_STREAM`, both of which servers define as not processed, and
  an operator-installed dispatcher such as undici's `RetryAgent` can retry
  further. A refusal on the last attempt says nothing about the earlier ones,
  so connecta never reports a transport-failed write as known failed. A write
  is a known failure only on refusal provenance recorded where the evidence is
  observed, never inferred from an error code: (a) the ledger proves it never
  left, or (b) the downstream served an HTTP refusal, a 4xx other than 408
  (`refusedStatus` and `vendorRefusal` in `src/provider-call.ts`), under the
  provider's existing served classification (Notion's write 409 is a
  `conflict`). One helper, `servedRefusal` in `src/write-outcome.ts`, decides
  (b) for the ledger and for a transport outside one: a refusing status the
  provider reads as `unavailable` or a timeout (Stripe's 424) is not proof, so
  only a genuine idempotency key keeps such a direct write's retry. A 408 is a
  timeout, and a 2xx followed by a mapper, parser, or output-validation
  failure may have applied. `classifyWriteOutcome` counts a
  dispatched write `failed` only with that provenance (`answered`, or the
  error's private known-failure mark); a bare `rate_limited`,
  `invalid_args`, or `conflict` code is `unknown`. A downstream tool's
  `isError` is a read's answer only: for a write it arrives over a 2xx after
  the handler ran, so it is unknown and non-retryable, and its text stays.
  Refusal evidence holds only for its whole logical call. The invocation
  opens one per dispatch (`openLogicalCall` in `src/provider-call.ts`), and
  every `api()` and `remoteMcp()` `callTool` entered beneath it joins it
  (`enterProviderBoundary`). A served write's mark stands
  (`knownForLogicalCall`) only when at most one boundary was entered and the
  invocation entered that boundary's own `callTool`, or that of a maintained
  connector declared to delegate each call to one boundary
  (`delegatesEachCall`, GitHub). A boundary marks a write known only when
  every request it dispatched is proven unapplied, so the rule reads: known
  only if every request the logical call dispatched is proven unapplied and
  the failing request carries the refusal. A custom connector that composes
  calls, or that could send around them, never inherits an inner verdict; the
  invocation withdraws the mark and the write is unknown.
  Pre-dispatch refusals mark themselves: `api()`'s unknown tool and argument
  validation, `remoteMcp()`'s allowlist, connect, and any failure before its
  `tools/call` is sent, and GitHub's hosted target check and token mint.
  `remoteMcp()` applies the rule to direct and served writes alike: once
  `dispatch.sent`, a JSON-RPC error (`-32602` included), an unreadable result,
  or a failed output validation is unknown; only an HTTP 4xx (not 408) on the
  request is a refusal. A downstream's `input_required` is no proof either: a
  handler asks for input from inside its run, so a write's unsupported
  suspension (`src/invocation.ts`) and a direct write's failed relay
  (`src/downstream-input.ts`) are unknown and say to reconcile, not resend.
  The invocation finalizes every served write `classifyWriteOutcome` calls
  unknown before it adds advice: `retryable: false`, `writeOutcome:
  "unknown"`, and no grant-then-retry or correct-and-retry text, so a custom
  connector's code cannot advertise a retry. Advice to send again inside a
  provider's message (a rate limit's "back off before retrying") is named
  with `resendAdvice` where it is written; every verdict that makes a write
  unknown removes it (`withoutResendAdvice`), direct and served, while a read
  and a known refusal keep it. An authorization or credential handoff on an
  unknown write says to re-read the target before any fresh call instead of
  "retry the original call" (`src/authorization-handoff.ts`). Owning transport attempts is planned for decision 0009's B.2
  guarded `HttpClient`. Reads keep their retry advice. Every maintained
  provider declares (`tracksEveryRequest`) that its handlers send only through
  channels the ledger records; for an undeclared `api()` handler an empty
  ledger is no evidence, so its served write fails unknown once the handler
  has run. When the handler settles, `api()` closes the ledger before any
  decision: a resource request still waiting to leave (a sibling reading its
  credential) is refused before its credential read and again before send,
  and one in flight already counts as dispatched.
  `providerCallFailure` in `src/write-outcome.ts` finalizes the call once at the
  `api()` boundary, including handler-thrown typed errors. For a served write,
  no resource dispatch keeps the failure's own advice. A vendor's own 4xx
  refusal (a 4xx other than 408) is a known failure only when no other
  resource request was dispatched. Refusal provenance travels with the error independently of its
  code or wording, so a generic `connector_call_failed` refusal still counts
  as failed in program write accounting. Every other possibly executing
  failure is non-retryable with `writeOutcome: "unknown"`; authorization codes
  keep their handoff. The existing special handling of write 401s remains.
  A later refusal cannot make an earlier successful request safe to repeat.
  Provider recovery wrappers change wording through helpers that preserve
  verdicts and provenance; Google also retains its response phases and reasons.
  No operation hint (a whole-resource `PUT`, fixed cells, a content address)
  grants retry credit, direct or served. A served write requires
  reconciliation even with an idempotency key; direct transport calls
  without a served verdict can still prove repeatability, but only with a
  genuine key sent to a vendor that honors it (Stripe today, through
  `idempotencyHeader`): the REST write tool refuses an `idempotencyKey` that fetch
  would send empty after trimming or would not send at all (CR, LF, NUL, any
  other control character but tab, DEL, or a code point past Latin-1), as
  `invalid_args` before recovery is recorded, and `callRest` marks a request
  repeatable only for a key fetch sends as given.
  `providerCallFailure` (`src/write-outcome.ts`) is the one finalizer for a
  direct write's failure: the `api()` handler boundary, a guarded transport
  outside a call ledger, and every `remoteMcp().callTool()` write, direct or
  served (with its `tools/call` dispatch record as the ledger and the
  endpoint's HTTP status as the served verdict) all hand it every write
  failure. Guarded transports
  inside a call (`ctx.fetch`, the shared REST layer, Google) defer to the
  `api()` boundary. No identity passthrough or code filter runs ahead of it
  for a direct write. It recognizes every timeout and abort before any code
  filter: the caller's own signal (an `AbortSignal.timeout` included, and
  however the runtime's fetch reports it), an SDK or connecta deadline
  (`code: "timeout"`, an HTTP 408), and a timeout errno. Without a genuine
  key, such a write is unknown and non-retryable: a timeout keeps its code
  and `details.code`; the caller's abort becomes `timeout` or
  `connector_call_failed` with its reason as `cause` and its class and code
  in `details`. No invocation exists to report it as
  `write_outcome_unknown`. The caller's own abort reason still passes by
  identity for a read and for a served call, whose timeout passes through
  unchanged for the invocation to report.
  The catalog-driven `test/provider-failure-sweep.test.ts` checks every API
  provider/tool in both runtimes, fails on missing provider/tool examples or a
  dispatched failure bypassing the helper, and covers served write/read
  overrides with HTTP 503 and a connection reset after send. Local metadata
  tools prove zero sends; composite calls prove each distinct request leaves
  once. The round-5 cases additionally cover Docs creation with initial text,
  composite success followed by refusal, GitHub preflight failures, typed
  handler errors after successful sends, Forms cursor conflicts after 200,
  generic-code vendor refusals, auxiliary failures after resource dispatch,
  redaction of refusal errors, and concurrent direct-call ledger isolation.
  The round-6 cases cover a composite write's early refusal while siblings
  await credentials or are in flight, requests started after the call ended,
  connect-phase errnos with each body kind (all unknown for a write, and a
  direct read stays retryable), a request aborted with a refusal-shaped
  reason, an errno outside fetch's network error, and
  undeclared handlers whose untracked send precedes a typed failure. Each
  catalog case also checks that the ledger recorded every resource request
  the network saw, and the inventory that every API connector declares it.
  `test/write-evidence.test.ts` uses real refused, reset, and held sockets on
  both runtimes: a refused write is unknown and a refused read retryable,
  including a write aborted with another fetch's real refusal as its reason
  after the server read its body; `test/write-evidence.node.test.ts` covers a
  Planning Center POST that undici resends after a 421 to a closed listener, a
  DELETE that a `RetryAgent` resends after a reset, and a streamed body and a
  `Blob` with an overridden `stream()` that undici partly sends before its
  producer fails. Each has the server holding the write and reports unknown.
  Additional tests:
  `test/remote-mcp-write-once.test.ts` (real SDK transport),
  `test/api-oauth.test.ts`, `test/google-workspace-delegation.test.ts`, and each
  provider's `INV-9` tests.
- **Plain `ctx.fetch` is not confined to an origin, by design.** In an `api()`
  handler it is the global `fetch` plus sent-secret registration. It carries no
  grant: only `ctx.oauth.fetch` attaches the OAuth token, and only to
  `apiOrigins`, and every maintained provider sends through a guarded transport
  confined to its base URL. A custom handler is deployment code, which owns its
  destinations (goal 4); no agent program reaches `ctx.fetch`, so INV-3 holds
  below the sandbox, and a credential a handler sends is redacted from what the
  agent sees (INV-5). Confining it would need a declared origin list on every
  `api()` connector and would break handlers that follow a URL their API
  returned, such as a signed download. `test/api-oauth.test.ts` pins that the
  plain fetch carries no grant.
- **`close()` is idempotent and ordered.** Both admission pools, then the
  connector limiters, then the executor; Node's `listen()` calls it on
  SIGTERM/SIGINT.
- **Structural mistakes throw at construction.** A duplicate connector id, an
  invalid admission rule or limit, an unknown option at any depth, the old
  boolean `accessTokens` option, malformed or repeated `agents` or agents
  without `accessTokens`, a missing executor, or an executor without a
  lifecycle brand:
  all refuse to boot (`test/config.test.ts`, `test/registry.test.ts`). Starting
  in the wrong shape is worse than not starting.
  Shipped `/worker` and `/quickjs` executors carry a non-enumerable global-symbol
  brand that survives package duplication and bundling. Custom sandboxes opt in
  through `customExecutor(executor, { lifecycle: "self-managed" })` from the root
  entry and own their termination and cleanup. Plain upstream executors need
  the `/worker` adapter, regardless of constructor name.

## Operator data contract

The contract now lives in [Operator UI](./operator-ui.md#operator-data-contract),
including configuration provenance, live facts, activity disclosure, doctor,
and the browser implementation. [Optional deployment modules](#optional-deployment-modules)
keeps the module composition and request-lifetime rules here.
