---
status: proposed
date: 2026-10-25
issues: [703]
supersedes: []
---

# Effect 4.0.5 routing and upward MCP compatibility proof

Contributor evidence for D.3/D.7 under [0009](./0009-effect-native-rewrite.md)
and [#703](https://github.com/zackbart/connecta/issues/703). This record does
not replace an operator contract or claim either production implementation
has changed. The owner authorized the full rewrite on
`t3/effect-core-rewrite`; historical release deferrals do not govern this work.

The reference is release commit `a471a2a6`, Effect **4.0.5**, and MCP SDK
**2.3.1**. No dependency is upgraded, no provider fixture is regenerated, and
no production file is edited by this proof. The runner compiles the actual
source twice: unchanged dispatcher and HttpRouter candidate. It fails if its
source-transform seam disappears. It uses real public Effect APIs rather than
patching the library or substituting a protocol stack.

## Separate verdicts

**D.3 behavior:** the public adapter passes the measured route, ordering,
body-lifetime and request-ownership cases on Node and workerd. The initial
candidate incorrectly served `/%68ealth` as health: FindMyWay decodes
unreserved escapes even with strict slash and case configuration. A raw-path
ownership guard corrects that while retaining the existing agent-bypass guard.
The corrected candidate matches all **175 exchanges per runtime**, including
headers and exact serialized bodies. Four additional agent-token list
exchanges per runtime cover both namespaces and protocol eras. An identical
fixed `Date.now` makes application duration fields deterministic in this wire
comparison; real timers remain enabled. Lifetime tests use the real clock.

The candidate also passes the existing Node route/admission/operator/callback/
identity suites and existing workerd boundary suites through the supplied
Vitest transform. These tests execute actual application programs, not a
synthetic router list demo. This establishes the adapter seam, not acceptance
of an integrated D.3 implementation; refresh the matrix after lower rewrites.

**D.3 cost:** measured separately below. No cap is changed or approved here.
The parent owns the budget decision, including later index compaction work.

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

## Public D.3 adapter proposal

The reusable candidate lives in
[`test/fixtures/effect-proof/router.ts`](../test/fixtures/effect-proof/router.ts):

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
  fallthrough; only the explicit unowned sentinel and router RouteNotFound
  fall through. Other failures retain their original identity.
- Matchers have a short construction Scope. Existing MCP programs continue
  to own their resources through their response body. A new route acquiring
  resources into the matcher Scope would need an explicit body-owner design;
  this is not a general replacement for `scopedToBody`.

The Node instrumentation observes **380 edge entries for both dispatchers**,
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

## D.7 observations and safe implementation alternative

`effectMcp`, `effectExchange`, and `runMcp` in
[`observations.ts`](../test/fixtures/effect-proof/observations.ts) exercise
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

The smallest safe D.7 implementation is to retain **both SDK protocol leaves**:
fresh `createMcpHandler` modern exchange and fresh JSON-enabled stateless legacy
transport, with public SDK registration signatures unchanged. Move registration
preparation, catalog/native selection, auth-elicitation policy, invocation and
request/call ownership into native Effect programs using D.1 services. Convert
only at real SDK callback/transport leaves. Keep request Scope and finalizers
around those leaves; retain the serialization redaction boundary, bounded
classification and signed `AuthElicitation.verify` hook. This can complete
native orchestration without claiming Effect McpServer adoption. Parent ruling
and a separate implementation PR determine that scope.

## Deployment cost, imports and declarations

Node **22.23.3**, esbuild **0.28.1**, minified neutral Worker conditions,
gzip level 9, system zlib via `LD_PRELOAD`. These are exact reference-source
observations; they do not predict the final integrated branch after #1038.

| Entry          |   Current | Router candidate |     Delta | Existing cap |
| -------------- | --------: | ---------------: | --------: | -----------: |
| Root           | 370,646 B |        420,931 B | +50,285 B |    402,000 B |
| Worker example | 709,390 B |        759,463 B | +50,073 B |    743,000 B |

The router candidate is **18,931 / 16,463 B above** those caps. Behavior passes
are independent of this budget report. The Effect MCP measurement is
incremental alongside the retained SDK, not a replacement/savings estimate;
the machine report contains its exact current values. Only one resolved
Effect copy is present. Neither candidate adds a `node:` import to neutral
entries; the Worker retains its existing optional codemode external. Adoption
needs a named purity allowance for `effect/http` or `effect/ai`; this proof
changes none. Published source/declarations are untouched, and existing purity,
package-surface and declaration checks remain required.

## Reproduction and evidence boundaries

After `pnpm install`, run `pnpm run build:operator-ui` and
`node scripts/generate-version.mjs` once. Use Node 22 for these commands:

```sh
VITEST_MAX_WORKERS=2 pnpm run test:node test/effect-core-proof.node.test.ts
node scripts/probes/effect-core-compatibility.mjs /absolute/proof-report.json
VITEST_MAX_WORKERS=2 pnpm exec vitest run --config scripts/probes/effect-router.vitest.config.mjs --project node test/server-route-contracts.test.ts test/request-pipeline.test.ts test/oauth-callback-fencing.test.ts test/operator-routes.test.ts test/identity-scope.test.ts
VITEST_MAX_WORKERS=2 pnpm exec vitest run --config scripts/probes/effect-router.vitest.config.mjs --project workers test/request-pipeline.test.ts test/request-admission.test.ts test/native-tools.test.ts test/auth-elicitation.test.ts
```

On Homebrew Linux prepend `LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libz.so.1` to
the measurement command for comparable gzip. The proof runner resolves
Miniflare through the installed Wrangler dependency, starts local workerd only,
stubs outbound service I/O, and disposes every worker. It requires no external
services. No deployments, release actions, human live-host OAuth acceptance,
protocol feature expansion or cap changes are included. Focused runs do not
replace the parent's unconditional full checks or integrated matrix refresh.
