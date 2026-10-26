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
cancellation. Grant use and the caller's wait belong to the call. Renewal
preparation is call-owned only until the first durable coordinator write
(the claim CAS) is submitted. Closing the call or request before
submission promptly refuses with "This call has ended…": no CAS, no token
request and no state change. Late read results cannot restart preparation.
Claim submission transfers renewal synchronously to the storage coordinator,
before CAS completion or token dispatch. The coordinator retains its own
35-second preparation deadline and then a 20-second deadline for the token
request and response body, followed by the fenced rotation commit. Neither
the call nor request signal controls this work after submission. A winning
claim proceeds to token exchange and commit; a losing claim follows existing
contention/adoption rules. The runtime passes completion to Workers
`waitUntil`. Cancellation cannot abandon a fenced claim or strand a spent
refresh token, and introduces no rollback or re-consent exception. A shared
storage CAS lease prevents independent isolates from redeeming the same
refresh token concurrently. The holder commits an accepted rotation by CAS
before releasing waiters, even after caller closure. Closing a call or request
still promptly ends that caller's wait.
For a shared remote MCP connection, the challenged response identifies the
call that owns renewal preparation. The connection and OAuth provider remain
request-owned; their longer lifetime cannot keep pre-claim renewal alive
after its initiating call closes.
Authorization-code exchange transfers no refresh ownership: its auxiliary
token POST and pending wait abort on explicit request revocation even when
the operation has only a `requestScope` and no external signal. A response
that arrives afterward cannot persist tokens. The callback route keeps its
existing uninterruptible ownership and does not revoke its own scope during
exchange; explicit operation revocation is a separate boundary. An aborted
code exchange can be authorized again without stranding a durable refresh
claim.
The closed call consumes no renewal result, marks no ledger entry renewed,
and sends or resends no resource request. This preserves a rotation after its
refresh token has been spent while keeping call capabilities revoked.
Contenders read the committed tokens or typed
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
writes and OAuth renewals from claim submission use it. Catalog listing and SQL cache
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

1. **Admit.** The fetch-native MCP route reads no body before auth on any endpoint. A request
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

`admission.requests.maxBodyBytes` bounds each MCP request body at `/mcp`,
`/mcp/<pool>` and `/agent/<pool>`. It defaults to 4 MiB (4,194,304 bytes).
This restricts bodies that previously reached the host's larger platform cap;
deployments needing larger MCP envelopes must configure the bound explicitly.
A configured value must be a positive safe whole number; invalid values fail
construction with their configuration path (INV-11). After authentication and
endpoint admission, core counts streamed bytes before any SDK or native tool
body reader. A body exactly at the cap proceeds through normal protocol
validation. Past the cap, core stops reading, cancels both stream branches and
returns HTTP 413 with JSON-RPC code `-33006`, `"MCP request body too large."`.
The response retains the request's existing admission lifetime and releases
the permit when delivery ends. Caller cancellation and the existing request
deadline also cancel stalled reads. `describeConfig().limits.requests.maxBodyBytes`
reports the resolved value and its `default` or `config` source.

The pre-dispatch `subscriptions/listen` classification keeps its 64 KiB ceiling;
a smaller deployment body cap wins. Authentication failures and private endpoint
refusals still read no body. This envelope bound does not change program size,
tool argument validation, write accounting or result limits.

The Node `listen()` adapter separately buffers requests before calling the core,
with its own `maxBodyBytes` option. Its default is also 4 MiB. It stops at the
first chunk crossing that bound and returns a plain HTTP 413 before auth;
core's authenticated refusal uses the JSON-RPC envelope above. The smaller bound
wins. To admit larger bodies on Node, raise both options deliberately. Workers
and hosts calling `connecta.fetch` apply core's bound after authentication,
subject to any smaller platform or proxy limit.

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
The [recorded observations](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/worker-disconnect-2026-09-25.json)
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
rely on runtime cleanup. The [recovery observations](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/worker-disconnect-recovered-2026-09-25.json)
also retain two inconclusive queue-handoff cases: concurrent client connections
reached different isolates and could not establish an abandoned queued waiter.
A [second trial using HTTP/2](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/worker-disconnect-h2-2026-09-25.json)
repeated the twelve passing core cases and verified queued cancellation with
request signals enabled. Even on one HTTP/2 connection, the no-signal queue case
crossed isolates and remained inconclusive. The Node and workerd regression
suites cover expired waiters, orphaned handoffs, and identity-safe late release
deterministically.

The [historical probe source](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/worker-disconnect.mjs)
and observations are retained in Git history, outside the current checkout and
npm package. The probe deployed a disposable Worker containing only synthetic
data, verified the served configuration, saved observations, and deleted the
Worker in `finally`. It used no `waitUntil`, which would change the lifetime
being measured. The production runtime build number was not exposed by the
deployment; these findings are tied to the date and flags above.

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
(`src/storage/sql-native.ts`) over a native Effect SQL execution service, so
every statement runs unchanged on each, and the same module carries the
activity table beside it. `src/storage/sql.ts` owns the Promise edges.
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
OAuth grant write and consent claim, the result stash, and initialization of the cursor signing key.

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
visible. Redaction replaces these values and their auth prefixes, mixed JSON
escapes, URL encodings, and base64/base64url forms with `[redacted]`.

Every redaction is one pass over a text projection of the whole value: string
and number leaves in serialization order, nested JSON strings parsed into their
own leaves, and errors' own fields (non-enumerable diagnostics and causes
included). The joined projection is matched once, raw and through each JSON
decoding layer, so a form split across adjacent leaves is found; each match is
replaced only in the leaves it touches, so public runs, links, annotations and
container shapes stay. The walk reads every field once, from its descriptor, and
returns what it checked. A caller's container stands only as verified plain
data: prototype `Object.prototype`, `Array.prototype` or `null`, no `toJSON` on
its chain, no symbol-keyed field, every field a data property it read (an
array's holes read through its prototypes), and nothing in it changed. Anything
else is a copy of writable, configurable data properties, so a frozen input
never throws, and every value returned is JSON data, a fresh built-in
`Uint8Array`, or an error copy: an error always, as its own class, with its
stack and every accessor its class defines read once into checked fields, its
`toJSON` shadowed unread and no function in a field; an object of another class
as plain data; an array that is not plain as a plain array of its indices; a
`String`, `Number` or `Boolean` wrapper as its primitive; a `toJSON` result,
called once and checked; a function or symbol as the placeholder; a typed array,
`DataView` or `ArrayBuffer` as a fresh `Uint8Array` of its bytes, which are
checked as bytes and, with the elements it held, as the numbers JSON shows for
them. The type table is in [auth.md](./auth.md). An own accessor is
never invoked: an object's copy leaves it out, an array index holds the
placeholder. A change copies the containers on its path on first write, so a
caller's value is never mutated. An array's non-index fields are never read:
JSON, which every exit and executor marshals with, never serializes them.
Facts kept beside a value by identity (failure facts, classifications, statuses,
Google's reasons and outcomes) register with `redaction-identity.ts` and follow
its copies, arrays' included.
One checker, `checked()`, matches every output-bound string under the whole
lattice: the projection's leaves as one lane, and alone each object key,
scalar, cursor claim, encoding Connecta produces and structural field;
provider lanes and bounded reads call it too. Its matching steps run nowhere
else. Only fixed
words are kept whatever was sent: envelope keys, MCP and JSON-RPC member names
and tag values, booleans under outcome names, and on an error its
classification code and a name its class is registered with in
`redaction-identity.ts` (the built-in errors, `DOMException`, and Connecta's
and the pinned MCP SDK's own classes, each with literals beside the class); a
number or string under any name is matched like any other, and any other error
name is a projection leaf like any field, joined with its neighbours, and
withheld whole as `[redacted]` when the lane changes any part of it, keeping
the copy's class. An accessor an error's chain defines is held on its copy under its
checked name. Exact relay states and connect links
Connecta mints and authenticates are kept whole: they hold only sealed state or
Connecta's own facts. Serialized JSON whose keys, syntax and leaves together
hold a run of a form that no single leaf holds is withheld whole.

The guarantee: **no caller-visible text holds a registered form whole, nor any
run of K = 8 consecutive UTF-16 units of a registered form of a value at least K
long, in the raw text or any JSON-decoded layer; text cut where the cut can end
inside a form loses that unfinished tail, however short.** Registered forms are
the raw value, its URL/form encodings (either percent hex case), base64 and
base64url, and the `Bearer `/`token ` framings. The framing words are public, so
no indexed run starts inside them; a run reaching K units of the value is
indexed from the value's own forms, and an echo carrying the framing is
replaced with it. A private value of one to three units is matched only as a
whole field value (a leaf, key, number, boolean or decoded view equal to one of
its forms); one of four to seven units also as a substring of payload text,
numbers, keys and decoded views; one of K or more also by every K-unit run.
Pieces shorter than K are found only where they are adjacent: in the joined
projection or one provider lane (one Slides shape's text runs, one Docs document). Non-adjacent pieces shorter than K, such as
two seven-unit halves of a value in two Slides shapes, survive: they are
indistinguishable from ordinary text without redacting ordinary words. Runs of
K-1 units survive away from a cut. Values derived by an unregistered encoding
(a date from a timestamp, say) are outside the guarantee, as is a later read of
a Proxy, which only in-process code can build.

Payload passes run where downstream or guest data enters: the connector's
result and errors, the invocation's raw reply, executor outcomes and logs,
emits, and resource and skill reads. The agent boundary (`redactAgentOutput`,
every meta-tool exit and the MCP route) repeats every check except short
private values, which would rewrite Connecta's own ids, counts and addresses;
payload passes already removed them. Identifiers sent beside a credential — a
confidential client's ID, a Basic username beside a password of at least eight
characters, and credential-slot fields named as identifiers (`…Id`, `user`,
`username`, `login`, `email`, `public…`) — are matched whole only: consent URLs
and vendor metadata carry their parts by design. Continuation cursors sent as
query parameters (`pageToken`, `next_token`, `continuationToken`, `syncToken`)
are public result state and are not registered. Header values a connector
adds to token requests are registered under any name, except values equal to
Connecta's own public ones (`Accept: application/json` and maintained
providers' media types, in `PUBLIC_TOKEN_REQUEST_HEADERS`).

K = 8 equals the credential floor, so exactly the short private values are
whole-only. It keeps ordinary words, dates and counts out of the index: a public
run must repeat eight consecutive units of one form to match, so high-entropy
credentials and private values produce no measured false positives (a 200 KB
corpus of documents, logs, JSON and URLs is unchanged). Values that embed
ordinary text do suppress it wherever it recurs within the same request: a
password holding the word `resource`, a token holding a vendor's name, a
credential that is a URL, or a PEM key's armor. Base64 forms reach K at six
bytes of the value. The index stores two independent 32-bit polynomial hashes
per run (at most 524,288 distinct runs, a table at most half full), so a false
match is vanishingly rare and only redacts more; index and scan are linear in
the registered forms and the scanned text, whatever the number of values. A
64 Ki-bit bitmap of the runs' first hashes rejects nearly every text position
in one load, so only a candidate computes its second hash. A pass over a large
body costs about what the per-leaf matcher it replaced did
(`scripts/bench-sent-secrets.mjs` compares builds); declared binary content
costs more, since it is decoded and checked as bytes as well as its base64 text.

Unchecked content is withheld rather than weakening the guarantee: past the
index's capacity, or under a private value too large to register, every leaf of
K units or more and every run of adjacent shorter leaves reaching K; a cycle, an
accessor, a container past depth 512, and a container past the node budget,
withheld whole and never serialized. Leaves too large to match joined within the call's work budget are
matched alone, in order, withholding one that does not fit, and every seam
between kept leaves is matched 512 units deep on each side. Text that still
holds escapes after eight decoding layers withholds the leaves holding them.

Declared binary content (Drive `format: "base64"` content, MCP image/audio
`data`, resource `blob`, and a REST body's `base64` beside its `contentType`)
is decoded and checked as bytes, as UTF-8 when a registered form is not ASCII,
as its base64 text, and through any base64 the bytes carry, so an echo at any
byte alignment is found. Decoded views take payload text's short-value rules. A
match withholds the whole field as the base64 of `[redacted]`, never partially
scrubbed bytes; content that is not valid base64 as it stands still gets every
text view. Base64 or base64url in any string, key or declared field is decoded
in each of its text views: raw, one layer of JSON escapes decoded, percent
escapes decoded, and the form decoding (a `+` as a space, generated whenever
a `+` appears). A view that
is wholly base64 is decoded from six units; a run inside one from six units
when payload rules apply and a four-to-seven-unit private value is registered,
otherwise from eleven. A run of L units decodes to floor(3L/4) bytes, so a piece of
p bytes at alignment a needs L >= ceil(4(a + p)/3), least at a = 0: the smallest
piece matched is a short value's four bytes (6) or a K-unit run's eight (11).
Decoded content is searched for further base64 three encodings deep. The
decoded views are matched together as one lane, each run decoded once per call
however many leaves repeat it, and a match only decoding reveals withholds the
leaf as `[redacted]`. Every decode is charged to the call's work budget, and a
leaf it cannot check is withheld. Two text decodes chained, base64 glued to
preceding alphabet units with no separator, HTML entities, compression and
custom alphabets are outside the guarantee (`auth.md`, INV-5 output redaction
limits). Content found clean at least 4,096 units long is remembered for the
request until its set changes, so later passes do not decode it again.

Every base64 or base64url encoding Connecta returns goes through
`encodeForAgent`: Drive and Gmail downloads, REST bodies, and every page
cursor. It checks the content before encoding and encodes `[redacted]` instead
on a match. Cursors are built from already-redacted values, not sealed: a
provider has no deployment key, and a sealed vendor token would still be the
vendor's text. A vendor page token is redacted where it is placed, so one that
echoes a sent value fails on the next page instead of carrying it; a revision or
id the cursor only compares becomes its digest when it holds a sent value
(Slides states, Forms revisions and anchors), and a vendor page id a cursor
names (Slides slides and notes pages) is redacted. Before encoding, every
string in a cursor's claims is checked under payload rules, since each
downstream value a cursor holds is a string, and its whole text and encoding
under the boundary's, so Connecta's own keys and counts never meet short
private values. A cursor checked so is remembered as clean; one that holds a
match encodes `[redacted]`.

Text Connecta or a provider cuts short, trims, normalizes or extracts from is
redacted whole against the request's set, private arguments included, first
(`redactBeforeCut`, and `clampText` in the Workspace products): a cut leaves a
remnant shorter than K that no later pass can see, and a normalized number may
no longer hold the form at all (Drive size strings, Breeze amounts and dates).
Provider text lanes that the projection does not see as adjacent are matched
joined (`SentSecrets.parts`): Docs text runs across links and paragraphs, with
index previews checked again after whitespace collapses; and Slides raw
text runs, which carry style between them. Text read only up to a bound, or that
a vendor stopped listing, also loses any suffix that begins a registered form
(`redactBoundedRead`). Complete forms and open-tail prefixes are matched against
the original text and merged before replacement. Each decoded layer sets aside
its own incomplete trailing JSON escape, so a later layer cannot conceal an open
tail. Only the uncertain suffix changes; checked earlier rich-text runs retain
their links and annotations. Text-offset cursors bind the redacted
representation as well as the vendor revision; changed secret sets that change
that representation refuse continuation with a restart instruction.

Final transports register sensitive headers and query values after assembling
the request; custom API handlers use `ctx.fetch`. Values shorter than eight
characters do not enter the matcher, including Basic usernames, passwords
and explicitly secret fields such as `client_secret`. Configured short
credentials produce one payload-free warning per connector; use secrets of
at least eight characters. Connecta's own messages never quote a credential.
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
Echoed sensitive header lines are also withheld. They are read on the text
before the echo is replaced and merged into its spans, so a private value that
takes part of a header's name, its `:` or a credential prefix (`Bearer `) cannot
hide the header: the whole value goes, every cookie pair and any short tail
with it (#703). A line that is not a sensitive header keeps its text. The set is never persisted
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
the next one. Recorded HTTP status facts survive the bare write-401 fallback,
Google's uncertain-write wording, and oversized-response mapping; see
[Read failure records](./operating.md#read-failure-records) for their operator
meaning. These facts do not change agent error fields or write outcomes.

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
name onto `describe().source.provider`. Hosted MCP uses generic runtime discovery;
`classify` is rejected at construction in favor of `ConnectaConfig.classification`.
Custom connectors remain opaque and classify from annotations. Checks
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

A maintained provider is one `defineProvider()` call (`src/provider.ts`): a
name, title, `kind: "api"`, maintained skill, closed `options` shape and a
synchronous `create`. Common values are checked before construction and the
factory stamps its provider name onto `describe().source.provider`. API
implementations and their contract evidence remain vendored. Hosted MCP servers
use generic `remoteMcp()` entries; provider reviews and hosted defaults are
removed. Legacy hosted selectors fail at construction with the generic migration
path. GitHub retains its scope-enforced App identity and exposes a bounded repository-read and release-write hatch plus local scope discovery, scoped data search and guarded merge.

[Decision 0011](https://github.com/zackbart/connecta/blob/main/decisions/0011-provider-standard.md)
records the provider standard now implemented by all 15 maintained providers. It fixes
one folder layout per kind and fixed evidence names. `drift.json` gets a
generated block and the guide a generated Conventions section, and every
`api()` surface gets one agent-facing shape. Providers completed two migration
steps: onto the kit with unchanged output, then onto the standard surface.
Both `PENDING.step1` and `PENDING.step2` in `test/provider-standard.ts` are empty;
every maintained provider now meets the standard without a migration exemption.
`test/provider-standard.node.test.ts` holds every maintained provider folder to the
standard, and `test/provider-conventions.test.ts` checks the surface rules on
Node. `providers:generate` writes the standard's derived parts and
refuses a provider past step 1 that breaks the `drift.json` rules, or one past
step 2 that breaks the guide rules: `drift.json` version 2's `generated` block
(operations from the kit's `ProviderKitFacts` and evidence digests), and a guide's `## Conventions`, rendered
from the definition's declarations into `skill.generated.ts`.
The generator requires `fixtures.ts` to export `createAuthored()` with a
nonempty offline `staticTools` catalog. Its input/output schemas derive one
paging convention, including `get_*`, hatch search and details, excluding
tools whose `page.hasMore` is always false. The convention distinguishes
top-level `cursor` from `query[page.param]` or `body[page.param]` continuation
and tells agents to return `page.nextCursor` before the call that would exceed
the per-program call limit, then continue in the next program. The Hatch line
reports a nonzero explicit refusal count with singular/plural wording and
points to the actual prefixed details tool with method/path lookup; it never
embeds the refusal table. Unreviewed operations remain refused.
`ProviderContext.usageGuide` selects a guide's `<!-- when: <key> -->` blocks
with the definition's `blocks`. `providers:check` reads both record versions,
reports a manifest operation no endpoint row records at the provider's level,
and lists manual checks last verified more than 180 days ago. Its offline
record validator, `scripts/drift-validate.mjs`, also gates `providers:generate`
and the standard suite, so a record they accept is one `providers:check` reads.

Supplemental vendored contracts use a simple `<slug>.json` pin and a sibling
`<slug>.document.json` in the provider's `evidence/` directory. An `endpoints`
check names the pin with `specification.pin`; both files are hashed in
`generated.evidence`. Slugs use lowercase letters, digits and hyphens, start
with a letter, and cannot be `openapi` or `value-safety`; paths, dots and
reserved primary evidence names are refused. The pin requires https `url`
and `documentation`, `vendored: true`, and the exact document `digest`.
The checker reads that document offline from this provider's evidence only,
checks its digest, and never fetches the pin's URL. Keep dataset semantics
that the envelope does not describe in a separate manual check.

A provider whose public API is split across documents may declare
`evidence/openapi.json` as `{ revision, documents: [{ pin, prefix }], options? }`.
Each `pin` names a simple supplemental sibling pin and byte-exact document;
`prefix` is its literal API path and must match that document's one server.
All documents must share an HTTPS origin. A composition has no `url`, `digest`,
`latest`, or `vendored` field of its own: its actual source URLs and composite
digest are derived from those pins. `providers:spec` namespaces local component
references, prefixes paths, omits empty source paths that establish no route,
refuses collisions, and compiles the combined
contract through the same compiler. Missing operation summaries inherit the
path item's resource description with a method-specific action. Both the source
pin bytes and normalized composed document are checked for offline freshness.
A composition moves only by explicit review of its source pins/documents;
`--record` and `--file` cannot replace it. `providers:check` compares the actual
public documents independently; it never fetches a synthetic combined URL.

The generic REST connector (`src/providers/_shared/rest/`) serves
`<vendor>_api_search`, `_api_details`, `_api_read`, and `_api_write` over an
`OperationIndex` that `pnpm run providers:spec` compiles offline from the
provider's pin (`evidence/openapi.json`; `openapi.source.json` until its step 1)
into `openapi.generated.ts`. A `vendored: true` pin compiles the reviewed
conversion in `evidence/openapi.document.json` instead of fetching, and the
generated header records that document's digest beside the pin's, so the
offline freshness check sees a changed conversion.
Each call is matched to an operation and checked against its parameters before
transport. Resolved path parameters are validated before authentication or dispatch,
including pinned enums and numeric bounds. Number path values must decode to canonical finite ASCII decimals without
exponents, hexadecimal, a leading plus or whitespace. Integer path values must decode to
canonical ASCII decimal safe integers: `0`, positive decimals without leading
zeros, or negative decimals without leading zeros. `-0`, leading `+`, whitespace,
exponents, decimal points and non-ASCII digits are refused. Negative integers
remain valid when the pin has no minimum excluding them. String-valued ids keep
their declared string contract; `_api_read` admits GET and the vendor's reviewed read-only POSTs in
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
`numericBounds: true` preserves documented numeric minimum/maximum constraints
in request schemas and enforces them before dispatch, including numeric query
strings. Existing indexes without those optional constraints are unchanged.
The compiler separately records response property paths from the lowest
declared JSON success status (then `2XX`), resolving local references and
composition. It includes top-level and list-item properties (root arrays or
an envelope's immediate arrays), and shares paths and rows in a lazy `OpenApiData.fields`
JSON string. Traversal stops at 1,024 schema visits, 24 reference/composition
levels, 256 paths or 200 characters per path; overflow or an unresolved
reference omits that operation's whole response-field contract. Explicitly open
roots (including root-array items) also leave fields absent. Empty,
schemaless and non-JSON responses declare no fields. Request shrinking and
endpoint contract digests do not depend on this metadata. Legacy REST tools
retain their catalog and discovery behavior until each provider's step 2.
Fields remain optional additive metadata, so a previously compiled
index without the source bytes remains usable without inventing a response
contract. Vercel's step-2 pin review restores response metadata from the reviewed public
document; operations without declared response properties still refuse fields. Breeze's pin declares no response
properties. GitHub's immutable official OpenAPI pin supplies its complete index and response fields; a reviewed repository allowlist controls dispatch. Natural queries with reviewed matches scope discovery to those matches and named-only operations; explicit paths and unmatched queries retain full-pin refusal discovery.
`check:providers-generated` checks each index header against its source record
offline; `providers:check` reports a pin that differs from the live document.
No maintained provider selects an implementation with `surface` any more. See
the
[provider auth migration](./provider-auth-migration.md).

#### Generated index storage (contributor contract)

Generated format 5 stores the same logical `OpenApiData` as earlier formats.
The shared renderer interns complete parameter rows by their exact JSON text,
including descriptions, required flags and compact schema references. Each
operation records parameter-row ids and its unchanged serialized body. Shared
schema definitions, response fields, lossless request graphs, operation order,
pins and all compiler shrink options retain their existing meaning. The two
indexes derived directly from kit declarations continue using their plain
logical representation.

`compactOpenApi` exposes the exact original `details` string through an
enumerable, replaceable property. `OperationIndex` parses definitions once per
instance and decodes each operation row on first use. Each row occurrence gets
its own parsed parameters; dictionary sharing introduces no new mutable object
sharing between operations or instances. Existing shared schema references and
their mutation behaviour remain intact. Ordinary logical indexes still use
`JSON.parse`. Construction neither expands the complete details string nor
computes an identity hash. Cursor binding continues hashing the same canonical
logical data and policy, with no encoding metadata in its preimage, preserving
existing cursor bytes for unchanged content.

The runtime codec uses no platform-specific imports, recursive references or
compression dependency. Parameter ids must be nonnegative safe integers naming
existing strings. Reconstructing a row or full details text is bounded to 64 Mi
UTF-16 code units; full reconstruction must match its recorded exact length.
These physical decode checks do not change request validation, schema traversal,
search, refusal, result or discovery budgets. Generation and offline roundtrip
tests must preserve every pinned logical contract; storage changes never accept
new upstream evidence or golden bytes. The compaction suites cover exact strings,
native Web Crypto identity, malformed references, lazy decoding, mutation
semantics and every maintained provider.

#### Value safety for REST vendors

The bar ([decision 0005](https://github.com/zackbart/connecta/blob/main/decisions/0005-auth-selects-implementation.md)):
no REST tool response, success or error, returns a credential that grants
access to the vendor or a third party, or a stored secret value, unless a
reviewed named tool exists to return it. The threat model assumes an honest server; secrets people type into free
text are out of scope. Field-by-field redaction over a whole vendor API does not converge, so
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
   parameters**. Known AWS SigV4/Google V4 `X-Amz-`/`X-Goog-` Signature,
   Credential and Security-Token values are withheld across all decoded string
   values, including values written with decimal, hexadecimal or named HTML
   character references. References are read whole as value data; decoding
   only finds nested-reference boundaries and classifies a placeholder's
   remainder. No decoded replacement is returned. Possible named references
   are read fail-closed with their required semicolon and bounded HTML name
   length. Numeric references also accept an omitted semicolon, and `amp`
   may omit its semicolon immediately before `#`. Signing separators accept
   nested ampersand references around decimal, hexadecimal or named `=`
   references. Recognized name representations retain their source spelling
   and use the same fixed signing-name vocabulary and value boundaries.
   A literal query separator such as `&name=alice` still ends the signing
   value. Ordinary query strings and prose retain their original spelling.
   Generic credential names (`code`, `key`, `token`, `signature`, `sig`, etc.)
   and credential-looking fragments apply only to reviewed diagnostic
   paths and vendor error text. Matching destinations lose their entire query
   and fragment. The tables list exact operations/resource paths with evidence:
   Stripe charge failure/outcome messages, Vercel deployment failures and
   build/runtime log text, Cloudflare Workers/Pages build logs and telemetry
   message/error and raw string/object source payloads in both events and
   invocation maps. The shared review harness rejects embedded-URL operation
   keys absent from each vendor's pinned index and invalid path syntax.
   The current Vercel pin was reviewed from its full response document; its unversioned URL does not retain older documents.
   Vercel project creation registers every submitted environment-variable value
   before dispatch, so echoes in response metadata, keys and prose are withheld
   before field selection while safe project and variable metadata remain.
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
   The authenticated MCP `admission.requests.maxBodyBytes` cap and any smaller
   host cap still apply; response and raw-upload limits do not bound JSON fields.
   JSON admission iteratively checks every key and value, with no separate
   depth or node-count ceiling below the accepted request's size. Cyclic
   direct arguments refuse with `invalid_args`; repeated non-cyclic references
   are inspected. The scans remain linear in the supplied and decoded bytes.
   Withheld values must not be written back; obtain the original
   link or omit the field. This link scanner alone treats a marker outside a
   destination as ordinary text. Kit admission additionally refuses whole
   marker values and any marker containment in paths and queries; longer prose
   in body fields may mention a marker (see Contributor provider kit).
   Reviewed text paths withhold credential-bearing URL queries and fragments.
   AWS and Google signing parameter values are withheld at every host.
   `carriesWithheldLink(value)` is
   a shared write-admission helper that refuses a write before dispatch
   when a link's own query/fragment carries the exact `[redacted]`
   placeholder, plain or up to four layers encoded. Admission resumes at
   each actual Markdown destination's close, including adjacent links and
   images and balanced/escaped parentheses; leading spaces, tabs, and one
   line ending before the destination are recognized. This scanner treats a marker
   after the close as ordinary text; kit admission applies the whole-value and
   path/query rules described above. This boundary is independent of redaction's fail-closed
   span. Each string is scanned alone; split rich-text runs are outside this
   scan's threat model.
   Sent-secret redaction runs before this step, in the provider kit's parse
   pass, so a rule that decides on a value can read the `[redacted]`
   placeholder where the vendor wrote what the rule matches. Every such
   decision input fails closed through one check, `redactionAltered` in
   `src/redaction-marker.ts`. A resource or embedded-URL type discriminator
   that carries the placeholder applies every resource rule's paths and
   withheld fields, never a verbatim URL. A label (`key`, `name`,
   `target.key`) or `type` that carries it makes the record a labelled or
   typed secret, a header, cookie, or query rule, and an environment item; an
   environment list string that carries it is withheld like `NAME=value`. A
   whole string whose scheme it may have taken (no whitespace, and only
   scheme characters before the placeholder) is withheld, at a destination
   key too. A parameter name it altered (the placeholder inside a run of name
   characters that ends at a plain or encoded `=`, and not directly after an
   `=`) loses its value wherever signing parameters are scanned, and in
   reviewed text withholds the whole link, as does a placeholder opening a
   word where a link's scheme and host would be; a fragment it altered
   withholds the query and fragment. A key that carries it (text a result
   hook parses after the kit redacted it whole, such as NDJSON and log
   streams) loses its value, and its record's key-based decisions take their
   protective outcome, route header pairs included. A placeholder can also
   stand for a credential's public prefix (`sk_live_`, `whsec_`, or a signing
   parameter's name and `=`) and leave its remainder, which with the prefix
   known rebuilds the credential however short or encoded it is. Wherever
   signing parameters are scanned, a placeholder followed by any of a value's
   base64 or base64url characters (letters, digits, `+`, `/`, `=`, `-`, `_`)
   or `%` escapes is withheld with them through the end of the value
   (`splitRemainder`), so a tail of `+/` alone goes too. A reference in an
   inferred remainder counts when it decodes to credential characters or an
   ampersand. Without a semicolon, numeric digits may run into the following
   value: a credential character spelled by the first 1–3 decimal or 1–2 hex
   digits after leading zeros also counts. Other references end that
   remainder, preserving text after spacing or punctuation references.
   Known signing values read references whole regardless of the character
   they spell. A value's end never splits
   a placeholder. In reviewed links, a query component that carries the
   placeholder and has no readable name withholds the query. What
   stays visible cannot complete a credential: other punctuation alone after a
   placeholder (`.`, `,`, `;`, `!`), which no base64 value contains, and text
   past a value's end (whitespace, a quote, an angle bracket, `&`, `#`, `)`,
   `]`, a backtick or a backslash), except where that syntax is part of a
   character reference read whole. A bare numeric reference body (`#50;`,
   `#x32;`, with optional semicolons and nested ampersand continuations) can
   remain when redaction removes part of a reference. It is read as value
   data, so `#` ends a signing value only when it does not open such a body.
   Numeric fragments directly after a signing value are withheld too.
   A following parameter is decided by its own name. Value safety's own
   placeholders are not alterations: `@keys` map keys, a withheld value right
   after `=`, and a withheld `#[redacted]` fragment. More is withheld only
   when a private value occurs in a decision input, and then deliberately:
   a placeholder inside a base64 value before its `=` padding counts as a
   parameter name, so its link goes whole; an altered fragment withholds the
   query and fragment; a Content-Type redaction altered on a body that is not
   JSON leaves it unreadable (see "Contributor provider kit"); a vendor key
   spelled with the placeholder loses its value.
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

Remote MCP tools classify from server annotations and deployment policy.
Only `readOnlyHint === true` with `destructiveHint !== true` establishes a
source read; missing or contradictory hints mean write. Deployment overrides
in `ConnectaConfig.classification` choose effective `read`, `write`, or `hidden`.
They cannot relax source replay safety. Effective or source write makes a call
write-like on every resend and recovery path. Source classifications travel in
private metadata with host-owned tool clones and stay out of persisted catalogs.
A leftover `classify` throws and names `ConnectaConfig.classification`.
There are no hosted review maps, pins, drift comparisons or review UI fields.
Catalog refresh activity still compares successive accepted catalog fingerprints
and reports only added, removed and changed counts in the caller's partition.

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
  keep release priority over new requests. Fixture updates capture canonical
  cohort release order and reverse cohort release order, each with its own
  fresh module graph, clock, network and cache namespace. Queue replies are
  assigned in canonical request order in both runs; only answer delivery
  changes. Steps remain readable admission cohorts, not simultaneous answers.
  Workerd checks compare the canonical observation. In stored fixtures,
  identical observations collapse to one
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
- Settle, rejected-capture cleanup, and final teardown pump controlled timers,
  microtasks, and fake requests within the original 10,000-host-turn windows.
  Only outstanding captured Web Crypto operations can extend a window: after
  exhausting it, await a snapshot of those native operations to settle, then
  resume with a fresh bounded window. Each phase allows at most 100 native
  extensions and reports an explicit error on exhaustion. Web Crypto always
  settles independently of the harness's fake network, timers, and producers.
  Body reads and stream reads are counted for quiescence but cannot extend a
  window: their producers may require a fake response, future virtual time,
  or never complete. No producer attribution or stream constructor tracking
  is needed. Pending native crypto never advances virtual deadlines or merges
  request cohorts. Clock advancement remains limited to 1,000 ticks.
  Unsupported producer dependencies reject within the turn bound; teardown
  always clears timers and releases capture ownership, including after failed
  construction and overlapping capture rejection. The next capture must work.
  Each capture has an async-context epoch that closes before ownership is
  released, even when its native extension cap is exhausted. Controlled-source dispatchers reject closed
  continuations before touching another capture's state. Fake request entry,
  admission, response delivery, and serialization check their owning epoch,
  including after asynchronous body inspection. Late work cannot record into
  or receive a response from a later capture, which never waits for it.
  Closing also attaches rejection handlers to outstanding counted promises,
  consuming abandoned native body-read rejections without awaiting them.
  Source regressions explicitly assert either completion or bounded rejection
  followed by recovery. Crypto-delay probes at 11,000 and 100,000 host turns
  must complete with unchanged observations; producer-fed bodies need not.
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
  its raw and base64 forms. The `401 echo` case echoes the raw secrets only
  unless the spec sets `errorEcho: "all"`: a provider that caps a vendor
  message before redaction sees it would leak the start of a longer form its
  cut goes through. The Google Workspace specs set it, since Google redacts a
  message whole before cutting it to 500 characters. Their `401 echo` carries
  `errorEchoForms`: every form above, the `Bearer` and `token` framings, and
  an HTTP Basic pair holding the token as header, base64 and base64url.

Object keys keep the order the provider produced. A migration changes the
provider, never the spec or harness.

`test/goldens.test.ts` compares every provider on Node and workerd. It fails
if a provider folder is neither covered nor listed as remote-MCP-only, a tool
has no call, or a golden file is missing or extra. Ordinary checks never write.
Node compares forward and reverse observations byte for byte; workerd compares
canonical observations. Each order starts a fresh module graph. Workers projection
removes variants only at harness observation positions, never from vendor fields
or schemas. Fixture updates retain both orders.
There are no characterization tiers, path classifiers, or planning-only runs.

`test/goldens-harness.test.ts` keeps the source and mutation guards on Node:
replaced Authorization headers, changed auxiliary/login bytes, writes sent
early or twice, and missing secret-encoding redaction must alter a capture or
fail it. Mutation probes capture the affected call rather than repeating an
entire provider catalog. Redaction negative controls use Forms, GitHub, Breeze
and Tithe.ly to cover OAuth/Bearer, app-token, query-key and provider-kit lanes;
the ordinary goldens still check every provider's complete secret echoes.
The native-extension budget is checked directly at its 100-extension boundary,
and a gated closed-epoch continuation must fail before entering the next
capture's network. Genuine crypto completion, rejection, late dispatch and
producer-fed stream probes retain their native settlement coverage without
repeating a million-turn synthetic delay. Ordinary runs use one source-probe schedule. Nightly Node runs set
`CONNECTA_GOLDENS_DETERMINISM=1` for an identical repeat, provider jitter seeds
1 and 2, and the complete source-probe jitter matrix. Small native-source probes also run on
workerd: `scheduler.wait`, CompressionStream, saved timers/microtasks and
Effect scheduling, prebound crypto/clocks, module freshness, runner clocks,
and Blob/TextDecoderStream promise settlement. Runtime-specific cases carry
Vitest's `workers` tag; broad cases carry `node`, which the Workers project
skips. Other mixed transport/auth/runtime suites use the same tags to retain
native fetch, request/response streams, deadlines, signals, crypto and SDK
settlement without duplicating their policy matrices. `vitest.config.ts`
selects these files with globs that tolerate test-file deletion. Portable
filenames alone do not enroll a new file in workerd.

Repository verification policy, CI requirements, and exact commands live in
[AGENTS.md](https://github.com/zackbart/connecta/blob/main/AGENTS.md#verification).

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
(the `node:http` adapter and its owned `http/node-transport.ts` undici dispatcher), `src/sqlite.ts` (`node:sqlite`), and the QuickJS process pool
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
| `execute_code` (`execute.ts`)                                          | One fiber whose Scope owns the run's signal and executor lease, so a result, a throw, the watchdog, and cancellation all release the lease and abort the signal the same way. Public executor methods stay Promise-shaped; registered built-in execution composes directly as an Effect under the signal and `execute.watchdogMs`. Queued acquisition retains its Promise request handoff. Each guest host call is a fiber of its own.                                                                                                                                                                     |
| Discovery (`catalog-service.ts`)                                       | A request-scoped cache: one shared read per connector (`runtime/shared-read.ts`), settled by the read itself and carrying its own signal and the probe timeout whichever asker starts it. Each asker waits under its own deadline and signal, so one that times out or is cancelled fails alone, and the read is cancelled only once every asker has gone. Fan-out is `Effect.forEach` under the discovery concurrency.                                                                                                                                                                                    |
| Registry (`registry.ts`)                                               | The result stash is a program over `Storage`. Same-request catalog loads share one read the way discovery's do. Remote MCP caching uses the SDK ResponseCacheStore adapter over SQL-backed KV, with no cross-request catalog flight.                                                                                                                                                                                                                                                                                                                                                                       |
| Remote MCP (`connectors/remote-mcp.ts`)                                | Each request scope's state holds a Scope, each connection is a lease forked from it, and a connect in flight is a Deferred carrying the client it connected. Closing a session and the transport are each bounded to a second.                                                                                                                                                                                                                                                                                                                                                                             |
| Downstream OAuth (`auth/downstream-oauth.ts`, `auth/static-oauth.ts`)  | A refresh flight is a Deferred. Before the first durable coordinator write (claim CAS) is submitted, call/request closure stops preparation without a CAS, token request or state change. Submission transfers renewal to the storage coordinator under its own 35-second preparation deadline and 20-second token-request/body deadline, followed by the fenced rotation commit through the runtime deferred-work hook. A closed caller promptly fails without consuming the result, marking its ledger renewed or sending/resending a resource request.                                                  |
| Operator and activity data (`routes/operator.ts`)                      | Each JSON route is one program run by `serveOperator` behind the Promise `handle()`. Reads run under the request's signal; writes do not, so a vault write or OAuth disconnect that started reaches its cache invalidation.                                                                                                                                                                                                                                                                                                                                                                                |
| QuickJS pool (`executors/quickjs.ts`, Node only)                       | Each child is a scoped resource whose release sends SIGTERM, then SIGKILL after a second; crash respawn backoff is a `Schedule`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Native registry and request services (contributor)

Registry catalog loading, classification, OAuth handoffs, status, invalidation,
credential readiness, and result stashing have private Effect programs in
`src/runtime/registry.ts`. Static class blocks install those programs while
preserving the published Registry declaration, including its private member
names. `registryProgram(view, method, ...args)` checks the installed method's
identity; a custom or replaced method remains a Promise leaf. A Promise shell
selects its original class implementation through `registryEdgeProgram`, so a
wrapper can call the original without redispatching to itself. Catalog search,
describe, resolution, and listing compose these programs directly. The shared
listing is a native child of its request's Scope, started through
`forkRequest` in the edge runner; an individual reader cannot terminate a read
another reader still needs. Closing the request aborts and closes those children.
Settled reads remove their request-close finalizer; active reads retain it,
including in long-lived caller-supplied scopes.

Native catalog and maintained API entry points report policy, validation, and
operation-construction throws as typed failures with the original thrown value,
matching the Promise boundary. Native consumers can use `Effect.catch` and
`Effect.result` without losing refusals to the defect channel. Interruption
remains interruption. Normalization belongs at these program boundaries;
pure catalog algorithms and core validation retain their existing behavior.

`RequestScope` in `src/runtime/request-scope.ts` represents the existing request
identity. It owns call revocation, teardown, operation signals, the complete
sent-secret set, and invocation/auth recovery facts. `openRequest` preserves
its synchronous revocation bridge. Live context access refuses after closure;
`recordedService` and the owner's `retained` facts remain available for
settlement and redaction. Sharing a request identity grants no call authority
to a spread copy of a context. Call deadlines, request lifetime, and the OAuth
refresh coordinator remain distinct owners.

Maintained API programs register their original tool-handler identity through
`src/runtime/call-entry.ts`. Invocation enters the native API validation and
settlement pipeline, which composes a registered tool program directly; the
Promise handler is its public shell. Replacement and custom handlers stay
Promise leaves. Both paths retain argument validation, generic withheld
handler diagnostics, secret redaction, call revocation, and core write-outcome
settlement. Custom connector hooks, vault and cache adapters, Web Crypto,
downstream OAuth, and the remote SDK retain their existing Promise boundaries.
Cross-request call admission deliberately remains a Promise handoff so workerd
resumes queued work in the request waiting for the permit.

The `Storage` service composes built-in `getNativeStorage` operations directly.
Registry wrappers propagate that optional capability through principal,
connector, subject, and result prefixes, including nested namespaces; list
results strip only their own prefix. Custom stores keep the Promise fallback.
These adapters add no retry, transaction, or storage encoding and preserve
D1's single atomic batch and SQLite's native transaction. Native activity
lookup remains available to the route and activity consumers.

### Native executor hosts (contributor)

`src/runtime/executor.ts` registers private execution programs by executor or
lease identity and the original `execute` method. `executorProgram` composes a
registered implementation directly; custom or replaced methods remain Promise
leaves. Public shells call their own implementation directly, allowing wrappers
to delegate to a saved original without recursion. Native interruption retains
the QuickJS log prefix; Promise leaves are observed even when a terminal budget
race wins before their settlement. Redaction and write settlement remain in the
existing execute pipeline, using its request identity and call capabilities.
The executor seam creates no second request or call owner.

Both built-ins acquire their permits through native admission and return
execute-once leases with synchronous, idempotent release. A queued standalone
execution crosses `awaitExecutorLease`'s Promise handoff before host setup, so
workerd resumes in the waiting request. `execute_code` retains its public
`acquire()` handoff for that same reason. A cancelled queued handoff withdraws
its waiter, and a late custom acquisition releases its abandoned lease.

The Worker SDK prepares source and dispatchers against an inert loader. The
native host then acquires the actual Loader handle and RPC entrypoint with
`Effect.acquireRelease`, awaits the native RPC Promise, and races the run with
its lease's cancellation Deferred. A resource Scope owns entrypoint-before-
Loader disposal on every exit, including never-settling evaluation. Release
closes that Scope synchronously before returning the permit; a failed disposer
cannot skip the next one. Forwarders lose their providers and pending waits at
run end. Only native RPC output and the run's private host-failure map can
supply failure provenance. Guest source isolation, intrinsic capture, import
routing, codecs and the SDK's source-generation checks remain ordinary leaves.
Both built-ins normalize provider leaf returns with `Promise.resolve`, retaining
direct JavaScript callers' synchronous value tolerance and original host
rejections. The published provider-function signature remains Promise-shaped.

QuickJS owns host-call fibers in each active run's Scope. Completion,
interruption, cancellation, recycling and shutdown revoke provider lookup and
interrupt those fibers; late SDK results and stale IPC cannot reply to another
run. Releasing a lease during readiness or crash backoff also cancels the old
run before its slot is handed back. Child retirement closes its resource Scope,
sends SIGTERM, and escalates to SIGKILL after one second. Shutdown joins native
completion Deferreds for all retirement tails. Crash backoff remains a Schedule.
`forkOwned` in `src/runtime/run.ts` starts the host and startup-watchdog children;
no executor starts a fiber directly. Child process events, IPC encoding and
bounds, QuickJS VM/job pumping and guest code remain platform or pure leaves.

`test/executor-native.test.ts` exercises native dispatch and Worker disposal,
never-settling evaluation/host calls, late rejection, execute-once ownership and
original acquisition errors in workerd. `test/quickjs-pool.node.test.ts` covers
readiness release, stale/malformed IPC, late host failures, backoff and bounded
kill. Real Worker and QuickJS guest contracts, the HTTP Worker budget/queued
request fixture and native-output suites supply runtime parity evidence;
provider goldens do not execute a sandbox.

### Native SQL storage (contributor)

`src/storage/sql-native.ts` composes KV, activity schema upgrades, retention,
and bounded SQL copies as Effects. `src/storage/d1-copy.ts` composes the
Workers KV copy, source-bound resume claims, verification, cutover guard, and
recovery. Public factories and copy functions retain their Promise contracts;
custom Promise SQL drivers retain the fallback lift.

`src/storage/sql-driver.ts` constructs a public Effect 4.0.5 `SqlClient`
service inside each operation. Reads execute SQL `Statement` Effects and writes
execute their raw operations through that service, including its connection
borrowing, statement-transformer context, and tracing semantics. Internal
statement transformers see the current service; no client, statement, or
Reactivity state is cached across operations or requests.

Atomic batches remain one native database operation: D1's public `batch`, or
SQLite's synchronous `BEGIN IMMEDIATE` through `COMMIT`, with rollback on
failure. Neither path retries a dispatched write. The D1 binding's
`meta.changes` is retained for every statement, including zero; no `RETURNING`
payload, extra metadata statement, or D1 transaction is needed. The dependency
is the existing exact `effect` pin. Connecta does not adopt `@effect/sql-d1`:
its 4.0.5 batch API drops metadata and its binding contract is wider than
Connecta's published structural interface.

The D.2 architecture allowance was measured against `0e314247` using cached
official `node:22-slim` (Node 22.23.4, zlib 1.3.1-e00f703), no network, and
read-only bundle artifacts: `/d1` grew from 62,516 to 88,305 bytes gzip
(+25,789); the Worker example grew from 729,847 to 756,375 (+26,528).
Final typed-driver failure normalization measures 88,319 and 756,377 bytes
on that same official runtime. Executing real services and statement operations requires those runtime
semantics; the earlier identity-compiler facade did not provide them. The
explicit allowance changes only `/d1`'s cap from 62,542 to 90,000 bytes and
the Worker example's cap from 743,000 to 760,000. Historical baselines and
all other caps stay fixed. Final integration must remeasure the combined
implementation and satisfy the same compatibility and privacy contracts.

The platform connection capability contains no request state. D1 prepares in
the current request and retains no prepared handles or promises. SQLite keeps
its existing connection-owned prepared-statement cache; externally supplied
databases remain caller-owned. Schema readiness is a boolean. A microtask
boundary precedes dispatch so pending cancellation can stop physical execution;
a SQLite batch never yields between transaction controls. Cancellation cannot
undo an already-submitted D1 write and never causes replay.

Public SQL Statement operations create spans, so SQL tracing is disabled
before executing them. Private `SqlError` values contain fixed wording with
no driver cause or parameters; the original thrown value is restored only
at the private SQL boundary. Operator sinks receive no new SQL diagnostics.
The tracing contract is checked with a recording tracer and a mutation that
removes the guard, which must fail. Existing import and copy errors retain
their fixed, payload-free wording.

`src/runtime/native-storage.ts` supplies optional `getNativeStorage` and
`getNativeActivity` lookups. An internal consumer may compose their Effects
without starting another fiber; an absent lookup requires the existing custom
Promise-store fallback. Registration normalizes operation-construction,
validation, and decoding throws into typed failures with the original thrown
value, matching that fallback. Interruption remains interruption. The lookup
module imports no SQL or platform implementation and does not change the
published storage interfaces.

The synchronous state-file parser, validation, file read, and one atomic
SQLite import remain native synchronous leaves because `importStateFile` is a
published synchronous API. `openSqlite` retains file modes, WAL, busy timeout,
and database ownership. `test/sql-effect-contract.ts` runs native-path,
affected-row, 50-claim, cancellation, and tracing checks on SQLite and native
D1. `test/kv-to-d1.test.ts` also reuses stores across separate workerd requests;
the existing SQL contracts prove rollback, database-clock TTL, encodings,
activity upgrades, and copy recovery.

### Internal provider HTTP failures (contributor)

The kit's `src/http/errors.ts` maps every `HttpFailure` tag through
`toConnectorCallError`. Its completeness-checked tag vocabulary is also the
typed-client boundary's guard. Vendors declare closed public value vocabularies
for body facts that select a failure meaning. Before sent-secret value redaction,
the kit extracts those facts from a token-only copy and retains only declared
values; unknown reasons or codes contribute no classification fact and fall
back to status rules. The captured facts stay in request-local identity metadata,
outside the failure's enumerable data. Classification reads them with complete
bounded facts and reviewed headers. Vendors also declare each numeric source in
`numericFacts`: an exact body `path` or lowercase `header`, a review reason, and
an optional `format` (`integer` by default, `seconds`, `epoch-seconds`, or
`retry-after`). The kit reads only these sources from the response before value
redaction. It accepts nonnegative whole numbers and strings of at most
128 characters that contain only ASCII digits after trimming surrounding
whitespace; `retry-after` also accepts HTTP-dates. Integers are capped at
`Number.MAX_SAFE_INTEGER`; delay formats yield milliseconds clamped to
0–86,400,000. The `retryAfterMs` numeric fact supplies the kit's standard hint
and requires an explicit delay format (`seconds`, `epoch-seconds`, or `retry-after`).
For example, a vendor declares `{ retryAfterMs: { header: "retry-after",
format: "retry-after", review: "HTTP Retry-After delay for failure recovery." } }`.
Classification receives only parsed numbers, never their original text or
undeclared fields. These facts may select a code, retryability and bounded delay;
they never supply wording or records. Only after the verdict is fixed does wording
receive numbers read separately from the redacted response, facts extracted
separately from the redacted body (eight list entries)
and, where the operation's value-safety review permits it, that redacted body.
Pre-redaction facts never supply message text, logs, or operator records.
Non-2xx responses always take this capture path. A connection opts in with
`inBandRefusals: true` only when its result hook reports in-band refusals on
successful statuses; their declared facts come from the whole response.
Required vendor meanings for 401/403/404 precede the other defaults; 409 has no
shared conflict default.
Stripe declares HTTP 409 as a conflict, alongside its fact-driven 429
`lock_timeout` rule. Its reviewed `bodyFailures` opt-in applies status-only
classification to an oversized 424 reply, preserving the dependency-failure
meaning when the bounded body cannot be read. The original ceiling diagnostic
and answered status remain; the core still decides write outcomes. It does not
apply to 401 or alter Q8. A fixed read-phase fact distinguishes failed body
reads from malformed JSON only for vendors declaring that wording; raw
exceptions never enter diagnostics. Other providers retain their mapping and
wording.
A 421 is `unavailable` and retryable only when the transport's core
positive-read classification proves that request a read, including its actual
method and method-override headers. The agent chooses another call; the kit
does not resend it. This override preserves the vendor's wording and changes
only the code and retryability. A physical write retains its existing failure
mapping.

The mapping records each request's own served provenance and raw 401 facts.
`api()` and invocation retain the sole write-outcome decision in the core's
`providerCallFailure`/`settleWrite`. A blocked resend reports the first
reservation's answer even for a read-classified tool issuing a physical write.
An accepted write's blocked retry retains its original HTTP status; a slot
occupied by an auxiliary read instead names the separate write step needed.
Structured resend advice reaches output only when the core permits it. Generic
unknown writes retain the core's diagnostic wait; Q8 removes it. The mapping
adds no Promise entry or lifetime owner. The rule tables in `http-kit.test.ts`,
Stripe's sixteen-branch comparison and `kit-core-verdicts.test.ts` establish
these internal contracts. Maintained API providers use the kit through their
explicit provider subpaths; it stays off the root import graph and published
declarations expose Promises.

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

### Contributor provider kit

Provider declarations use `src/http/vendor.ts` for HttpApi operations and
`src/http/tools.ts` for list, get, read, write and action builders.
`src/http/provider.ts` composes them with `defineProvider`; it returns the
ordinary Promise-based Connector factory. The kit stays outside the root
graph and its Effect types are internal. Tithe.ly is the first provider on
it (B.5): `api.ts` declares the vendor, `tools.ts` the tools, and its goldens
are unchanged.

Decision 0011's standard surface (Tithe.ly's step 2) adds four kit pieces.
A `list` without the legacy `key` returns `{ items, page }`, with
`page.nextCursor` only while `hasMore`, and the kit appends `limit` (the
declared default and maximum), `cursor` and `fields` to the tool's filters;
`read` and `get` take `fields: true`. `src/http/fields.ts` narrows after every
projection. A standard list may opt into `total: true` and supply an optional
exact vendor count as `page.total` from its page callback. The kit validates a
nonnegative safe integer and includes it on continuing and terminal pages;
without a vendor count the property is absent. Lists without the opt-in keep
their existing schema and result bytes. Never derive an exact total from a
partial page or an estimate. `src/http/fields.ts` refuses an unknown first
segment before dispatch; a selected
result renders against a sparse output schema. `src/http/hatch.ts` is the
standard hatch (`_api_search`, `_api_details`, `_api_read`, `_api_write`) over
an `OperationIndex` with explicit verdicts. It keeps the REST family's
argument and envelope names and validates `fields` against the operation's
declared response roots before dispatch. Search answers stay within 16 KiB
(at most eight compact entries, long labels cut and marked, continuation by
cursor); details stay within 32 KiB, paging whole parameters and body
properties, and chunking any piece larger than one answer, behind a bound
cursor. Standard hatch search removes conversational framing; framing-only
queries return no matches. It admits partial lexical matches alongside full
matches. Action/read queries require all content nouns in the operation text,
or any noun in the path/id with at least half the nouns in the text. Their
field-only matches need half-noun coverage across text and declared field
names. Verb-less noun phrases retain their broader rule: any noun in the
path/id, or all nouns in the text. A leading create/add/update/edit/make/set/apply/change/rename/send/delete/remove/cancel/stop
with an object sets write intent and retains later read words as nouns. Make,
set, apply, change, edit and rename share update synonyms. `make a`,
`make an`, `make new` and `set up` phrases instead select create synonyms,
including after leading conversational framing such as `please` or `i want to`;
`make text bold` retains update intent. Otherwise, a read
word anywhere sets read intent, including after refund/charge/issue/process.
Short function words and id-shaped tokens do not contribute to noun coverage.
Sheets A1-style cell references also supply no resource noun. A write query
whose supplied object contains no resource nouns includes its verb synonyms
in candidate retrieval, so values do not restrict it to reads mentioning them.
Verb-only queries and a rename destination without an object retain ordinary
retrieval.
Reviewed intent, the requested verb/synonym in summary/id/path, and resource
focus sort first. A refused operation with a matching verb shares the intent
tier only when its noun coverage exceeds every admitted operation matching that
verb and intent. Search and details retain the original indexed summary and expose the reviewed
reason in a separate optional `refusal` field. Ranking uses the original indexed
text, never the newly attached reason. Search caps refusal text at 512 UTF-16
code units without splitting a surrogate pair, independently of its 300-unit
summary cap. A cut reason names `operations[i].refusal` in `truncated`; details
returns the complete reason within its 32 KiB envelope or reconstructible
`of: "refusal"` text chunks. The five long Cloudflare reasons fit whole in the
search refusal budget, including their named alternatives. REST safety tables
supply the reason through `restSafety`; reviewed bindings declare static operation
refusals separately from argument validation. Discovery cursors additionally bind
the summary/refusal representation format, so an old piece offset cannot skip a
required parameter after this representation changes. The binding's deployment
`cursorScope`, named suggestions and paging totals retain their existing seams.
An unreviewed operation reports the missing hatch verdict. A refused hit has
no read/write hatch pointer; a reviewed named alternative can still be shown.

Verb-less noun phrases first sort by noun coverage and an exact summary phrase
prefix, then by an exact terminal resource: the last literal non-version segment must contain the last query noun
or the concatenated noun phrase (`invoiceitems` for `invoice items`). An authored
read whose vendor summary/id covers every noun shares that terminal-resource
tier only when a real terminal-resource match exists and its description
begins with a read action; the action word itself
does not supply noun coverage. This preserves aggregate
authored entry points without treating a verification action as a token list. When both candidates match the terminal resource,
a reviewed read precedes writes and refusals. Depth with a one-segment authored
tool preference, exact resource-noun coverage, and authored-tool preference
break remaining ties. A pointer to another hatch receives no authored preference.
Exact resource nouns include literal namespaces on either side of a version
segment; parameters and version markers supply no resource coverage. This
prefers `members` over summary-only membership matches and `tokens` over a
verification action, while direct versioned collections retain their depth
advantage over nested collections. For a single noun, and for
leading `list` queries with one exact resource noun plus modifiers, collection
ties sort by exact root, fewer nested resources, matching namespace, shallow
depth and authored tool. Other leading `list` queries prefer authored tools
whose summary/id covers every noun. This retains descriptive aliases while
restoring [decision 0014](https://github.com/zackbart/connecta/blob/main/decisions/0014-api-tool-shape.md)'s
noun-phrase preference. Person/people and mail/email aliases, s/es/ies plurals and hyphenated list
roots share the collection keys. Sort keys are computed once per operation
per query; lexical relevance and index order resolve remaining ties.
Operations found only through a request or response field follow primary
matches, and search names an authored tool whenever one serves an operation.
A refused method outside a read/write tool's input schema is inspected through
`_api_details` with its indexed method and path. Call validation remains closed:
Gmail's 49 non-GET refusals do not add a method field or a write hatch, and Forms'
refused DELETE remains outside its write enum. GitHub's refused raw PUT merge
is likewise outside its write enum; its named guarded alternative is unaffected.
These 51 schema refusals happen
before authentication or I/O; details exposes the same reviewed reason as search.
Every schema-reachable refused operation still fails with that reason before
authentication or dispatch. This is policy inspection, never execution admission.
`_api_read` omits
`method` only when GET is its one reviewed read method.
A standard list can declare `limit.values` for a vendor's discrete page sizes.
The values must be unique positive integers within `max` and contain the default.
The catalog declares the enum and decoding refuses other sizes before dispatch.
A reviewed read-only POST list supplies `review`, like other reviewed POST reads.
A reviewed OpenAPI pin may opt into `additionalResponseMediaTypes` to declare
response fields from a vendor's nonstandard media labels. This changes field
metadata only; the runtime still enforces its declared response format.

A provider may opt into `hatch.writeEnabled(options)` to omit its write hatch
from a connection whose deployment configuration permits only reads. Discovery
omits write-tool routing on that connection; reviewed reads do not gain write
verdicts. The default remains enabled, and endpoint read-only policy still
enforces every invocation.

The hatch's optional `pages` table declares an adapter for each indexed read
that pages. `src/http/hatch-paging.ts` supplies Stripe forward lists
(`has_more`, last `data` id → `starting_after`), Cloudflare
(`result_info.page/total_pages`, falling back to `total_count/per_page/count`
→ `page`), Vercel (`pagination.next` → `until`), and GitHub (quoted or unquoted
Link `rel=next` → `page`). Stripe opts into indexed forward lists, reverse
lists (`ending_before`, first safe row id), v1 search (`next_page`) and v2
lists (a confined `next_page_url` supplying only `page`).
If a Stripe v2 URL adds query parameters the original call omitted, the read
keeps its data and returns `hasMore: true` without `nextCursor`; a continuation
cannot be minted without guessing which vendor defaults to preserve. Changed
explicit filters and URLs outside the confined origin/path remain refused.
A declaration names the cursor parameter and `query` or `body`; it must
exist in that operation's request contract. The response remains
`{ status, data, page? }`, with `page: { hasMore, nextCursor?, param, in }`.
With parameter-based continuation, put the opaque `nextCursor` back in the named
parameter. The hatch binds it
to its tool, content-hash index revision, method, path, other arguments and selected fields,
canonicalizing nested object key order while preserving array order and scalar types.
It decodes the cursor before index validation and sends only the vendor value. Paging is
read after connection safety and before field selection; result hooks must
retain the paging metadata. Only an adapter's explicitly requested response
headers enter its answer, already sent-secret redacted. GitHub extracts just
the page from a Link URL with the same origin and unchanged filters, including
GitHub's repository-ID paths; it never follows the URL or changes the original
request path. Filter comparison uses parsed scalar parameter multisets,
preserving duplicate counts and tolerating order and URL-encoding differences.
Adapter continuations use the same root-store HMAC key and admitted
connection/personal-owner binding as discovery cursors. The signed v2 token's
claims preserve the vendor value's string/number type and pass the request-secret
encoder. An unpaged hatch keeps its existing result schema.
The optional `pageCursor: "argument"` declaration separates a top-level
signed `cursor` from raw first-request anchors. Stripe allows a raw
`starting_after` or `ending_before` record id in `query` only without cursor;
both directions or a cursor with any raw anchor are refused before dispatch.
Returned tokens authenticate the selected adapter parameter and value as well
as the call. Search/v2 raw page tokens cannot replace cursor. Providers without
this declaration keep parameter-based continuation.
An explicit initialAnchor adapter on parameter-based paging can retain a numeric
timestamp as a first-page time-window anchor; opaque string continuations still
require a signed token.
The generated Paging convention follows the read tool's input schema: tools
that take `cursor` restore `page.nextCursor` as that top-level argument; tools
without it restore the token in `query[page.param]` or `body[page.param]`, as
`page.in` specifies. `kit.hatch.paging` still validates declared mode values as
a sanity check; it does not select the generated continuation instruction.
An unsafe continuation keeps the safe page data with `hasMore: true` and no
`nextCursor`.
A reviewed `HatchBinding` can supply vendor encoding/origin routing through
the same Connection API; the shared hatch retains resolution, verdicts,
index/fields validation, withheld-value admission, paging and projection.
A binding may resolve configured query routing before validation and signed
cursor binding. Vercel uses this to apply its teamId default and deliberate
teamId/slug/null overrides consistently with named tools and uploads.
A binding may opt into `truncated: true` to supply reviewed size-cut paths
(such as `data.content`) in its answer. The hatch then declares and propagates
an optional top-level `truncated: string[]` on reads and writes. Without the
opt-in, the schemas and results are unchanged; size-cut metadata is not inferred
from vendor booleans or added to other providers. A separate `warnings: true`
opt-in declares and preserves reviewed `warnings: string[]` beside `data`, even
when `fields` narrows the vendor body.

A binding may expand deployment-owned path defaults (Cloudflare) or canonicalize
repository contents paths (GitHub) before indexed resolution, and may prepare a
reviewed text/NDJSON body before validation. Both the original
and resolved paths pass withheld-value admission. Closed request-header enums
are opt-in; selected headers join the paging cursor's call identity. Text body
inputs are opt-in too. A provider with bounded call-owned scope lookups declares
its fixed write steps, preserving the resource call's single-attempt slot.
A page adapter may declare `cursorInputMessage` to give provider-specific repair
guidance when an unsigned raw value is supplied; absent keeps the standard refusal.
An optional `fieldsRoot` supplies vendor-envelope selection guidance and the
corresponding generated convention; it never changes the declared response roots.
Field selection on every provider, including named reads, accepts optional `[]`
array notation (`result.id` and `result[].id` are equivalent); this normalization
is shared behavior, independent of `fieldsRoot`.
Bindings retain the hatch's other-server and JSON/form body-type guards by
default. `allowOtherServers: true` and `allowOtherBodyTypes: true` explicitly
replace those guards with the binding's reviewed routing or encoding checks.
Stripe uses it for nested v1 form parameters, v2 JSON, account/context headers
and the confined PDF origin. An optional hatch idempotency declaration uses
the kit write builder's checked key hook: Stripe POST writes take or generate
keys, while DELETE and the read-only invoice-preview POST send none.
Redacted or withheld cursor values are refused both before minting a continuation
and after restoring a decoded continuation, before dispatch. The shared
`refuseWithheldValues` check runs on the restored query/body: paths and queries
refuse marker containment, while bodies retain the whole-value/link rule.
`src/http/vendor-index.ts` derives that index from a kit vendor's own
declarations when the vendor has no pinned OpenAPI document: `form()` request
contracts, `Summary` annotations and lenient success schemas become the
index's parameters, bodies, summaries and declared fields (optional
`OpenApiData.fields`). Kit facts carry the vendor's declared
`VendorErrors.meanings` and an `idempotencyKey` checked against the write
builders at construction, which the generated Conventions state.

Hatch request paths and query keys/values refuse any containment of the shared
`[redacted]` marker, including decoded spellings. Body fields and kit write
arguments refuse a string that equals the marker after decoding, or carries a
withheld link (including origin-only links ending in the marker). Longer free
text such as `the log says: Authorization: Bearer [redacted]` is accepted.
Admission iteratively visits keys and values before the write program runs;
it checks agent arguments, not whole bodies later composed from internal
reads. The kit connection also checks actual typed path parameters and query
values before transport. Legacy non-kit tools retain their link-only admission;
arbitrary binary/base64 bytes are not decoded by this scalar rule. The kit
sets `refusesWithheld` for the standard hatch, enabling the generated convention.
Declared error-code facts use the closed `ConnectorCallErrorCode` set at
construction (INV-11); classification callbacks are not run at construction.

Bound cursors MAC a canonical tuple of version, admitted connection id,
personal registry's credential-owner partition (null for shared registries),
canonical tool/argument digest and continuation payload with HMAC-SHA-256.
The canonical envelope spelling is required too. Hatch discovery binds a
SHA-256 content hash of the index (operations, details, fields and routing
metadata), alongside its declared label; the displayed revision label remains
unchanged. Index edits invalidate old continuations even without a version
bump. Search offsets, details pieces/chunks and surrogate boundaries are
validated. Tampering or a changed scope/index fails `invalid_args`; changing
only `limit` remains allowed.

One random 256-bit signing key is initialized lazily with compare-and-set
in the durable root `continuationKeys` family. Only resolved, nonextractable
keys are cached per store; no request promise or key value is logged. Registry
`rootStorage` preserves the explicit deployment root across personal partitions
independently of `catalogStorage`; standalone API connectors bind their own id
and use their supplied store. Every deployment resolves a store, so no unsigned
fallback exists. SQL-backed cursors survive isolate/process changes; memory
storage loses them with the store. Key-load outages or corrupt stored keys
produce retryable `unavailable`, naming the cursor signing key without its
value. See [cursor-key recovery](./deploying.md#recover-a-cursor-signing-key):
after repairing/deleting a corrupt key, restart every process/isolate to clear
cached keys. Pre-upgrade cursors require a new first page. Offline goldens
preseed a fixed key only in their harness.

The helper derives connection metadata and probe messages from
validated options and still accepts complete legacy usage guides for compatibility.
All maintained providers have completed the standard-surface migration.
Candidate checks can refuse before authentication while
preserving the provider's exact diagnostic. Its optional `authScope(options)`
selector fixes OAuth grant ownership from deployment mode at construction;
CCB uses shared System Auth grants and personal Identity Auth grants. Tool
arguments cannot select a grant's owner. On Node, every maintained-provider
request uses the owned sender `listen()` installs, reads included. Without it,
maintained-provider writes and reviewed POST reads are refused before sending;
suites exercising those requests configure the sender themselves, as the goldens
harness does. Anything a connection
caches across calls, such as its typed HttpApi client, is built with no
services, because Effect constructors close over the context they run in and a
cached value would otherwise keep its first caller's request alive (INV-7).

The optional `grant(options)` factory supplies a renewable machine-login
`Grant`, exclusive with static OAuth. It is built outside caller contexts;
each send binds the active call to its token, refresh and rejected effects.
`settleWrite` decides the outcome and handoff.
Reads replay once after renewal; writes are never resent.

A machine grant may also declare `grantRenewal` modes, with an optional
`Grant.discard(token)` that forgets exactly that refused token and keeps any
newer one. `replayRejection: "answer"` discards the token a replayed read was
refused with and hands that 401 to the vendor's status table, so the message
comes from the bounded, sent-secret-redacted body instead of `rejected`.
`writeRenewal: "discard"` discards a write's refused token without renewing:
no token request is sent, nothing is recorded as renewed, the write's 401 is
answered, and `settleWrite` decides its outcome and handoff. Neither mode
resends a write, and the defaults are unchanged. Google Workspace uses both,
because its delegated tokens are minted per call and a refused write only
needs the next call to mint again.

All Google Workspace products use `src/providers/_shared/google/kit.ts`, which
puts the delegated service account on a machine grant. `workspace.ts` owns
shared options, connection parsing and subject resolution; `service-account.ts`
owns token exchange and caching. JSON requests use `googleClient`, and
Drive's `driveClient` adds binary and charset-aware text projections over
that adapter. The subject resolves once per call from deployment config and
the admitted caller, and the private token exchange keeps its in-memory
cache, so only token strings and expiries cross requests. Each product
declares its operations, and a value-safety resolver refuses any path it does
not declare. Revision-guarded writes set the
`revisionGuarded` request flag that Google's error table reads. The completed
product migrations use Effect-declared named tools and indexed
hatches. Fixed write steps are snapshotted at construction. Docs declares a
create and its optional initial-text edit as separate steps, each sent at most
once.

All six Google Workspace products use the shared standard-surface support.
`scripts/google-discovery.mjs` converts
archived exact-byte official Discovery documents into deterministic OpenAPI.
The primary vendored pin retains the official URL, revision and source digest;
its `discovery` relation names the sibling source pin and normalizer format.
Generation and offline freshness reproduce the conversion, and the generated
module records its independent document digest. Full source method inventory
and canonical source-to-relative-path mappings survive normalization. Gmail's
source `userId` becomes deployment-owned `me`; runtime paths are relative to
the existing connection root. Reserved Slides ids remain one encoded segment.
Flat-path aliases are reconciled with the declared path parameters. Method-
specific required annotations specialize only affected reachable input schemas,
including nested and recursive references. Deprecation metadata is retained;
compact details opt in with `deprecations: true`. Live Discovery drift compares
sorted-key JSON and revision, independently of archived-byte integrity.
Only safe JSON query globals enter the contract. Source bytes are contributor
evidence and never runtime imports.

An index can retain `requestSchemas`, a lazy referenced graph for complete
request details, independently of the compact depth-bounded admission checker.
Details attach the reachable `$defs`, preserving recursion, required fields,
dynamic maps and parent schema metadata through the existing bounded
continuations. This does not make the compact checker a full JSON Schema
validator. Product admission still needs literal reviewed verdicts and
independent batch-kind, revision and resource guards. Google indexes explicitly
set `pathMatching: "uri-template"` on `OperationIndex` to handle encoded literal
collisions and parameter action suffixes. Other indexes retain exact literal
segments and their existing refusal ordering. The matching mode also binds
discovery cursors. An indexed `googleClient` requires each named request's declared
template and refuses a substituted id resolving to another operation before
grant evaluation. Products opt in with `googleClient(connection, title,
{ standard: true, index })`; their requests carry `template`.
Both the client and `googleHatchBinding(connection, { index, review })` require
the explicit URI-template mode at construction. The hatch requires the binding's
exact index identity. Standard clients and Google bindings reject a missing
index with an explicit construction error. The provider-standard suite checks
actual hatch construction through every Google product fixture, requiring its
Google binding with the same connection and index. The Google binding
additionally refuses percent-encoded unreserved characters and colons before
dispatch.

The generator's `allSuccessResponses: true` option unions JSON response fields
from every 2xx. Existing providers keep the first JSON success contract until
their own reviewed regeneration; no committed provider index changes here.

`src/providers/_shared/google/hatch.ts` supplies JSON framing over the existing
confined `Connection.sendPath`. It retains the hatch's origin/media guards,
delegated grant, safety and field-selection pipeline. Its optional `wrapSend`
receives a detached copy of the admitted request (including its body) and a
zero-argument inner send. The binding retains its original `send` function;
wrappers run only after hatch admission and can dispatch the captured request
at most once. A second send is an internal defect; after a write dispatch its
outcome remains unknown. Opting into this wrapper also enables envelope-level
warnings, so request-dependent save advice survives field selection without
changing vendor data. Mutating the inspection copy cannot change its path, body,
query, revision flag or safety policy. Products use this seam for response
semantics that depend on the request, such as independent comment saves.
The `googlePageToken`
adapter is separately opt-in by exact list key with `pageCursor: "argument"`.
It treats missing/empty `nextPageToken` as terminal, rejects malformed tokens,
and continues empty pages when a nonempty token exists. `query.fields` is a
Google vendor mask; the adapter preserves `nextPageToken` on the wire. The
token must be selected as a complete top-level field; `nextPageToken/x` does
not select it. The top-level `fields` argument narrows safe result data only after paging. Omit
`pageToken` initially and restore the signed `page.nextCursor` as `cursor`;
the raw token in safe vendor data is not accepted as continuation input.
For example, a direct value-mode result has outer `result.data`, the hatch's
`result.data.page.nextCursor`, and vendor JSON at `result.data.data`:
`call_tool({ address: "crm.forms_api_read", args: { path:
"/forms/form_1/responses", cursor: previous.data.page.nextCursor },
resultMode: "value" })`. This is an envelope illustration for an opted-in
provider, not a claim that the Forms migration has shipped.

`googleErrors(product, { standard: true })` declares the product's 404 meaning
and uses common status fallbacks; revision-conflict meanings require a
separate declaration. Standard-mode `googleClient` preserves failure phase
metadata for partial-create recovery while leaving settlement and wording to
the kit. Its incomplete-body wording covers JSON and binary reads without
claiming that binary success was expected to be JSON. Legacy mode retains
its catalog and failure bytes. No shared-core auxiliary-write outcome change
is part of this opt-in support.

Drive's two-request reads also declare fixed steps: `get_file_content` uses
`metadata` and `content`, and non-root `list_folder_items` uses `folder` and
`files`. These reads still send both GETs when deployment classification
serves them as writes; each step can leave only once.
Gmail declares separate initial and body-download steps for `get_message`,
`get_draft`, and `get_attachment`; `search_threads` and `list_drafts` name
each of up to 25 summary reads, and `get_thread` names each stored body in
Gmail's 100-message conversation limit. Serving these reads as writes keeps
every request available once.
The layer's request adapter keeps the legacy wording of a served write whose
answer proves nothing (no answer, a 5xx, a redirect, or an unreadable 2xx) and
reports how far a failed request got. The core still decides every write's
outcome. Gmail's auxiliary draft and reply lookups pass both `effect: "read"`
and a construction-declared step: the guarded client's early reservation uses
that named slot, while the ledger marks the request auxiliary. A failed lookup
keeps its read verdict and cannot make an unsent draft write unknown.

Sheets declares its seven API methods in `src/providers/sheets/api.ts`; its
kit tools retain the private digest-bound cell cursor, legacy A1 path encoding,
and create/append recovery advice. Its projections and the Google failure
classifier read fields by the names Google gave them, which the kit's parse pass
keeps. Its catalog and guide stay unchanged in step 1.

Google's request adapter also offers a reviewed binary send. It marks the
operation `googleBytes` for the product's `binaryBodies` selector and forwards
an optional `maxBytes` to the success-only prefix reader. It returns the
connection's safe answer: bytes pass the existing sent-secret encoding before
any result hook, then value safety before the product reads them. Products
keep charset decoding and special error-status interpretation local.

An optional `tagConnector(connector, options)` records construction facts
about the built connector, once, before the registry can serve it. Its return
value is ignored, so it cannot replace or wrap the connector. Google Workspace
uses it to tag whose account the connector acts as, which the registry reads to
hide a mapping-subject connector from agents in a pool without an owner.

GitHub's tools and allowlisted indexed hatch use kit read/write builders and a confined
Connection while its App authentication and scope-verification transport stays
private. Its tokens are partitioned by App/key, installation, repository IDs,
permissions and purpose. A resource 401, or a 403 without rate-limit evidence,
invalidates the exact bearer even when its body cannot be read. The next call
mints lazily; there is no inline renewal or replay and no renewable Grant.
Only completed scalar cache data crosses requests; private signing imports
and all transport operations remain request-owned.

The optional `probe.run(connection, options)` program replaces the operation
probe when authentication needs a different read or a private login transport.
It is built once at provider construction outside caller contexts, using the
confined Connection and validated options. Execution uses the same anonymous,
uncharged candidate services, accounting, settlement, failure mapping and
finalizer. An empty write-capacity map refuses Connection writes before dispatch.
Every defect from a run probe or its hooks uses the generic withheld notice,
even without a kit dispatch, because a private transport leaves no kit visibility
evidence. An open operation probe retains its original defect.

The REST bridge in `src/providers/_shared/rest/kit.ts` retains pinned index
validation and legacy hatch schemas while the kit owns tool leases, fixed write
capacity, transport, failures and result safety. It verifies schema equality
before restoring legacy catalog key order. `indexedVendor` derives operation
metadata from the index and builds the full manifest lazily; the typed client
contains only named operations and probes. Bulk indexed declarations preserve
the OpenAPI brace paths verbatim and carry explicit parameter Schemas. They
serve the manifest only: typed sends refuse an undeclared operation name,
and indexed hatches dispatch through `sendPath`. Parameter names outside
`[A-Za-z0-9_-]+` fail construction. Manifest/index operation-set equality is
checked independently of drift digests, which still use full vendor contracts.

A tool may opt into `inputOrder: "original"` when legacy request bytes depend
on argument insertion order. After normal successful decoding, the builder
copies only decoded values in the original key order, recursively through
objects and arrays. Dropped keys stay dropped and decoder-introduced keys
append at the end. Capacity selectors, idempotency and the tool program all
receive that reordered decoded value. The default preserves the decoder's
existing order; the option retains no original values and skips no validation.

The kit write builder emits `readOnlyHint:false` and its explicit `destructive`
verdict as `destructiveHint`; `destructive:false` describes an additive write.
A reviewed `idempotent` declaration emits `idempotentHint` independently of a
transport idempotency key. These hints describe behavior; write routing and
endpoint restrictions still apply. For example, a tool that only creates a new
note can declare `destructive:false` without promising idempotency.

`restKitTools` may declare a `writeSteps` map whose values are `"once"`.
Construction freezes the map; every named step sends at most once and an
undeclared step is refused before dispatch. Omitting it retains the single
implicit write step. Auxiliary ownership reads in a write call retain that
call's write classification and consume their declared lookup steps, so the
resource write cannot be resent.

Reviewed response policies can select text using only the redacted, normalized
Content-Type. A separate `binaryBodies` review opts into bounded byte reads.
Only the connection sees those bytes: it calls `RequestSecrets.encode` before
constructing the legacy `{ contentType, bytes, base64 }` value. Undeclared
binary bodies retain the JSON-only failure. Fixed secondary origins use a
separate kit Connection built during provider construction, with their own
confinement and the same authentication and result safety.

A definition may derive authentication and default admission from validated
options. Probes may derive their request from those options and describe a mapped
failure (for example, an accepted key lacking account-read permission). Public
routing/version headers remain request or constant headers, never authentication
secrets. An optional positive `timeoutMs` retains a vendor's request and body
deadline. A path request opting into `emptyForm: true` retains an explicitly empty form on the wire; other empty form declarations keep their previous omission.

`PathRequest.rawBody` accepts a string, `Uint8Array` or `FormData`; it is
exclusive with JSON, form, `emptyForm` and item/bulk identities. Conflicting
combinations fail construction where possible and otherwise refuse before
dispatch. Framing uses Effect's text, byte-array or form-data body helpers.
An explicit Content-Type is preserved exactly; multipart callers omit it so
fetch generates its boundary. This field does not change classification,
write-step accounting or the sent-secret set, and existing size ceilings apply.

A send may opt into a success-only `prefix` read with a byte ceiling, an optional
tighter time limit and a boolean chunk-stop callback. Failure responses retain
the ordinary bounded status and withheld-error path. Early success cancels the
unread stream and reports `prefix: { truncated, bytes, stopped }`; accepted bytes
still pass sent-secret redaction, the result hook and value safety before any
projection. The callback runs with an empty Effect context, receives a copy of
the chunk, and cannot transform the answer. Its defects receive the same
withheld-text rewrap as result hooks. Invocation cancellation remains authoritative.
Reviewed binary prefixes retain bytes through the same sent-secret encoding
as whole binary bodies, without a text decode. Only that binary path accepts
a zero-byte prefix, which keeps empty bytes and the ordinary prefix facts.

CCB's static OAuth bridge opts into `oauthWrite401: "grant"`. An optional
`refreshOnce` mapper receives only renewal facts and reuses the core's
`unsentAfterUnauthorized` diagnostic, preserving the grant's authorization
message and the message for a renewed credential whose write was not replayed.
The error retains the resource dispatch's provenance; `settleWrite` decides
the final outcome. The default middleware behavior and renewal ownership stay
unchanged.

The static compatibility option caps discarded 401 challenges with the shared
OAuth challenge limit before renewal. A guarded client's optional
`maxUnauthorizedResponseBytes` applies to declared and streamed bodies;
`read(response, maxBytes)` can narrow a read's ceiling further. The middleware
maps an oversized challenge using its own recorded dispatch, including a
declared-size refusal before the response wrapper exists. It never renews
after that refusal.

The kit's parse pass redacts every value of a parsed JSON body and keeps its
object keys. Value safety drops and redacts fields, and projections navigate
them, by the names the vendor gave them, so a private argument sharing part of
a name such as `client_secret` or `paragraph` cannot hide the field from the
rule that withholds it or erase the structure a projection reads. A result
hook that redacts again does so the same way. Text, binary bodies and JSON
embedded inside a string are values and retain ordinary redaction. Response
headers keep their names, which `Headers` must accept, and their values are
redacted together. Keys are checked once value safety and the projections have
run: the `api()` boundary and the invocation apply payload rules to the
connector's result and failures, keys included, before the agent boundary's
pass. Until then a key is the vendor's text, so a provider that serializes part
of a body and cuts it redacts the serialized text first (`redactBeforeCut`), as
Breeze's in-band failure text and Slides' raw chunks do. A private value of four
to seven units that a vendor echoes only as an object key is therefore matched
once, at the connector boundary; the agent boundary's envelope rules do not
match values that short.

Redacted values can still be decision inputs. `textBodies` and `binaryBodies`
see a Content-Type that redaction altered as `application/json`, so no altered
type routes a body around ResultSafety as one string or as bytes; a body that
is not JSON is then unreadable. Value safety's own decisions on values fail
closed the same way (see "Value safety for REST vendors").

For an unreadable successful body, the shared mapper appends an unknown-outcome
and check-before-repeating sentence for the call's own write request, including
writes transported with GET. An auxiliary read lookup inside a write call
keeps its read message; a failed lookup does not establish that the write left.
`VendorErrors.unreadableWrite` can override the complete write message.
Reads keep their existing wording. Overflow's
unreviewed text responses use its write override; its reviewed health text and
refund acknowledgement remain accepted.

A vendor may declare `encodedFields`: exact dotted JSON paths with whole
array segments (`payload.parts[*].body.data`), `encoding: "base64url"`, an
optional `sizePath` addressing the same array elements, and a one-line review.
Construction freezes the declaration. Before ordinary whole-answer redaction,
the kit decodes each valid field and redacts its decoded text and bytes through
the same request-secret service. Unchanged fields retain their original
spelling; changed fields retain the original alphabet and padding style when
re-encoded. Both standard and URL-safe alphabets are accepted with valid padding. Invalid base64url stays on
the ordinary redaction path. A declared size is checked against the original
decoded byte length first; a mismatch also retains ordinary redaction. Size
values stay unchanged. This never exempts the encoded field or its surrounding
JSON from the generic redaction pass.

Result hooks alone may call `encodedFieldProvenance(answer, concretePath)`.
Its private WeakMap is keyed by the parsed, redacted answer; each frozen
entry holds only `originalLength`, optional `sizeValid`, and `changed`.
Provenance contains no content and is never serialized into facts, messages
or logs. Gmail copies this metadata privately for its decoded body containers:
text renders after redaction and before cuts, while changed binary content is
withheld in full. Its original byte counts still govern attachment validation.
Vendors without this declaration retain the existing parsing path.
Gmail refuses to update a draft whose Content-Disposition or any header name
was redacted, because it cannot prove that rebuilding the message would retain
its headers and attachments.

Credential descriptions may derive from validated connection options, and a
probe may reject a successful answer that identifies the wrong account.
Transport diagnostics use the vendor error label rather than the provider
definition's title. A vendor may declare reviewed `textBodies` by status and
operation: `text` retains decoded UTF-8 and `json-or-text` parses JSON with a
text fallback. Other responses still require JSON. The bounded byte reader,
sent-secret redaction, and withheld-error policy apply before text can reach
vendor wording or a result hook; a legacy hatch's text contract does not admit
malformed JSON on named tools.

The helper's connection-specific `transport(options)` supplies constant
headers and final-URL admission outside any caller context. Admission receives
the request method and encoded text body before authentication, so product
exclusions can inspect JSON:API writes. `sendPath` accepts per-request headers;
typed operations can declare header Schemas. Authentication still owns its
headers and applies last. A provider's default call-admission policy yields to
an explicit deployment policy. A typed refusal thrown by the probe's reply
describer becomes the ordinary failed credential-test result.

`emptyRequired(schema)` preserves a legacy output object's explicit
`required: []` through Effect's canonical JSON Schema rendering. It refuses
an object with required properties; its decoder is unchanged. Closed empty
input records render `properties: {}` and `required: []` explicitly.

A vendor may set `manifestBase` to prefix its documented operation paths.
The prefix accepts literal path segments and whole `{param}` segments whose
names contain only letters, digits and underscores. It is concatenated verbatim
for the manifest; transport paths remain relative to the confined base URL,
with no parameter interpolation. The catalog renderer
collapses unions of bare object and array branches into a type array; branches
with additional constraints retain `anyOf`.

Every answer passes through bounded reading, sent-secret redaction, vendor
result handling, reviewed value safety and the deployment privacy projection
before paging or provider projections can read it. Read methods beyond GET
and HEAD require a review. Construction fixes each write step's capacity;
the guarded transport reserves it before preparation and the shared core
decides the whole call's write outcome. Dedicated upload builders wait for
the Google Drive migration in C.7.

Reviewed path calls resolve their actual method and path through an indexed
safety adapter; a provider-supplied template cannot bypass the policy.
Unindexed paths require an explicit global review and no reviewed table;
a global review never substitutes for a reviewed table's resolver. A uniform
policy over legacy unindexed paths declares its own resolver. Sent-secret redaction
covers response headers before result hooks can extract fragments. Withheld
hooks admit only operation-bound status failures or unreadable bodies; other
failures become defects whose text the API boundary withholds. Hook defects
are rewrapped once at the tool or credential-probe edge when text is withheld,
including defects from reviewed redaction, vendor error mapping, and the
provider program that carry a `ConnectorCallError`. A failing visibility hook
also withholds the defect's text; non-withheld operations retain their original
defects.

### Production HTTP dispatch (contributor reference)

`src/server.ts` retains the origin refusal, HTTPS upgrade and security wrapper,
then calls the private `src/routes/dispatch.ts` adapter. Each fetch handler owns
two immutable public Effect HttpRouters: a human table selects CIMD, connect,
OAuth callback, metadata, health and MCP programs; the agent table selects only
the existing agent endpoint program. The raw agent-namespace guard runs before
human dispatch. An unmatched human route runs optional UI fallthrough, wildcard
OPTIONS metadata/CORS, or the deployment's final 404. Core selection uses the
router directly, without scanning the other core modules. CIMD runs before UI;
every other human program runs after optional UI, including its null fallthrough.
Metadata retains MCP-before-provider discovery order.

The synchronous constructor does no routing work or I/O. The first existing
edge fiber builds both fixed tables with public `make`, `addAll` and
`asHttpEffect`. Only synchronous registration and cache publication use
`Scheduler.PreventSchedulerYield` and an uninterruptible region. The cache
check is inside that region, so even concurrent first requests with a 16-operation
yield budget publish only two routers. Normal scheduling and interruption are
restored before any application callback or I/O. Cached route effects capture
only deployment programs; they read the private current `RouteContext` service
when executed. No request, body, signal, Promise, client, Scope or request
services are retained in the tables. The canonical request/call ownership in
the MCP program remains unchanged.

Routing uses a body-free GET projection of the URL, with percent escapes and
the matcher's semicolon delimiter protected. The original request remains in
`RouteContext`: existing programs own exact raw paths, arbitrary extension
methods, JSON 405/Allow, HEAD, private OPTIONS, cookies, authentication and body
refusal order. Router normalization cannot grant a canonical path to an encoded
prefix, and invalid escapes in an owned suffix still reach the owning program.
The projection introduces no second request handler or runner. Web responses
pass through `HttpServerResponse.raw`/`toWeb` with their identity and stream
ownership intact. The short dispatch Scope does not own MCP's body-held permit
or the OAuth callback's uninterruptible commitment. Only a genuine public
`RouteNotFound` before handler entry falls through; application failures,
including structural lookalikes and genuine router errors, retain their identity.

Four public `effect/http/*` modules are allowed only in the private dispatcher;
all other root-purity and optional-implementation boundaries remain enforced.
Direct public module imports avoid the area's barrel cost. The local D3
measurement over the reviewed D1/D2 stack is root 373,435 to 393,470 bytes gzip
and Worker 758,274 to 774,384 (official Node 22.23.4/zlib 1.3.1-e00f703, identical
repository bundle options). The barrel alternative measures 423,348/787,614.
The parent accepted this measured native-routing cost with a Worker cap of
785,000 bytes, including room for separately measured native-auth and reviewed
host/transport additions. Root and all other caps and historical baselines are
unchanged by D3. Separate-input costs are not a combined gzip measurement;
the integrated deployment must be measured again.

`test/server.test.ts` asserts production routing directly on Node and workerd:
raw prefixes and malformed suffixes, extension methods, CIMD before auth/UI/body
reads, Response/error identity, unmatched fallthrough, concurrent request
isolation, and body-held permits through end/failure/cancel/abort/abandonment.
`test/node.node.test.ts` bundles one unmodified production Worker and
verifies that a queued request owns its native I/O after the preceding response
ends. Server-route, request-admission and request-pipeline suites retain ingress
ordering, security headers, overload/shutdown and cancellation regressions.
Root purity, declaration and bundle checks own import boundaries and size caps.
The frozen legacy dispatcher, source transforms, diagnostic latency loops and
rejected Effect MCP adapters were migration evidence; their historical source
is linked from decision 0016 rather than rebuilt by ordinary tests.
The upward MCP protocol leaves remain SDK implementations, with D7's separate
native-orchestration work and compatibility evidence unchanged.

### Why not Schema or HttpApi for core routes

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
entry imports `effect` and the four public HTTP modules confined to the private
dispatcher (`test/purity.node.test.ts`).
Effect 4.x is a long-term-support line, but its area barrels `effect/http`,
`effect/http-api`, `effect/schema`, and `effect/sql` are still tagged
`@stability unstable` and can change within it; only core modules such as
`effect/Schema` are stable. That is why Effect is pinned to one exact version
and every Effect upgrade is its own deliberate pull request. A deployment
that also depends on Effect, such as the Worker example's Alchemy stack, must pin the
same version to resolve a single copy. Connecta's own lockfile and packed
install are checked for one copy (`test/package-surface.node.test.ts` and
`scripts/check-package.mjs`).

The stable `4.0.0` release was re-evaluated on 2026-10-01 with this
[historical probe source](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/effect-v4-evaluation.mjs),
retained in Git history rather than the current checkout.
The [raw observations](https://github.com/zackbart/connecta/blob/1ab92695f2636f904274d900ce209553358ff1f3/scripts/probes/effect-v4-evaluation-2026-10-01.json)
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
Those historical defaults are not the production adapter: the narrow public
HttpRouter dispatch above preserves explicit method refusals, unowned fallthrough
and the existing edge runner without `toWebHandler`.

Effect's MCP server has a separate compatibility gate. Its `2026-07-28`
adapter accepted a stateless `tools/list`, but its `2025-06-18` adapter refused
a fresh request with 400. Initialization issued a session, and that session's
next request returned 404 on a fresh handler; Connecta served the same fresh
legacy list with 200 JSON and no session. The stable package exports no MCP
client, so it also cannot replace our downstream SDK and OAuth implementation.
[Issue #622](https://github.com/zackbart/connecta/issues/622) records the server
parity requirements. These historical measurements supported retaining MCP protocol and validation
implementations. Production HTTP dispatch now uses the separately proven narrow
public adapter above; stable v4 alone did not establish its compatibility.

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
- **Operation and call state live in services.** `src/runtime/call.ts` owns
  the admitted `Caller`, credentials, admission budget, recovery writer,
  classification, signals, secrets and request ledgers. Registry operations
  provision caller and operation policy; invocation adds a call lease and
  finalizes it on every exit. `api()` has a private Effect entry and a shared
  core with its Promise `callTool`. The public `ConnectorContext` is a view
  of those services. `deriveContext` shares its entry in the single view
  bridge; a spread has no caller or admission authority. Candidate credential
  probes get anonymous read-call services instead of deriving authority.
  Credentials and charges check closure before and after every await, pending
  work is interrupted, and late recovery facts are dropped. Every published
  Promise view and connector operation also races its complete caller-facing
  Promise against its owner through `settleOnClose`: credential and fetch
  views, guarded helpers, token minting, catalog loading, MCP operations and
  applicable authorization operations. An opaque storage, crypto, resolver
  or body-cleanup wait cannot keep that caller pending after closure.
  Work starts synchronously after the owner guard so shared-session waiter
  accounting and claim ownership keep their existing ordering. Late
  rejections are observed; dispatch and lease guards still contain detached
  work. Per-await I/O cancellation remains useful for releasing resources,
  while prompt refusal is enforced at the boundary
  (`test/promise-boundary-lifetime.test.ts`). Invocation owns
  the recovery and logical-call records it reads after teardown. Closing an
  outer call also revokes nested calls paused in preparation. Request-owned
  MCP sessions and token flights outlive individual calls and close with the
  request; their credential access comes from the operation. Operation views
  resolve request cancellation even without an external signal; auxiliary
  authentication, sends and response handling all use that signal. The
  invocation deadline and original request cancellation remain separate,
  so deadline cleanup cannot end request-owned auxiliary work.
  Concurrent operator probes use separate row scopes, so finalizing a failed
  row cannot revoke a sibling that is still running.
  Shared MCP sessions bind renewal preparation to the challenged call's signal,
  rather than the connection's longer lifetime. OAuth renewal
  is call-owned until its first durable claim CAS is submitted. Submission
  transfers preparation, token exchange and fenced rotation commit to the
  storage coordinator under its own deadlines and deferred-work hook; only
  the caller's wait still closes with the call. That completion
  cannot resume a closed call or resend its resource request
  (`test/call-renewal-lifetime.test.ts`,
  `test/remote-mcp-renewal-lifetime.test.ts`). Explicit request revocation also
  aborts pending authorization-code exchange and refuses late token writes
  (`test/operation-cancellation.test.ts`). Request closure
  revokes views and calls first, then runs every finalizer in reverse order,
  collecting failures. The caller's original cancellation signal is retained
  separately from the lease signal, so normal teardown never looks like caller
  cancellation (`test/call-services.test.ts`, `test/derived-context.test.ts`).
  Construction identities and immutable request/failure facts stay in the pure
  `src/provider-call-facts.ts`, keeping provider stamping and operator sinks
  free of the Effect call-service graph.
- **A write leaves once (INV-9).** `src/write-outcome.ts` owns the shared rules
  every transport applies to a write: `unknownOutcome` turns a retryable
  failure that may follow the downstream acting (a 5xx, a gateway's 502 to
  504, a lost connection or reply) into a non-retryable `connector_call_failed`,
  and `unsentAfterUnauthorized` reports a write answered 401 after credential
  renewal ran, which is never resent: until renewal succeeds it keeps an
  authorization code (renewal's own verdict, else the 401's), and a renewed
  credential leaves a non-retryable `connector_call_failed`. Both mark the error
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
  (`src/auth/static-oauth.ts`), the Google Workspace client
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
  further. A refusal on the last attempt says nothing about the earlier ones.
  Remote MCP writes on Node use the owned runtime sender installed by
  `listen` from `/node`, selected before recording dispatch. Without it they
  are refused before sending. Remote MCP reads retain native fetch; Workers uses native
  fetch with manual redirects. The owned Node sender bypasses the global
  dispatcher and fetch's 421 replay, preserving the SDK's JSON/SSE bodies and
  abort signals. A reset or unconfirmed server failure remains unknown.
  Connecta never reports a transport-failed write as known failed. A write
  is a known failure only on refusal provenance recorded where the evidence is
  observed, never inferred from an error code: (a) the ledger proves it never
  left, or (b) the downstream served an HTTP refusal, a 4xx other than 408
  (`refusedStatus` and `vendorRefusal` in `src/provider-call.ts`), under the
  provider's existing served classification (a write's HTTP 409 is a `conflict`). One helper, `servedRefusal` in `src/write-outcome.ts`, decides
  (b) for the ledger and for a transport outside one: a refusing status the
  provider reads as `unavailable` or a timeout (Stripe's 424) is not proof, so
  only a genuine idempotency key keeps such a direct write's retry. Nor is a
  401, since a server may act on a request before it rejects the credential,
  unless the transport declares reviewed `authBeforeExecution` evidence
  (`GuardedFetchOptions`: the vendor's cited guarantee and a narrow predicate
  over the raw status and headers and the request's method and path, checked
  at construction) and the predicate matched, which the ledger records on the
  request. Only Stripe declares it (`src/providers/stripe/api.ts`, reviewed
  as a `manual` check in its `drift.json`): an API v1 answer carrying Stripe's
  `Request-Id`. `test/provider-failure-sweep.test.ts` holds that list to the
  sources. Q8 is decided in one place, `settleWrite` in
  `src/write-outcome.ts`, once per logical call and over every request it
  recorded. The invocation calls it for every failure of a served write: a
  thrown or mapped error, a custom connector's, a program's call, and its
  own deadline or the caller's cancellation, when no connector failure
  arrives at all. It reads the logical call's requests
  (`logicalCallRequests`), which hold every resource request dispatched
  under the call from any ledger: nested `api()` calls, remote MCP, guarded
  transports, `ctx.fetch` and the kit. Without an invocation (a direct call,
  or a context no invocation opened), only the outermost boundary calls it,
  at the end of `providerCallFailure`, over its own ledger and every ledger
  of an `api()` call entered beneath its handler (`nestedProviderCall`,
  `nestedProviderRequests`), or over the one request a transport outside a
  ledger sent. Boundaries only record what they observed: the dispatch and
  status, a reviewed `authBeforeExecution` match, the 401's own mapped verdict
  (`vendorRefusal`), and a renewal of that one request's own credential
  (`renewedAfterUnauthorized(request, sent, fresh)`, only for a credential
  other than the one it sent). The rule: a write request answered 401 that
  is not a declared refusal standing for the whole call makes the call
  unknown, never retryable, with no wait and no resend or key-reuse advice;
  while any such 401 is unrenewed the verdict keeps an authorization code,
  so invocation keeps the `authorize_connector` handoff and picks its
  reconcile-first words. Its code and words are the failure's when that is an
  authorization verdict, else the 401's own recorded verdict, else
  `auth_required`, with a sentence saying the write was sent before the
  vendor rejected its credential unless the verdict already accounts for the
  401 (a renewal's words). When every such 401 was renewed, the handoff goes
  and the failure keeps its words, unknown and without a wait. A declared 401
  stands only as the call's one request, sent by the boundary that decides,
  whose own refusal is the failure (and, served, known for the logical call).
  The recorders are the guarded transport (dispatch, status, declaration
  match, mapped verdict), `ctx.fetch` (dispatch, status), static OAuth
  (status, verdict, renewal), Google (per-attempt entry, renewal of a read's
  replay), the kit (core ledger entry, status, `recordUnauthorized`,
  refresh-once renewal),
  `remoteMcp()` (each `tools/call` as an entry under its caller's ledger and
  logical call, status, the verdict, and renewal by comparing the
  `Authorization` of the resend the SDK attempts), and `api()` itself (one
  ledger per call, linked to the one whose handler entered it). The same
  decision settles a call that returned (`settleWriteResult`, before its
  result is processed in the invocation, and in `providerCallResult` at an
  outermost direct boundary, including a guarded transport outside any ledger):
  any undeclared write 401 blocks success, even after renewal. Renewal drops
  only the handoff; a program still counts the write in `writes.unknown`.
  A caught read 401 needs positive operation or tool classification, plus a
  recorded GET or HEAD, to leave success intact; a method alone proves no
  read. The guarded transport records its operation classification, otherwise
  its own `api()` tool supplies it (including nested read tools).
  `ctx.fetch`, OAuth and the kit record the same evidence. The final outgoing
  `X-HTTP-Method-Override`, `X-HTTP-Method` or `X-Method-Override` header
  makes the request a write regardless of its classification or method. A
  declared refusal followed by a successful write also leaves success intact.
  A custom guarded transport delegating through `ctx.fetch` or `ctx.oauth.fetch` records the wrapper
  separately from each physical send. Each physical entry records its own
  outgoing method and response; a later response cannot erase an earlier
  401, and a delegated POST cannot inherit a wrapper's GET read evidence.
  The inner entry does not inherit the wrapper's declaration or explicit
  read evidence, including when the init is copied. Until linked recording
  is reviewed, that duplicate may conservatively keep a successful
  composite unknown even when the wrapper proves its own refusal or read.
  Request entries are append-only: every physical send, including a read
  replay after OAuth renewal, gets its own entry. Dispatch refuses an entry
  already sent and locks its sent method and dispatched flag; the request's
  own response status is recorded once and locked, and its own renewal can
  only add a locked mark. These fields are readonly in TypeScript too.
  The built-in `oauthBearer` transport hands an unsent entry to a known
  recording OAuth grant once, before any dispatch. The grant consumes that
  handoff before credential reads and creates a new entry for each further
  send. It never borrows a dispatched entry. Returned-response identity
  names the entry whose status was already recorded, without recording it
  again. This preserves the built-in transport's refusal/read provenance;
  custom delegation and copied init objects remain conservative.
  Remote MCP captures
  each physical read's entry before awaiting its response; a later send
  cannot overwrite it. The kit's response identity and Google's init identity
  identify the request whose credential was renewed. The legacy guarded-fetch
  `answeredRequest` helper has no production caller; tests retain it to exercise
  renewal provenance outside the kit.
  The decider normalizes every failure it settles,
  typed or not (a raw network error, an `AbortError`, a thrown string). Its
  verdict is final (`settledWrite`, which follows copies and redaction): the
  invocation reads the mark before anything rebuilds the details, and its
  enrichers then add no key-reuse, resend or wait advice; only the
  reconcile-first `retry` words and the handoff. A 408 is a
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
  invocation invoked that boundary object with its own `callTool`, or a
  maintained connector object declared to delegate each call to one boundary
  (`delegatesEachCall`, GitHub) with its declared function. Identities are
  captured, never read back: the invocation reads the connector and its
  `callTool` once and invokes that function with `Reflect.apply`, never
  through the function's own `call` or `apply` property; each boundary
  records its object with the published function when it is built
  (`providerBoundary`) and names that object, from its closure, on entry;
  and a delegator is declared at construction. A connector that reassigns
  `callTool` mid-call, or a copy (`{ ...boundary }`, `Object.assign`) that
  shares a boundary's or delegator's function, borrows no standing;
  `defineProvider`'s inheriting stamp keeps its connector's
  (`aliasCallIdentity`). A boundary marks a write known only when
  every request it dispatched is proven unapplied, so the rule reads: known
  only if every request the logical call dispatched is proven unapplied and
  the failing request carries the refusal. A custom connector that composes
  calls, or that could send around them, never inherits an inner verdict; the
  invocation withdraws the mark and the write is unknown.
  Write inference also needs positive evidence before relaxing timeout or auth
  reconciliation. `LogicalCall.auxiliaryReads` records each auxiliary GET or HEAD
  at dispatch, without method-override headers, separately from the call-owned
  requests in `sent`. Its physical read proof does not depend on the served
  tool's write classification. `onlyAuxiliaryRequests` requires exactly one
  boundary that owns the logical call and declares complete request tracking
  (`tracksEveryRequest`), at least one dispatched auxiliary resource read, and
  no dispatched call-owned request or kit auxiliary falsely declared as a read.
  The kit records `blocksAuxiliaryProof` at dispatch for an `effect: "read"`
  request without physical GET/HEAD proof; `nonReadAuxiliaryDispatched` retains
  that blocking fact on the logical call. The
  invocation's `mayHaveWritten` is true
  for an entered write unless the call answered with that proof; an explicit
  `writeOutcome: "unknown"` always overrides the relaxation. Empty or partial
  ledgers, token POSTs alone, multiple boundaries, custom `api()` and
  `remoteMcp()` connectors, deadlines, and caller cancellation supply no such
  proof. Only maintained providers have the internal tracking declaration;
  they must route every dispatch through their tracked transports. The kit
  still classifies auxiliary POSTs and method-overridden GETs as writes for
  reservation and replay; the effect label does not change those rules.
  Their dispatches block auxiliary-only inference even beside a genuine
  auxiliary read, and count as call-owned requests for write-failure settlement,
  including a 503 or a mapped `unavailable` verdict. Guarded authentication
  token POSTs supply no read proof,
  but do not invalidate a later auxiliary resource read. A conservative
  timeout withdraws `answered`; a conservative auth failure does so only with
  an empty resource ledger, also withdrawing that ledger's private known-failure
  mark before advice is composed. A refused call-owned write keeps its
  `answered` evidence and resource-refusal provenance only with a complete
  ledger proving the refusal covers the whole call; its auth recovery advice
  uses the same known outcome as program accounting. Partial or unknown ledgers
  remain conservative, as do token-mint and auxiliary auth failures without
  positive resource-read proof. Auth failures with no
  call-owned dispatch, including credential refusals and static-OAuth refresh
  failures, keep conservative program accounting and reconciliation wording.
  Pre-dispatch refusals mark themselves: `api()`'s unknown tool and argument
  validation, `remoteMcp()`'s allowlist and non-auth failures before its
  `tools/call` is sent, and GitHub's REST target check and token mint. Auth
  failures after entering a write with an empty resource ledger remain unknown,
  including a `remoteMcp()` connect or initialize 401 before `tools/call`.
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
  connector's code cannot advertise a retry. Advice to send again (a rate
  limit's "back off before retrying", a token or OAuth preflight's "then
  retry authorization") is a segment of its own, attached with
  `resendAdvice` in `src/errors.ts` where it is written and never part of
  the error's message. Output composes it only once the outcome allows it:
  `classifyCallError` for a direct caller, unless the write is already
  unknown, and the invocation after its verdict (it classifies with
  `classifyWithoutAdvice`). So no redaction of a private argument, no
  wrapper's rewording, and no preflight failure after an earlier dispatch
  can leave it on an unknown write, while a read and a known refusal keep it.
  Key-reuse advice ("reuse this key", "cannot repeat the write") needs more:
  proof that its key protects the whole logical call
  (`keyProtectsLogicalCall`). Every resource request dispatched under the
  logical call, from any ledger, is recorded on it once per dispatch with
  its method and the genuine key it carried (`ProviderRequest.key`, set by
  `callRest` only for a key fetch sends as given). The advice stands only when
  exactly one boundary was entered, the invocation's object owns it as for
  `knownForLogicalCall`, that boundary tracks every request, and exactly one
  dispatched request was a write, carrying the named key; a request counts as
  a read only with positive operation/tool classification and a recorded
  GET or HEAD (`readRequest`); method-override headers make it a write. A composite, a
  wrapper, a second write, an earlier unrelated key, or a call interrupted
  after two dispatches gets no such advice; the key stays a diagnostic, in
  the message and `uncertainCall.recovery`. The REST write tool's
  generated-key advice is a segment of its own (`keyResendAdvice`), which the
  invocation composes only under that proof and `classifyCallError` composes
  for a direct caller of the one boundary that sent the key.
  An authorization or credential handoff on an
  unknown write says to re-read the target before any fresh call instead of
  "retry the original call" (`src/authorization-handoff.ts`). The guarded
  `HttpClient` owns transport attempts through `src/guarded-transport.ts`;
  Node uses the owned sender in `src/http/node-transport.ts`, installed by
  `/node` when `listen()` starts serving. Reads keep their retry advice. Every maintained
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
  keep their handoff. A write answered 401 is one of these unless its
  transport declares `authBeforeExecution` evidence that matched, and it
  keeps an authorization code and handoff whatever failure surfaced after
  it, with no wait.
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
  `connector_call_failed` with its reason as `cause` (a redacted copy of the
  same class where output redaction applies, as on `remoteMcp()`) and its
  class and code in `details`. No invocation exists to report it as
  `write_outcome_unknown`. The caller's own abort reason still passes by
  identity for a read and for a served call, whose timeout passes through
  unchanged for the invocation to report.
  The catalog-driven `test/provider-failure-sweep.test.ts` checks every API
  provider/tool on Node, fails on missing provider/tool examples or a
  dispatched failure bypassing the helper, and covers served write/read
  overrides with HTTP 503 for every tool and a connection reset after send
  for each provider/verdict representative. HTTP 401 recovery uses those
  representatives plus the distinct composite, auxiliary, owner-lookup and
  POST-as-read paths; every provider's full golden failure matrix still runs.
  Shared sender and real-socket evidence below own status/reset permutations.
  Local metadata
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
  SIGTERM/SIGINT. The listener stops accepting connections and closes idle
  keep-alive sockets plus accepted sockets that have not produced their first
  HTTP request, then waits for active responses, deferred work, and executor
  cleanup. `test/node.node.test.ts` covers shutdown after token adoption,
  rotation, and doctor with an unused connection and a live QuickJS execution.
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

Vendor error declarations may review structural text presence at fixed body
paths. The error boundary exposes only `present` and `nonBlank`, after
sent-secret redaction, and never the text. Reviewed recovery-token lists can
set a fixed `displayFacts` bound with a reason; other lists display eight
entries. Both reviews are snapshotted at connection construction and never
change classification or the operation's error-withholding policy.

Reviewed numeric error-body paths expose finite, nonnegative numbers only.
Nonblank numeric strings may be converted; empty or blank strings are absent.
The original text never reaches classification. These paths are also captured
at construction and cannot change error-withholding policy.

Native pools resolve names through a shared claimant index for listing and
calling, then use the existing invocation routes. Native recovery adapts only
Connecta error envelopes in `src/native-recovery.ts`; provider dispatch and
continuation enforcement stay in their existing owners.

### Contributor reference: owned Node transport dispatch

`src/guarded-transport.ts` is the platform-neutral runtime slot. `sendGuarded`
invokes a dispatch callback before legacy/fake sends; a transport declaring
`delaysDispatch` must invoke it exactly once at its last safe pre-send boundary.
The Node sender does this before a direct send or after CONNECT/TLS establishment,
before exposing the socket to undici's destination Client. A refusal there must
never reach the destination or acquire dispatch provenance. Each send owns its
Client/ProxyAgent and response lifetime, with HTTP/1.1, non-idempotent dispatch,
no interceptors and no redirects. No dispatcher, response, callback or signal is
cached across requests. This seam is transport policy; SDK protocol, auth and
request/coordinator ownership remain with their existing adapters.

### Contributor reference: OAuth credential transport seam

`sendCredentialPost` in `src/guarded-transport.ts` is a Promise platform leaf for
SDK-authenticated token, registration and revocation POSTs. It resolves the
owned policy, forces manual redirects and withholds native exception text/cause,
while preserving the caller's original abort reason. The SDK still constructs
auth headers/forms and decodes the byte-safe response; this leaf supplies no
OAuth retry, grant, response-decoding or ownership orchestration.

`OAuthRefreshCoordinator.coordinatedFetch` accepts an optional final synchronous
`prepareCredentialRequest` hook. Production adapters resolve `guardedTransport(true)`
there before claiming a code/refresh grant, so an unsupported Node host consumes
neither. The base-fetch leaves in static OAuth and remote MCP call
`sendCredentialPost`; remote registration and disconnect revocation do so too.
D4 must preserve this preflight and the distinction between request-owned code
exchange and coordinator-owned refresh after claim submission. The existing
spent-token algorithm intentionally remains conservative after a submitted claim,
even if a later CONNECT fails before destination dispatch. D6 must preserve the
SDK JSON-RPC envelope distinction at the leaf: protocol POSTs are not credential
POSTs; forms and registration JSON are. Discovery GETs remain native fetch.

### Contributor reference: Node response drain

The Node listener counts active ServerResponses per socket. Once shutdown starts,
each finish/close removes its response; the last completion calls `destroySoon`
to flush queued bytes and close the connection. This also covers SSE whose
headers were sent before shutdown and pipelined responses waiting behind an
inflight response. Normal keepalive remains Node-owned until shutdown. Idle and
never-admitted sockets retain their separate close paths, and the configured
shutdown deadline still forces exit 1 for work that never completes.

### Native auth programs (contributor)

Inbound verification, shared authentication admission, machine-token verification,
static OAuth and the SDK-facing downstream OAuth provider compose private native
programs. `auth/native.ts` selects registered implementations by the current
function identity; an original Promise shell enters its own implementation
without re-reading an overridden method. Class registrations retain their
original method and prototype/key separately, so instance, inherited and
prototype decorators can delegate to a saved original without recursion. Custom
adapters and overridden methods retain their Promise boundary and original errors.

`auth/native-call.ts` provides the canonical `RequestScope` Context from the
existing call view. Native grant preparation and storage reads execute inside
that Context and refuse a closed owner; no second request-identity table is
introduced. Keeping that call-only module separate also keeps downstream call
services out of metadata and operator UI imports. Native storage uses D2's
registered storage programs; custom stores remain one-operation Promise leaves.

`authFlow` composes yielded Effects while delivering original typed failures to
local auth policy catches. Interruption remains interruption, runs yielded
cleanup and never becomes a diagnostic Cause. A fetch's settlement observer
cancels a late body. The resource sender records only retained status/refusal
facts after cancellation; it cannot renew a call capability or send another
request. Synchronous abort observers finish recording those facts before native
wait cleanup removes them.

Admission charges track the actual settlement of SDK, crypto, fetch and custom
Promise leaves. Submitted native storage work has independent settlement so a
caller-facing deadline cannot release its charge early. Isolate-wide admission
state remains scalar charges, counters and weak reachability; no request-owned
client, signal, body or Promise is cached across requests. Organization cache
TTLs, lookup ordering and rate-limit backoff remain unchanged.

Admission composes explicit native continuations rather than suspending a
generator that contains its charge token. The workerd collection regression
holds live middleware work charged, ends a different invocation, then proves
its unreachable charges are collectable. Neither deadline nor abandonment
releases a charge; only actual settlement or proven unreachability does.

Refresh claims still transfer ownership synchronously with claim-CAS submission,
before its answer. The bounded native coordinator starts without request/call
Context authority and may persist a rotation after its caller closes. A closed
caller cannot consume that result or resume sending. The cross-request refresh
join deliberately crosses a Promise boundary so workerd resumes each waiter in
its own request. Code exchange remains request-owned and one-use. Epochs,
permanent spent fingerprints, physical-attempt guards and pre-claim transport
preflight are unchanged.

`authStorage(storage, key, args, beforeSubmit?)` admits the ownership hook and
native/custom storage invocation in one JavaScript reaction. Its public
Scheduler delegation suppresses automatic yield only during that initial
reaction; a microtask restores parent scheduling before pending I/O resumes.
The four hook sites are `updateGrant`'s guarded write and `claimRefresh`'s
unknown-lease refusal, ambiguous spent-token write and new claim. A forced
scheduler regression covers both native and custom stores; real pending TCP
I/O, pre-submission cancellation, synchronous failure and unknown CAS outcomes
retain their distinct ownership and exactly-once settlement rules.

Intentional leaves are the Clerk and MCP SDKs (including their callback methods),
platform fetch/body readers and Web Crypto, custom identity/gate/sealer/storage
hooks, and the reset-settlement observer required by the callback route. Native
programs compose around those leaves directly. Public Promise APIs, SDK method
signatures and published private class declarations remain unchanged; only
`runtime/run.ts` starts fibers. SDK telemetry remains disabled, and raw SDK,
body, storage or Cause diagnostics never reach operator records.

The declaration comparison retains 86 of 88 reachable files byte for byte.
The two exact exceptions swap only adjacent `title` / `instructions` members
in the inferred provider and Google Workspace schema declarations; both keep
the same `Field<unknown, unknown, true>` type. Both owning source files are
unchanged. A narrow machine check restores only those two exact adjacent
pairs and requires byte equality, with no other type, export or reference
change. All 88 declarations still exclude Effect and have complete references.

The superseding 2026-10-25 D3/D4 cost ruling authorizes only Worker
`maxGzip: 785000` (previously 760000) and Clerk `maxGzip: 85000` (previously
63087). Official cached Node 22.23.4 / zlib 1.3.1-e00f703 measured Clerk at
47,688 -> 80,961 bytes gzip (+33,273): the generated SDK is unchanged, while
native Effect adds 91.8 KB raw plus the native helper and small auth-source
growth. The isolated D4 candidate measured Worker at 762,666, root at 377,177
and D1 at 88,321 bytes gzip. Optional-graph optimization brought UI to 342,955,
so the earlier unused UI allowance is revoked and its original 345000 cap
remains. Historical baselines, root/D1 and all other caps, dependency pins and
security/API gates remain unchanged. These independent measurements do not
predict a combined gzip by addition; final artifacts must be rebuilt. Native
registration, decorated fallback and request/native-storage semantics also
require a smoke through an actual minified production bundle. Final post-hook
official artifacts measure root 377,290, D1 88,321, Clerk 80,959, UI 342,959
and Worker 762,774 bytes gzip, all within those caps.

### Native remote MCP programs (contributor)

Remote MCP connection joins, credential and epoch checks, catalog intake,
negotiation, calls, resources, Skills, auth and status compose native programs in
`connectors/remote-mcp.ts`. `catalog-cache.ts` owns native SDK cache reads,
chunked publication, generation fencing, complete refresh acceptance and listing
serialization; `connectors/negotiation-cache.ts` owns native negotiation storage.
The published connector, cache and SDK callback methods remain Promise shells.
Native consumers select those programs through `authCall` / `authInvoke` by
current function identity. Each original shell enters its own immutable program,
so a decorator or inherited delegate can call a saved original without recursion.
`invocation-auth.ts` follows that same identity dispatch for local credential
checks. The remote call registers its final original function with
`runtime/call-entry.ts`, preserving invocation validation, policy and call services.
A replaced function cannot inherit that native call proof.

Connector and cache state use the canonical `RequestScope` from the existing
view services. The shared connection provides only that request owner, never the
first waiter's call services, credentials or budget. SDK cache callback edges
restore that same owner. Every operation captures its own generation, credential
identity and listing binding before waiting; a later listing cannot adopt an
abandoned publication. Request closure revokes the connector and cache scopes.
No client, transport, response, signal, promise or live request Context is shared
across inbound requests. D4's bounded refresh coordinator retains its separate
ownership, synchronous submission gate and waiting-request handoff.

Two deliberate Promise waits remain: a connect waiter receives the Deferred's
answer in its own workerd request continuation, and a serialized listing waits
for a Promise turn before running its native program. Cancelling a queued
listing releases its turn only after its predecessor, so it cannot unlock a
listing still using the SDK cache binding. Cancellation after entry ends that
listing's publication without starving a live sibling. Teardown starts native
finalizers before checking caller ownership and joins their bounded independent
settlement. Only `runtime/run.ts` starts fibers.

Physical sender Promise observers retain response status, write refusal and
redirect facts even when a native waiter closes first. The call's abort path
yields one scheduler reaction before settling those facts, including when the
SDK rejects synchronously from the abort event. These observations grant no live
authority: a closed caller cannot renew, send, publish a cache result or consume
late output. Source/effective write classification, one physical attempt,
withheld transport text, explicit downstream tool errors, input suspension,
final output validation and original abort/error identity remain enforced.

Intentional leaves are the pinned MCP SDK's actual client/transport operations
and schema validators, the owned one-attempt sender and platform fetch,
Web Crypto fingerprints, bounded byte/SSE stream readers and body cancellation,
and unregistered custom token, credential, storage, sealer or observation hooks.
SDK `ResponseCacheStore` is the callback contract, not a replacement client or
protocol implementation. Its storage and refresh algorithms are native programs;
its Promise shells are required SDK edges. The connector keeps modern/legacy
negotiation, header mirroring, cache partitions and TTL semantics. No SDK/Effect
pin or supported protocol surface changes.

Native storage and activity selection in `runtime/native-storage.ts` checks the
current methods against their original registered identity, and selected programs
check again when executed. A replacement or decorator owns the Promise fallback;
restoring originals restores native composition. Registry storage namespaces
select the underlying current methods at dispatch, including namespaces created
while a source method is decorated. Original SQL shells call their own native
program directly. Tests cover current and previously selected programs, own and
inherited saved-original delegates, get/set/CAS and activity record/list,
restoration, typed failures and interruption. The D4 native proof fixtures install
their intentional throwing Promise shells before registration, so they establish
native composition without authorizing bypass of later replacements.

`remote-mcp-native.test.ts` runs native SDK/cache/request-boundary cases on Node
and workerd. `remote-mcp-native-bundle.node.test.ts` additionally loads an actual
minified production bundle to verify call/cache registration, request Context,
native storage, saved-original delegates, custom replacements and closed-owner
refusal. Existing wire, physical-attempt, cache and OAuth lifetime suites remain
the compatibility evidence; provider golden observations remain unchanged.

### Native upward MCP orchestration (contributor)

`routes/mcp.ts` composes server preparation, native catalog selection, exchange,
output redaction and response-owned request cleanup as native programs. The
pinned SDK's modern `createMcpHandler` and a fresh stateless legacy JSON transport
remain the protocol implementations. Effect 4.0.5's public MCP adapters cannot
serve the required fresh legacy contract; this implementation does not adopt
Effect McpServer. Each inbound request constructs fresh servers and keeps its
admission scope until its response body ends, fails, is cancelled or reaches its
existing deadline. Authentication and endpoint admission precede body dispatch.
The declared-agent observation stays after successful endpoint admission and
before listen classification or body dispatch.

Meta tools, native tools, Skills/resources and upward auth/input continuations
compose registered native programs. SDK registration signatures and Promise
shells remain unchanged. Current-method identity governs consumer dispatch;
each original shell enters its own immutable program, so decorators, inherited
delegates and replacements retain authority. Catalog policy failures reach
native consumers as ordinary typed failures. Invocation still owns validation,
classification, read-only enforcement, dispatch, write settlement and accounting.
Its input and result callbacks select native programs while custom synchronous
or Promise callbacks retain their original behavior.

The canonical `RequestScope` travels through SDK callback edges and registry
views. A continuation's durable nonce claim still precedes dispatch, retains its
caller, endpoint, arguments, TTL and round bindings, and cannot authorize another
write after an ambiguous result. Retained classification and settlement facts
never reopen a closed request. A finished program can still shape its response
and retained recovery facts after its connector authority closes; the inbound
request signal still cancels that response work. Neither path grants another
dispatch. Agent-output redaction, withheld diagnostics,
secret registration and result bounds retain their existing pure algorithms.
`upwardStep` is only a typed generator adapter: it lets `authFlow` deliver the
original ordinary failure to a local catch without converting interruption.

Concurrent authorization failures share one request-owned producer and Deferred
answer per connector, including failures and the unknown-write advice variant.
The existing `forkRequest` seam starts that producer under the request Scope;
its Context contains only the canonical request owner and scheduler. A waiting
call's budget, credentials and cancellation do not own the producer. Closing the
request revokes it, and a closed request cannot consume or restart its handoff.
Only `runtime/run.ts` starts fibers. Admission and downstream refresh/connection
waits retain their deliberate Promise handoffs for workerd's waiting-request I/O
context.

Intentional leaves are actual pinned SDK handler/transport/server operations,
SDK schema and request-state codecs, platform body readers and cancellation,
Web Crypto hashes, vault owner/seal/open/sign/verify methods and unregistered custom
identity, credential, storage, executor and tool callbacks. Connecta's OAuth-link
binding, TTL, progress, closing and one-use claims are native orchestration around
those leaves. The supported protocol and unsupported-feature refusals remain
unchanged. Native consumer, failure, decorator, sharing, close and minified-bundle
regressions live in `upward-native.test.ts` and
`upward-native-bundle.node.test.ts`; existing wire, continuation, redaction,
physical-attempt and body/admission suites remain compatibility evidence.

The combined native/operator graph has a measured contributor bundle allowance
in PR #1060: the UI gzip cap is 346,000 bytes, with its historical baseline
unchanged. The official full checker measured 345,228 bytes after regenerating
the merged UI assets. Removing unused Invocation/Catalog registration retention
returned the public Worker entry from 198,744 to 77,426 bytes; live minified
Context, inherited-method, decorator and restoration proofs retain native
composition. Root, example Worker, public Worker, D1 and Clerk caps remain
unchanged. This cost decision grants no later request-body-limit allowance.

### Catalog operation vocabulary (contributor)

The standard hatch privately registers bounded vendor operation text against its
ApiTool identity; `apiConnector` transfers those facts to the constructed
connector. `operation-vocabulary.ts` contains only pure lexical/cache logic and
types. Catalog discovery consumes those facts after loading and classifying a
complete visible catalog. It never imports a provider or an operation index,
parses operation contracts, invokes a handler, or authenticates. Matching requires
all terms in a single operation and a visible destination hatch. Endpoint,
connector and tool grants are checked on every query, outside the request-free
cache. Exact authored names and complete authored matches precede API pointers;
ordinary result limits, offsets, catalog failure disclosure and byte bounds apply.
The published discovery contract states compilation, query and cache bounds.
No request identity, signal, credential or promise enters a vocabulary cache.

### Authenticated body-bound cost (contributor)

The separate #860 change has a measured allowance only for the example Worker
gzip cap, from 785,000 to 786,000 bytes, with its historical baseline unchanged.
The official full checker measures 785,036 bytes against D7's exact 784,948-byte
lower graph, an actual 88-byte increase. It reuses the bounded platform body
inspector, preserves native orchestration and avoids a new reader lifecycle.
Root, UI, public Worker, D1, Clerk and asset caps remain fixed. The cost ruling
does not approve protocol, cancellation or authority semantics.
