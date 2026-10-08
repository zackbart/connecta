# Architecture

One Web-standard `fetch(request) => Promise<Response>` handler, a long-lived
registry behind it, and a strict rule about what may be imported. Everything
else in this repository is a detail of those three things.

Read [PRINCIPLES.md](https://github.com/zackbart/connecta/blob/main/PRINCIPLES.md)
first; this guide explains the shape and where each subsystem lives. The surface itself belongs to
[meta-tools](./meta-tools.md), [code mode](./code-mode.md), and
[inbound auth](./auth.md).

## The two lifetimes

Almost every bug in this codebase is a lifetime mistake, so the split is worth
stating before anything else.

**Per isolate, built once.** `createConnecta(config)` returns
`{ fetch, registry, describeConfig, close }` (`src/index.ts`). The `Registry` owns the connector
set, address resolution, catalog caches, observed output schemas, connector
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
| 1 | `/connect/<connectorId>`, `/oauth/callback/<connectorId>` | GET-only browser OAuth routes, before wildcard OPTIONS. Both verify the initiating user and management permission, independent of the UI. |
| 2 | MCP preflight | Allowed `OPTIONS` on `/mcp*`: 204 without admission or auth. |
| 2 | Other `OPTIONS` | Auth metadata first, otherwise compatibility CORS preflight. |
| 3 | `/.well-known/*` | Auth metadata, or 404. |
| 4 | `/health` | Open and payload-free: health, executor, admission, and deployment metadata, with drift as stable short hashes. |
| 6 | `/mcp`, `/mcp/<pool>` | Admission, then auth, then a request-local MCP server. Body-confirmed modern listens skip admission and are refused after auth and SDK validation. An undeclared pool, a refusing grant, and a throwing grant are one identical 404; see [pools](./auth.md#pools). |
| 7 | Other paths | 404. Custom HTTP routes belong to the deployment. |

Every response leaves through `withSecurityHeaders`. HTML uses one common
security-header helper, including status and error pages. Operator shells
allow same-origin scripts and deny framing. Clerk pages also admit the validated
loader origin, the exact Cloudflare CAPTCHA script and frame host, Clerk images,
and first-party or blob workers. Local Clerk sign-in adds a nonce for its bootstrap.
Sandboxed artifact documents retain their separate script and framing policy.
`test/server-route-contracts.test.ts` pins the ordering and the exact refusal
bodies; it exists because the ordering is invisible in any one file and a
reordering reads like a harmless refactor.

An admitted non-preflight `/mcp` request then takes five steps in
`src/routes/mcp.ts`:

1. **Admit.** Modern `subscriptions/listen` requests take no permit: their
   mirrored method and parsed body must both name the unsupported method.
   They still pass auth, pool grants, and SDK validation, then receive HTTP
   404 with JSON-RPC `-32601`. Their body classification and auth share the
   configured request lifetime, starting before classification. Other requests
   take one permit from the deployment-wide pool, taken before auth so an
   unauthenticated flood costs a permit rather than a Clerk lookup, and held
   until the response *body* completes, the caller leaves, or its configured
   lifetime ends, not until the handler returns.
2. **Authorize.** Machine tokens precede interactive providers. A provider's
   synchronous credential recognition selects the sole verifier for an explicit
   credential; a refusal never falls back to another identity. Human routes
   reject machine credentials without verification. With no recognized
   credential, configured providers are tried in order. A 401 takes its
   challenge from the actual protected-resource metadata owner. No providers
   means open development and warns at construction.
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

The meta-tool handlers are thin. The work sits in six modules the registry owns
or hands out, and a change usually belongs in exactly one of them:

| Module | Owns |
| --- | --- |
| `src/registry.ts` | The connector set, identity-scoped views, personal storage partitions, address resolution, catalog TTL/persistence/completeness, refresh single-flight, connector health, per-connector call limiters, and drift. Construction-time refusals live here. |
| `src/catalog-service.ts` | Request-local listing, search, and describe. Caches catalogs inside one request, fans discovery probes out under deadlines, and opts agent reads into the runtime's deferred catalog channel when one exists. |
| `src/invocation.ts` | One tool call: argument validation, call admission, one-attempt timeout, provider retry hints, result unwrapping, size capping, and the activity record. |
| `src/catalog.ts` | Ranking, description summarizing, and the compact and TypeScript schema renderers discovery shows. |
| `src/result-shapes.ts` | Bounded runtime-only inference and merging for output shapes learned from successful read-only calls whose providers declared none. |
| `src/program-writes.ts` | Trusted-pool write accounting: write budgets, dispatch draining, and known or unknown outcomes. |

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

| Response and flag | Raw stream abort / cancel | Connecta source abort / cancel | Admission after response; next request |
| --- | --- | --- | --- |
| Heartbeats, no flag | neither | neither | active 1; 503 |
| Idle with a pending timer, no flag | neither | neither | active 1; 503 |
| Heartbeats, request signal enabled | abort only | both | active 0; 200 |
| Idle with a pending timer, request signal enabled | abort only | both | active 0; 200 |
| One chunk, then no timer or I/O, either configuration | neither | neither | active 1; 503 |

The last row is a different failure. The client observed the response end
*before* its planned disconnect, although the source never closed itself.
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
`compareAndSet(key, expected, next, options?)` is an atomic claim: `null` means
absent (expired counts) on the way in and delete on the way out, and a
successful write takes the same optional `ttlSeconds` as `set`. SQL TTLs are
created and checked by the database clock inside each statement, so isolate
clock skew cannot expire a live holder's record. Each SQL claim
is one statement, which SQLite executes atomically and D1 serializes on its
primary. Everything that must claim a key exactly once relies on it with no
read-then-write fallback: artifact head swaps, access-token issuance and
capacity, OAuth handoff ownership, single-use connect links, every downstream
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
the file (INV-6).

Result paging stores each oversized result for 15 minutes, chunked so a page
reads only what it covers. Its bounds (`results.maxStashBytes`,
`results.maxStashEntries`) are the deployment's, not an isolate's: every charge
is a row in one ledger record, booked by compare-and-set before any chunk is
written, so isolates and processes sharing the store see one count. A lost swap
backs off and re-reads; only a full ledger refuses. Each chunk's TTL is what
remains of its charge's deadline, so no chunk outlives its charge. A full
stash returns the successful call's preview and a paging-unavailable notice
rather than a result id. The shared storage cases live in
`test/storage-contract.ts` and `test/sql-storage-contract.ts`.

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

### Errors and records

A failure has two audiences with two rules. The agent that made a call may read
the downstream's own answer to it: a JSON-RPC error message, an HTTP 4xx
refusal, `isError` content, or the words a handler put in a
`ConnectorCallError`. Each upstream request owns a memory-only sent-secrets
set. Every connector context links its local set into that request, including
listing, discovery, registry refresh, OAuth refresh, and provider handlers.
Direct meta-tool invocations and program runs get fresh request identities;
all operations within one HTTP request share its identity. Credential-slot reads, static
auth headers, and outbound bearer tokens join the set, including tokens
rotated during a call. Before any diagnostic is truncated or returned, the
agent boundary replaces these values and their auth prefixes, mixed JSON
escapes, URL encodings, and base64/base64url forms with `[redacted]`. Final
transports register sensitive headers and query values after assembling the
request; custom API handlers use `ctx.fetch`. Values shorter than eight
characters do not enter the matcher, because a short Basic username would
rewrite ordinary prose. Connecta's own messages never quote a credential.
The matcher is cached until its set changes; the empty set has a fast path.
`redactAgentOutput` is the agent-facing choke point. Every meta-tool exit,
including errors, and every host-to-guest value or rejection passes through
it. Both MCP transports also pass their serialized response through it, covering
JSON-RPC errors, HTTP diagnostics, structured content, and paging responses.
Per-call redaction remains before diagnostic truncation, paging, emits and
artifact writes. Paging stores only request-redacted text before encoding
chunks, so a later request needs no original credentials. Programs retain the
request set only for the run so later outputs cannot reconstruct an echo.
Discovery registers sent credentials under the same rules, including
`server/discover`, legacy initialization, and every `tools/list` page on a
reused transport. Remote MCP sanitizes the complete listing before retaining
request-local definitions. Registry intake also sanitizes custom, API and
provider listings before drift observation, fingerprinting or either catalog
cache. Failed listings are redacted at the same intake before a shared refresh
publishes its failure to another request. Successful catalog caches and result
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
a provider's `surface`) with a missing or unrecognized discriminant throws
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
ordered, the artifacts connector appended, `serverInfo` named and versioned.
Routes and meta-tools read limits from it (`ServerOptions.config`) instead of
from fields copied out one at a time. `Connecta.describeConfig()` is a
secret-free snapshot of it, built once (`src/describe-config.ts`): an allowlist
serializer that copies named fields and never spreads a config object, plus
`Connector.describe()` on `remoteMcp()`, `api()`, the providers, and the
artifacts connector. Header values, keys, client secrets, credentials, URL
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
name, title, kind (`"mcp"`, `"api"`, or `"composed"`), a maintained skill, an
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
check tools read instead of keeping provider lists. All twenty providers
live in their own folders. The eight hosted implementations, including the
MCP branches of Notion, Vercel, and Cloudflare, use reviewed presets over
`remoteMcp({ classify })`. The eleven API-only factories retain an internal
adapter to the same definition and description-stamping path. GitHub composes hosted tools with a scope-enforced REST complement. The other
mixed providers still select one interface; capability reconciliation is planned in
[#705 item 5d](https://github.com/zackbart/connecta/issues/705).

`remoteMcp({ classify })` is the public way to declare what a downstream's
tools do: `{ tools: { name: "read" | "write" | "destructive" | { verdict,
reason?, schemaDigest? } }, unlisted?: "hide" }`, validated at construction. It fails closed
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
connector (INV-11), caches and persists exactly what `listTools` returned
(manifest version 3), and classifies those facts on every read into fresh
objects, so neither a cache layer nor a decorator holding a served or listed
tool can carry a verdict. The request-scoped catalog also owns a deep copy
and returns fresh copies to discovery and invocation. Each connector call
receives a separate deep copy of its definition, so mutations cannot change
classification, schemas, or write accounting later in the same program.
A restart onto a catalog persisted under an older
review applies the current one; a 0.28 (version 2) catalog loses its
read-only claims, which may be an older classifier's, and is refreshed on
first read. During refreshes the deployment already asked for, the registry
counts drift against the same record, and `scripts/drift-check.mjs` compares
its names with published inventories. The internal `withVettedCatalog()`
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

## Optional deployment modules

`createConnecta` takes closed typed `ui`, `vault`, `activity`, and `artifacts`
slots, with factories at `/ui`, `/credentials`, `/activity`, and `/artifacts`
and machine tokens at `/auth/access-tokens`. Root exports the contracts, never the implementations, and there
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
`problem` — which picks fixed on-screen copy and a fixed fix prompt — and the raw
text goes to the server log. The OAuth and credential Test notices keep the
same rule: those routes answer a downstream's failure in fixed words (a Test
answers only `{ ok }`), log its text, and the page picks a sentence by outcome
without ever rendering what the server sent. Credential handoff URLs exist only while the UI is
mounted; OAuth callbacks never need it.

Its appearance is one token layer, and it is not the UI's alone: every page
connecta shows a person — the operator shell, the OAuth callback, a browser's
404, the artifact frame and Markdown pages — reads it. `src/operator-ui/tokens.css`
resolves every color, radius, and font through a custom property and mixes the
rest from those with `color-mix`; `page.css` holds the base typography and the
primitives (shell, masthead, buttons, badges, messages, the one-message status
page). The UI's `browser.css` imports both, and the build writes the same CSS,
minified, into `src/page-styles.ts`, a module of two strings that core imports
without the UI bundle, so an OAuth callback still renders with the UI omitted.
`renderPage` in `src/branding.ts` is the one layout: head, favicon (the default
is linked only when the UI serves it), `data-scheme`, the tokens with the theme
after them, and the masthead. So `branding.theme` only has to append a `:root`
block after the stylesheet. The five tokens it accepts are gated in
`src/branding.ts`, each by a narrow syntactic check: deployment config reaches a
`<style>` element here, and an unvalidated value would be CSS injection. The
dark palette is the same tokens under `prefers-color-scheme`; `colorScheme` pins
one with a `data-scheme` attribute on the page, and the artifact viewer passes
the same attribute into a Markdown page, never into authored HTML.

The artifacts module — `artifacts()` from `/artifacts`, implemented in
`src/artifacts/` — is the one module that contributes a connector. Core
appends its prebuilt `artifacts` connector to the configured set, so its reads
and writes take the same catalog, invocation, admission, and activity paths as
any other connector; the slot binds its optional refresh runner once, after the
registry and executor exist, and a deployment
without it has no connector, no guide, and no artifact storage traffic. Its
writes are not read-only anywhere — `call_tool` refuses them and discovery
lists them approval-required — and programs may call them only in trusted pools. Approval belongs to the
host. Artifact versions remain immutable and reversible. The
module needs `publicUrl`: the links it hands out are shared, so they must never
come from a request's `Host`.

An artifact can version an `execute_code` program and target data document with
`set_refresh`, on a manual, daily, or weekly schedule. The deployment calls
`artifacts.runDue()` from a Node timer or Worker `scheduled()` handler; core
starts no background jobs. One tick scans at most 1,000 heads and starts at
most 10 due runs. Every run uses the configured executor, host-call budget,
and watchdog, with a registry view containing only shared connectors. The
owner admitted to `set_refresh` is stored with the program. Every run rechecks
that identity's current `connectorAccess` and pool grant, including continued
access to `artifacts.set_refresh`, then intersects those grants with shared
connectors. Revoking either grant stops later runs.
Refresh programs always use read-only trust, so a refresh writes nothing. A refused call fails the
entire refresh even if its program catches the error. The head CAS claims one
run per artifact; the data commit checks the claim ID and program version in
the same CAS. The claim deadline starts before executor admission and aborts
a queued or active play when it expires. An expired old run cannot publish over
a newer claim. Run history retains 50 records with bounded logs. A failure leaves the
last good data intact and marks the artifact stale. Library and viewer show
only outcome enums and times, never downstream messages or logs.

With the operator UI mounted, `/artifacts` lists the team pages and
`/artifacts/<id>` opens one. The shell contains no page data. It reads the
artifact through an authenticated JSON route with the operator UI's inbound
identity and connector visibility, then passes the document into a sandboxed
frame. Snapshot links pin the view and document versions. The frame's response
CSP gives scripts an opaque origin, refuses fetch, XHR, images and other
unlisted requests. External script, style, and font origins default to none;
a deployment opts in to each one it trusts with page data. The shell tightens
its own `frame-src` to `'none'` after the fixed bootstrap loads and before it
hands over the page,
so a page script cannot navigate even its own frame to send data in a URL.
This browser boundary is covered by Chromium tests, including a
`document.open/write` rewrite.

`artifactOrigin` optionally names a distinct HTTPS origin for these pages.
The main host redirects every `/artifacts` path to it; the artifact host
answers every other path, including `/mcp` and operator APIs, with 404. The
artifact shell still uses the same inbound auth providers and checks the
identity on each data read. The bare shell and fixed frame bootstrap carry no
artifact data, so a visitor can reach sign-in before an authenticated read.
Bearer tokens in browser localStorage belong to one origin: signing in on the
main host does not sign in on the artifact host. A redirected visitor enters
the token again there; the redirect carries no credential. Cookie or session
auth likewise depends on the provider admitting that separate origin.

Storage is an `ArtifactStore`, and `kvArtifactStore` is the reference: over any
`KVStorage` with `compareAndSet` and `list`, one head record per artifact is
the only key ever compared-and-set, earlier versions sit beside it immutable,
and bodies are content-addressed — in the key-value store, or in R2 through the
Worker example's `r2-artifact-blobs.ts`. Storage without `compareAndSet` is
refused at construction, because a write that cannot swap its head can lose a
teammate's edit. Every
rule lives once, in `src/artifacts/operations.ts`: a write checks its base
against the one stream it touches, so of two writes from the same base exactly
one wins and the other is a `conflict` carrying a bounded `current` map, while
a head that moved for an unrelated reason is re-read and retried rather than
reported. Patches match exactly once or change nothing, rollback is a new
version reusing an old body, and the limits are checked on every write.
Validation is a hand-written tokenizer and CommonMark subset rather than a
dependency, because it is a lint: the page's CSP is the boundary.

Who made a version is the one fact a built-in connector needs that
`ConnectorContext` deliberately does not carry. `src/connector-caller.ts`
attaches the admitted identity beside the context on the request's scoped
view, the way the OAuth sealer rides beside it — readable only by in-repo
code, set from the authorization and never from arguments
(`test/identity-scope.test.ts`, `test/artifacts-connector.test.ts`).

The same channel has exactly one other reader: maintained providers that act
as the caller downstream. Google Workspace domain-wide delegation
(`src/providers/google/`, first consumed by `./providers/gmail`) hands the
admitted identity to a deployment-config `subject` function and mints a
service-account token as whatever Workspace address it returns. The caller
carries whether an inbound provider *authenticated* it: an open deployment
admits everyone as the anonymous actor, and the function is never asked about
them. No caller, an unauthenticated one, or no address fails `auth_required`
before any request leaves. The provider never chooses the account and a
deployment's own connector still cannot read the caller (PRINCIPLES.md, INV-3; `test/google-workspace-delegation.test.ts`). Its tokens live in a
bounded module-level map, in memory only, keyed by the key's own digest as well
as the account, subject, and scopes. A mint in flight is shared across requests
the way the catalog and OAuth flights are: the owner settles a plain outcome
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

The core runs on stable Effect v4 through a compatible `^4.0.0` range; no API a deployment
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
and `npm run check:declarations` fails if what remains names an Effect type.

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
with the labelled timeout error *before* interrupting it, so work that honors
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

| Area | Shape |
| --- | --- |
| Requests (`src/server.ts`, `src/routes/mcp.ts`, `src/routes/oauth.ts`) | One fiber per `fetch`, tied to `request.signal`. An `/mcp` request's admission permit and every `McpServer` it builds live in a Scope the response carries out, closed when the body ends, fails, or is cancelled, when the signal aborts, when its admitted-request lifetime ends in that request, or at once if the handler fails first. If workerd runs none of those callbacks, the next request reclaims only the expired admission record; it cannot close another request's Scope. The OAuth callback is uninterruptible: a single-use code's exchange and catalog invalidation are one commitment. |
| Admission (`executor-admission.ts`, `call-admission.ts`) | Queued waiters are Deferreds settled by whoever removes them from the queue; a wait is one flat race of grant, Clock timeout, and signal. The uncontended path stays synchronous. Two controllers, as [#453](https://github.com/zackbart/connecta/issues/453) requires. |
| One tool call (`invocation.ts`) | One fiber: resolution, the read-only and schema refusals, admission, and the downstream attempt sit under a single `withDeadlineEffect`, whose expiry interrupts the call wherever it is. The permit is an `acquireRelease`; the connector call is `Effect.tryPromise` over the unchanged `Connector`. |
| `execute_code` (`execute.ts`) | One fiber whose Scope owns the run's signal and executor lease, so a result, a throw, the watchdog, and cancellation all release the lease and abort the signal the same way. The executor's `acquire()` and `execute()` stay Promises raced against the signal and `execute.watchdogMs`. Each guest host call is a fiber of its own. |
| Discovery (`catalog-service.ts`) | A request-scoped cache: one shared read per connector (`runtime/shared-read.ts`), settled by the read itself and carrying its own signal and the probe timeout whichever asker starts it. Each asker waits under its own deadline and signal, so one that times out or is cancelled fails alone, and the read is cancelled only once every asker has gone. Fan-out is `Effect.forEach` under the discovery concurrency. |
| Registry (`registry.ts`) | Catalog persistence and the result stash are programs over `Storage`. A refresh flight is a Deferred its publishing request completes, bounded by its owner's deadline (the default probe timeout when it has none); persisted-catalog writes take per-connector turns, each a Deferred its own request completes. Same-request loads share one read the way discovery's do. |
| Remote MCP (`connectors/remote-mcp.ts`) | Each request scope's state holds a Scope, each connection is a lease forked from it, and a connect in flight is a Deferred carrying the client it connected. Closing a session and the transport are each bounded to a second. |
| Downstream OAuth (`auth/downstream-oauth.ts`) | A refresh flight is a Deferred. Preparation follows caller cancellation; after dispatch, the HTTP exchange owns a 20-second deadline and the grant commit continues through the runtime deferred-work hook. |
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
- **The Node and browser leaves.** `node.ts`, `sqlite.ts`, the QuickJS
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
root, for a validator no clearer than the hand-written schema in `src/config.ts`; the
meta-tool inputs stay zod, which the MCP SDK bundles regardless. `HttpApi` for
the operator and activity routes cost about +100 KB gzip on `./ui` and +130 KB
on `./activity`, and matching the wire format meant opting out of most of what
it does: unowned paths fall through rather than 404, a wrong method is a JSON
405, and the content-type and size checks run before a body is read. The root
entry may import only `effect` itself (`test/purity.node.test.ts`). Effect v4's
area imports, such as `effect/http-api` and `effect/ai`, would have to stay
behind a subpath. APIs tagged `@stability unstable` can still change in minor
releases, which is why the root may import only `effect` itself: that is what
makes a caret range safe, and it lets a deployment that also uses Effect
resolve a single copy. Adopting an unstable subpath is its own pull request.

The stable `4.0.0` release was re-evaluated on 2026-10-01 with
[`scripts/probes/effect-v4-evaluation.mjs`](https://github.com/zackbart/connecta/blob/main/scripts/probes/effect-v4-evaluation.mjs).
Run `npm run build`, then `node scripts/probes/effect-v4-evaluation.mjs output.json`.
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
  catalog-drift.ts    reviewed classifications and the drift counts a refresh produces
  provider.ts         defineProvider(): the one maintained-provider shape
  activity.ts         optional history factory and best-effort recorder
  auth/               bearer, Cloudflare Access, clerk (optional peer), downstream OAuth (remote and static)
  executors/          the QuickJS pool and child (Node only)
  node.ts             listen() (Node only)
  d1.ts, sqlite.ts    the two storage drivers; storage/ holds the SQL core and key families
```

There are exactly two deployment shapes — `templates/node/`, which
`connecta init` copies with its container files, and `examples/worker/` — and
`test/deployment-shapes.node.test.ts` with `npm run check:examples` keeps both
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
  connector limiters, then the executor; Node's `listen()` calls it on
  SIGTERM/SIGINT.
- **Structural mistakes throw at construction.** A duplicate connector id, an
  invalid admission rule or limit, an unknown option at any depth, the old
  boolean `accessTokens` option, a missing executor, or an executor without a
  lifecycle brand:
  all refuse to boot (`test/config.test.ts`, `test/registry.test.ts`). Starting
  in the wrong shape is worse than not starting.
  Shipped `/worker` and `/quickjs` executors carry a non-enumerable global-symbol
  brand that survives package duplication and bundling. Custom sandboxes opt in
  through `customExecutor(executor, { lifecycle: "self-managed" })` from the root
  entry and own their termination and cleanup. Plain upstream executors need
  the `/worker` adapter, regardless of constructor name.

## Operator data contract

`GET /ui/api/config`, owned by `operatorUi()`, returns `OperatorUiContract`
from `connecta/ui`. `src/operator-ui/contract.ts` is also the browser's type
source. The response has `schemaVersion: 1`, `config`, `live`, and `you`.
`config` is the construction-time `describeConfig()` snapshot, filtered to
visible connectors, granted tools, classification overrides, and admitted
pools. Pool tools are the intersection with the caller's identity grants.
Every response is private, `no-store` JSON. Only GET is allowed, with the
same auth gate and identity partition as `/ui/data` and `/ui/connectors/:id`.

`live.connectors` carries status and problem codes, complete registry tools
with their final read/write classification, catalog age in milliseconds, and
last-call time/outcome. Catalog descriptions and schemas are allowed for an
authenticated reader; grammar-failing names and addresses become `<withheld>`.
Status prose, error text, credential values or suffixes, arguments, results,
and code are excluded. Static and unobserved catalogs have a null age;
persisted catalogs retain their original fetch time. Probes run with bounded
concurrency and the configured probe deadline, and release their scopes.

Last-call lookup requires the existing activity permission and read gate. It
scans up to 1,000 recent rows, filters connector/tool grants, and restricts
personal connectors to the caller's activity identity. Each retained fact
copies a validated timestamp and outcome only. A null call means unknown or
absent in that window, not proof of no calls. `live.activity` distinguishes
available, unconfigured, forbidden, and unavailable history. `you` names no
identity or auth material; it reports grants, root and admitted-pool trust,
and effective activity, token, artifact, and per-connector auth permissions.

`connecta doctor --config` fetches this authenticated contract and prints only
`config` as indented JSON. It requires the UI module and the existing doctor
authentication environment variables; it runs no diagnostic program, follows
no redirects, and prints no raw HTTP failure body.

The operator shell uses React, TanStack Router/Query/Table, Radix, cmdk and
Tailwind v4. Inter, CSS, JavaScript and dependency notices are hashed assets
under `/ui/assets/*`, served identically with immutable cache headers on Node
and Workers. HTML contains only mount points and escaped inert configuration;
it remains uncached. `generated.ts` is ignored and generated before build and
test; `check:operator-ui` detects stale assets and shared page styles. The UI
stays behind `./ui`, outside the root import graph. The identity-fenced store
still owns the existing page behavior; the new Phase 4 pages remain planned work
in #708. The typed data contract above is preserved.
