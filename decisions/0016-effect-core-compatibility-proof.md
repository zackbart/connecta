---
status: accepted
date: 2026-10-25
issues: [703]
supersedes: []
---

# Effect 4.0.5 routing and upward MCP compatibility proof

Contributor evidence for D.3/D.7 under [0009](./0009-effect-native-rewrite.md)
and [#703](https://github.com/zackbart/connecta/issues/703). This record preserves
the reviewed historical prefix spike and D7 protocol fallback. Production D3
now implements the once-per-handler public router plan below; its owning current
contract is the contributor HTTP dispatch section in
[architecture](../documentation/architecture.md#production-http-dispatch-contributor-reference).
No D3 budget acceptance follows from the earlier spike's approval.

The proof runner at [the final integration checkpoint](https://github.com/zackbart/connecta/tree/d0451f8e1ea683e0ac187058a58557a2df7cc282) compared the actual production dispatcher with a hash-pinned
test-only snapshot of `src/server.ts` at `ac511e6b` (the reviewed pre-D3 dispatcher,
unchanged from `a471a2a6`). Both graphs use the current lower native core and
identical fixtures. Only the legacy baseline is substituted; the production
candidate's source is unchanged apart from a test-only runtime marker. Exactly
one server module must be visited per graph, and baseline drift, missed graphs,
removed real route selection and broken unmatched fallthrough are mutation-tested.
The obsolete prefix-layer transform/fixture are retired in the production
PR (the workerd config now runs unmodified production), so intentional server changes cannot silently compare baseline to baseline.
The historical runner and rejected MCP alternatives were retired by #1069 after direct production regressions moved into the server and Node adapter suites. Commands below reproduce the historical checkpoint, not current verification.
Effect remains **4.0.5**, SDK **2.3.1**. D7 evidence and its approved SDK protocol
leaves remain intact. The historical sections below describe the spike rather
than current production routing.

## Separate verdicts

**D.3 measured behavior, not production-design acceptance:** the corrected proof
adapter passes the measured route, ordering,
body-lifetime and request-ownership cases on Node and workerd. The initial
candidate incorrectly served `/%68ealth` as health: FindMyWay decodes
unreserved escapes even with strict slash and case configuration. A raw-path
ownership guard corrects that while retaining the existing agent-bypass guard.
Independent review then found that the original 175-case matrix omitted the
actual `/oauth/client-metadata/<id>` route and its candidate prefix was wrong.
That earlier blanket verdict is withdrawn. The corrected candidate mounts
`/oauth/client-metadata/*` first after the agent guard. A real `remoteMcp()`
OAuth connector and a static-client negative fixture now exercise GET, HEAD,
POST, OPTIONS and DELETE across 14 exact/encoded/double-slash/agent paths.
The expanded candidate matches **245 exchanges per runtime**, including 70
CIMD cases, headers, exact serialized bodies, auth/UI/storage traces,
unconsumed request bodies, zero outbound I/O and zero CIMD admission charges.
Four additional agent-token list
exchanges per runtime cover both namespaces and protocol eras. An identical
fixed `Date.now` makes application duration fields deterministic in this wire
comparison; real timers remain enabled. Lifetime tests use the real clock.

The candidate also passes the existing Node route/admission/operator/callback/
identity suites, the 16-case downstream OAuth best-practice suite on both
runtimes, and existing workerd boundary suites through the supplied
Vitest transform. These tests execute actual application programs, not a
synthetic router list demo. This establishes the adapter seam, not acceptance
of an integrated D.3 implementation; refresh the matrix after lower rewrites.
The parent rejected this prefix-only, per-request-layer candidate as the final
D.3 design. Its measured behavior does not close the production dispatch item.

**Historical spike cost:** measured separately below; it did not approve a cap.
The production D3 ruling below supersedes the spike's pending budget decision.

**D.7 Effect McpServer replacement:** fails the required legacy stateless
contract independently of cost. `layerHttpRequestScoped` has a useful modern
request-owned implementation, but its public protocol type excludes legacy
protocols, and an untyped attempt fails construction with:

> McpServer.layerHttpRequestScoped does not support the sessionful MCP protocol 2025-06-18

`layerHttp` with the genuine public legacy adapter returns **400** for a fresh
legacy `tools/list`, demanding initialization and `MCP-Session-Id`. Initializing
issues a session, but the next fresh handler returns **404** with that session.
Both observations reproduce on Node and workerd. The probe builds a fresh
layer for every exchange; keeping a server alive is not a stateless fix.
Changing a legacy adapter's runtime descriptor would mean authoring protocol
semantics, outside a small compatibility adapter and this proof's scope.

## Existing proof seam and required production D.3 design

The reusable candidate lives in
[historical `router.ts`](https://github.com/zackbart/connecta/blob/ac511e6b033511229540481e70d33f6f14a7dc84/test/fixtures/effect-proof/router.ts):

- `matchModule(context, paths, handle)` returns an Effect of `Response | null`.
  Build a route-registration layer and use `HttpRouter.toHttpEffect` inside
  the existing `runEdge` fiber. Supply `HttpServerRequest.fromWeb(request)`.
  Configure `ignoreDuplicateSlashes: false`, `ignoreTrailingSlash: false`,
  and `caseSensitive: true`. No `toWebHandler`, ManagedRuntime, module I/O,
  logger middleware, or additional edge runner is needed.
- Register wildcard HTTP methods. Existing route programs keep JSON 405,
  Allow, HEAD, OPTIONS, origin, auth, admission, and body rules. Preserve raw
  exact ownership as well as matcher ownership. Agent namespace equivalence
  runs before every human module, exactly as at the reference commit.
- Convert a Web response using **`HttpServerResponse.raw(response)`**, then
  `toWeb`. Identity, streaming body, status, cookies and headers survive.
  Do not use `fromWeb` for these already-owned responses: that turns their
  bodies into Effect streams and changes the ownership problem.
- `routeWithHttpRouter(context, mcp, metadata, health)` composes the existing
  programs in current ingress order. Optional modules preserve null
  fallthrough. Only the explicit unowned sentinel or a public
  `HttpServerError`/`RouteNotFound` raised before entering a matched handler
  falls through. Structural lookalikes and even genuine router-error objects
  raised by an application handler retain their original identity.
- Matchers have a short construction Scope. Existing MCP programs continue
  to own their resources through their response body. A new route acquiring
  resources into the matcher Scope would need an explicit body-owner design;
  this is not a general replacement for `scopedToBody`.

The Node instrumentation observes **520 edge entries for both dispatchers**,
zero edge entries at import, and no console output during malformed requests,
handler errors, cancellation or normal exchanges. The matcher adds no runner.
Raw response identity, explicit null fallthrough, original error identity and
single Scope finalization are asserted in both runtimes. Real body-held
permits remain active until completion/error/cancel/abort/deadline and release
once; later cancellation does not repeat source cancellation. The original
caller abort reason survives. Health and closed-deployment MCP responses
retain their existing behavior. A second native workerd request waits for
the first response, then reads its own request body and performs native fetch
in its own request context.

The proof transform is now a separate module. Every esbuild candidate graph
must apply it exactly once, including the root and Worker size graphs; a
filter miss fails in `onEnd` even if the baseline builds successfully. Node
and native workerd additionally assert the transformed server's runtime
marker. Every test under the candidate Vitest config imports that marker in
setup. Mutation tests verify structural drift, duplicate transforms, a valid
baseline build with a missed esbuild filter, and missing Vitest transforms in
both actual runtimes. These checks prevent vacuous baseline-versus-baseline
comparisons if a filename/filter stops matching.

### Once-per-handler authoritative dispatch plan (implemented by production D3)

`createFetchHandler` owns two immutable HttpRouter dispatchers, human
and agent, with request-free route programs compiled once per handler. The
existing origin/HTTPS and raw `isAgentPath` ingress guards still run before
dispatch. The agent guard selects the agent dispatcher, whose wildcard handler
executes the existing agent endpoint admission/refusal program; it cannot
reach human routes. The human dispatcher selects CIMD, connect, callback,
well-known metadata, health, MCP, or final fallthrough directly. Core route
selection must no longer call six independent prefix matchers per request.

Use public `HttpRouter.make`, `router.addAll` and `router.asHttpEffect` to
compile the route tables. Route effects read a private current-`RouteContext`
service at execution time; they capture only deployment configuration and
module functions. Never cache a request, signal, Scope, client, fiber, body,
in-flight promise, layer memo map or request services. Keep method handling
inside the selected program with wildcard registrations, so explicit JSON
405/Allow, HEAD and private OPTIONS semantics survive. Leaf programs retain
their defensive raw-path ownership checks because the matcher decodes escapes.
A normalized false match goes to the unchanged UI/OPTIONS/unowned fallback,
not to the canonical endpoint. The CIMD program remains ahead of the UI;
other human leaf programs run optional UI fallthrough before their selected
core action, preserving current module precedence without scanning all core
routes. Well-known metadata keeps MCP metadata before auth metadata.

The synchronous public deployment constructor cannot await a new router
runtime. Initialize the fixed, validated tables lazily in the first existing
edge fiber, as a **bounded, entirely synchronous** registration program with
`Effect.uninterruptible` and public `Scheduler.PreventSchedulerYield: true`
only around make/addAll/cache publication. This avoids a cross-request
initialization promise and duplicate first-request builds; restore the normal
edge scheduler context before request execution. Do not use Layer acquisition
or SDK/custom callbacks in that critical section. Cache only the resulting
request-free handler effects. Structural configuration still validates
synchronously before serving; route patterns are fixed internal constants.
If registration ever acquires an asynchronous dependency, this design must be
revisited rather than sharing the first request's promise. No extra runner,
toWebHandler or module-scope fiber is needed.

The production PR must prove two total builds per handler across concurrent
first requests and later calls, genuine core selection, no request-context
capture, exact ingress/refusal behavior, body-owned Scope preservation,
silence/purity, and the full candidate matrix. The short routing Scope must
not take ownership away from MCP's body Scope. The parent still owns cost
acceptance; this proof implements no production dispatcher or cap change.

### Bounded latency and build-count observations

`runDispatchLatency` measures one constructed handler per variant, four paths,
10 warmups per path, then five batches of 50 requests per path. Each fetch is
followed by response-body cancellation. A proof-only build-counter transform
is omitted from deployment-size bundles. This is a local diagnostic, with no
CI latency threshold; load, order and a 1 ms native clock resolution limit
comparisons. The baseline builds zero HttpRouters. The historical prefix candidate
builds one per CIMD request and **six per health/missing/MCP request**, with
zero at construction, confirming the review's rebuild concern.

The saved fix-round `latency-sample.json` snapshot's median batch microseconds
per request are:

| Path        | Node baseline | Node candidate | workerd baseline | workerd candidate |
| ----------- | ------------: | -------------: | ---------------: | ----------------: |
| CIMD        |        415.75 |         869.16 |              280 |               860 |
| Health      |        479.83 |       3,916.48 |              240 |             2,860 |
| Missing     |        385.93 |       3,879.24 |              220 |             2,700 |
| MCP refusal |      1,629.74 |       5,077.34 |            1,080 |             3,560 |

Native host wall time for the whole benchmark is 489.84 / 2,629.75 ms for
baseline/candidate. Raw five-batch samples and exact counts are in the report.
These numbers describe the rejected proof design, not the planned once-built
dispatcher's performance. That design requires its own measurement.

## D.7 observations and safe implementation alternative

`effectMcp`, `effectExchange`, and `runMcp` in
[`observations.ts`](https://github.com/zackbart/connecta/blob/d0451f8e1ea683e0ac187058a58557a2df7cc282/test/fixtures/effect-proof/observations.ts) exercise
the genuine Effect registration, protocol codecs and HTTP transport. The six
tool descriptors come from the actual current Connecta list. The handles are
explicitly synthetic; their successful execution does not prove Connecta's
invocation, auth, native policy, or continuation enforcement.

`HttpEffect.toHandled` is necessary around the HTTP effect: directly converting
`asHttpEffect`'s response skips the public pre-response processing and loses
legacy session headers. The probe runs `toHandled` in the existing edge runner,
reads the response within its Scope, and disposes the layer after each
exchange. It never imports Effect internals.

| Contract                                       | Exact-version observation / decision                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modern six input/output schemas                | Preserved as JSON objects; descriptions and schema bytes are retained. The ToolAnnotations codec inserts `idempotentHint: false` where the SDK list omitted it, so the full list is not byte-identical.                                                                                           |
| Complete/error content                         | Real codec retains text, structuredContent and `isError`; modern result envelope is generated.                                                                                                                                                                                                    |
| Modern discovery/cache                         | `listChanged: false` on the request-scoped layer; private TTL **0** instead of current 3,600,000 ms meta / 300,000 ms native policy; extra logging/completions capabilities appear. Public options do not expose the current SDK cache-hint configuration.                                        |
| Unsupported methods                            | Unknown methods include an Effect `_tag`; prompts/list and subscription refusal statuses/framing differ. An invalid subscriptions/listen returns HTTP 200 SSE rather than current 404 JSON. Initialize/initialized are rejected on the modern-only layer.                                         |
| Mirroring                                      | Method and name mismatches return 400. Unannotated Mcp-Param headers are ignored; that is not an annotated-header mismatch failure.                                                                                                                                                               |
| Resources/skills                               | A public resource registration/read and skills extension advertisement are probed. Synthetic resource registration is not parity with Connecta's full skill catalog and URI policy.                                                                                                               |
| Modern input-required                          | URL elicitation and opaque requestState serialize when client capability is supplied; missing capability returns 400. A synthetic handle accepts forged requestState unless application verification is added. This is an adapter responsibility, not proof of signed continuation compatibility. |
| Legacy fresh/new handler                       | Mandatory 400/404 failures above. Request-scoped legacy construction is explicitly rejected.                                                                                                                                                                                                      |
| Real SDK client                                | The unmodified SDK client is exercised against the modern Effect endpoint; legacy raw-request failure remains a separate blocker.                                                                                                                                                                 |
| Native/read-only/hidden/code-off/collision/cap | Existing Connecta tests remain the oracle. Candidate router tests keep the real SDK/native path. No Effect native registration adapter was implemented after the mandatory legacy failure; these replacement rows remain unproved.                                                                |
| Auth-before-body / signed continuations        | Existing and candidate-router tests cover Connecta. Effect replacement's bounded classification, signatures, caller/pool/args binding, single use, 401/redirect write refusal and activity provenance remain unproved.                                                                            |
| Public registration and Eve                    | Existing SDK-typed registration declarations stay unchanged. An Effect service is not a drop-in SDK McpServer class. No ambient stubs or public signature changes are proposed. An integrated Effect replacement has no Eve/packed-consumer equivalence claim.                                    |
| Request isolation                              | Modern layers are disposed per exchange and run in actual workerd; route queues/body lifetimes are proven separately. Full Effect native/auth partition, cancellation, abandonment and capability-isolation parity is unproved and cannot inherit D.3's verdict.                                  |

The approved D.7 implementation retains **both SDK protocol leaves**:
fresh `createMcpHandler` modern exchange and fresh JSON-enabled stateless legacy
transport, with public SDK registration signatures unchanged. Move registration
preparation, catalog/native selection, auth-elicitation policy, invocation and
request/call ownership into native Effect programs using D.1 services. Convert
only at real SDK callback/transport leaves. Keep request Scope and finalizers
around those leaves; retain the serialization redaction boundary, bounded
classification and signed `AuthElicitation.verify` hook. This can complete
native orchestration without claiming Effect McpServer adoption. The parent
explicitly approved this SDK protocol-leaf fallback on 2026-10-25 after the
independent review. Full D.7 native orchestration remains required in its own
PR, with the complete modern/legacy/native/meta/code-on/off/readOnly/hidden/
collision/cap/schema/continuation/auth-before-body/resource/skill/lifetime/Eve
and packed-consumer matrix. The unproved rows above concern the rejected
replacement; they do not waive any fallback implementation requirement.

## Deployment cost, imports and declarations

Esbuild **0.28.1**, minified neutral Worker conditions, gzip level 9.
Retained raw bundles are recompressed offline with cached official
`node:22-slim`, Node **22.23.4**, bundled zlib **1.3.1-e00f703**. The Docker
image is not pulled, network is disabled and mounts/root filesystem are read
only. These are exact reference-source observations, not predictions for the
final integrated branch after #1038.

| Entry          |   Current | Router candidate |     Delta | Existing cap |
| -------------- | --------: | ---------------: | --------: | -----------: |
| Root           | 371,616 B |        422,290 B | +50,674 B |    402,000 B |
| Worker example | 711,248 B |        762,313 B | +51,065 B |    743,000 B |

The corrected router candidate is **20,290 / 19,313 B above** those caps. Behavior passes
are independent of this budget report. The Effect MCP measurement is
incremental alongside the retained SDK, not a replacement/savings estimate;
the machine report contains its exact current values. Only one resolved
Effect copy is present. Neither candidate adds a `node:` import to neutral
entries; the Worker retains its existing optional codemode external. Adoption
needs a named purity allowance for `effect/http` or `effect/ai`; the historical spike changed none. Production D3 confines four public
HTTP module imports to `src/routes/dispatch.ts`. Published source/declarations are untouched, and existing purity,
package-surface and declaration checks remain required.

For continuity, the original Homebrew Node22.23.3 + LD_PRELOAD observations
before this fix were root370,646 →420,931 and Worker709,390 →759,463 bytes.
With the corrected prefix/error seam they are root370,646 →421,058 and
Worker709,390 →759,551. These separate compressor observations are retained;
they are not substituted for the official-Node table above. Official
incremental Effect MCP measurements, retaining SDK, are 470,931 / 809,676 B;
they remain informational because that replacement was rejected.

## Reproduction and evidence boundaries

After `pnpm install`, run `pnpm run build:operator-ui` and
`node scripts/generate-version.mjs` once. Use Node 22 for these commands:

```sh
VITEST_MAX_WORKERS=2 pnpm run test:node test/effect-core-proof.node.test.ts
node scripts/probes/effect-core-compatibility.mjs /absolute/proof-report.json /absolute/bundles
VITEST_MAX_WORKERS=2 pnpm run test:node test/effect-router-transform.node.test.ts
VITEST_MAX_WORKERS=2 pnpm run test:node test/downstream-auth-best-practice.test.ts test/server-route-contracts.test.ts test/request-pipeline.test.ts test/oauth-callback-fencing.test.ts
VITEST_MAX_WORKERS=2 pnpm run test:workers test/request-pipeline.test.ts test/request-admission.test.ts test/auth-elicitation.test.ts
```

On Homebrew Linux prepend `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libz.so.1` to
the measurement command for comparable gzip. The proof runner resolves
Miniflare through the installed Wrangler dependency, starts local workerd only,
stubs outbound service I/O, and disposes every worker. It requires no external
services. No deployments, release actions, human live-host OAuth acceptance,
protocol feature expansion or cap changes are included. Focused runs do not
replace the parent's unconditional full checks or integrated matrix refresh.

## Production D3 cost acceptance

The production adapter uses two request-free public routers per handler and
direct public `effect/http/*` imports. Official Node22.23.4/zlib1.3.1-e00f703
measures root373435 to393470 bytes and Worker758274 to774384. The barrel
alternative measures423348/787614, so direct imports save29878/13230 bytes.
The685-exchange matrix per runtime, native lifetime/request-isolation proof
and unchanged deterministic goldens establish compatibility independently of
size. Local forward/reverse latency diagnostics show path-dependent overhead
and variation; no latency improvement is claimed.

The parent accepts Worker maxGzip785000 for this genuine routing cost and
separately measured native-auth/host/transport additions. D3 changes no other
cap or historical baseline. These separate-input measurements are not an
additive final gzip claim; final integration must rebuild and remeasure.
Independent review and combined validation remain required. The D7 protocol
leaf fallback and exclusion of new protocol features remain unchanged.
