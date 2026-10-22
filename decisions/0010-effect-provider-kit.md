---
status: proposed
date: 2026-10-20
issues: []
supersedes: []
---

# The Effect provider kit

[0009](./0009-effect-native-rewrite.md) chose to rebuild the HTTP layer on
Effect and sequenced the work as B.1–B.5. This record fixes the design of
B.1–B.4 and the gate B.5 must pass before Phase C starts. A prototype under
`src/http/` runs three Tithe.ly tools from a side file
(`src/providers/tithely/kit-prototype.ts`): the reads `get_charge` and
`list_charges`, and the write `tithely_api_mutate`, with its credential, error
and hatch paths. A second side file expresses Stripe's failure mapper on the
kit's error contract (`src/providers/stripe/kit-prototype.ts`). Nothing live
imports either, and the build does not emit them.

The prototype gives four kinds of evidence:

- **Against `index.ts`.** `kit-prototype.test.ts` (56 tests) compares catalog
  entries, the requests sent, and the mapped results for 44 fixture cases,
  including the write's statuses, in-band refusal, refused connection,
  oversized 401 bodies,
  confinement and a path of astral characters. Every case is identical,
  advice segments included. This record's 401 rule (Q8) was the one
  deliberate difference until the 401 back-port (#917) made it the core's;
  its case now asserts full equality too. A.2's write outcomes and sensitive
  fields are no longer differences: since #902 merged, both sides get them
  from the core.
- **Against A.3's goldens (round 2; superseded by round 3 below).** Run out of tree through PR #900's harness (at
  `f1a2df2b`), with the three kit tools substituted into today's provider:
  `catalog.json` and `calls.json` are byte-identical, and `failures.json`
  differs in exactly three write cases, each a deliberate change named above.
  The 401 and the 401 echo keep `auth_required`, `reconciliationRequired` and
  the `authorize_connector` handoff, and their message gains the
  unknown-outcome sentence. The 500 turns from retryable `unavailable` into
  non-retryable `connector_call_failed` in A.2's words. `main` drops
  `writeOutcome` from the wire, so the harness shows it once #902 merges, on
  all three. An earlier run found that the kit defaulted HTTP 409 to
  `conflict`, where Tithe.ly answers `connector_call_failed`; the default is
  gone (B.3).
- **Against today's mappers.** `src/providers/stripe/kit-prototype.test.ts`
  maps 16 branch rows of status, error body, headers and value-safety
  verdict through `stripeFailure` and through the kit, and requires the same
  code, message, retry advice and wait, with the advice as its own segment.
- **Against the core's verdicts (final round).** `test/kit-core-verdicts.test.ts`
  runs the kit and today's `api()` core over one committed table of cases,
  served by the invocation and called directly, and requires the same
  requests and the same verdict on every row (below).

`test/http-kit.test.ts` (113 tests) covers the kit's own rules, and
`test/kit-stability.node.test.ts` the stability guard (Q7). Every suite but the
Node-only guard passes on Node and workerd.

**Final round: one verdict table, the core's.** #902 merged at `eef0274c`
with a contract that differs from the head this record was first checked
against (`44dd4df3`); "A.2 as merged" below lists the differences. The
temporary adapter `src/http/core-write-outcome.ts` is deleted, which also
settles the review's request for a drift guard: no copy of the verdict is
left to drift. The kit now decides no write's outcome:

- Its transport enters every resource request in the core's ledger
  (`src/provider-call.ts`, the `Ledger` service) synchronously before
  `fetch`, with its method and any genuine idempotency key it carries, and
  records its status when it is answered. The dispatch also joins the request
  to the invocation's logical call.
- Its mapping marks a failure that is its own request's served answer with
  that request (`vendorRefusal`). That is provenance (b), recorded where it
  was observed.
- `api()`'s boundary decides the write with `providerCallFailure` over the
  whole logical call, exactly as it does for today's providers. A kit
  connector therefore declares `tracksEveryRequest` (B.4).

The kit composes only the words of a blocked resend over that decision.
Q8's 401 handoff (B.3) was a second composition until the 401 back-port
(#917) made it the core's: the kit now only records each 401's facts on its
ledger entry (`recordUnauthorized`), and the core's `settleWrite` decides. `classifyWriteOutcome` and the module-private `servedRefusal` stay
in the core and reach the kit only through the boundary; the kit evaluates
no provenance of its own.

The committed case table covers Tithe.ly's write and read answered 2xx then
an unreadable body, 2xx then an in-band refusal, 400, 401, 403, 404, 408,
409, 422, 429, 500 and 503, a network error, a timeout and the caller's abort.
It adds two refusals before dispatch, Stripe's 424 mapped to `unavailable`,
Stripe's lock-timeout 429 and a keyed Stripe write. Four rows cover a
two-step composite. All 34 rows agree on requests, outcome
(`classifyWriteOutcome`), `retryable`, code and whether advice reaches the
agent. The write 401 row, marked Q8, was the one exception until the 401
back-port (#917) landed; it now requires the same verdict on both sides,
unknown with the auth code and handoff, like every other row. Two red checks
show the table can fail: without the kit's provenance marks 8 rows fail, and
with its requests kept out of the core ledger 12 rows fail.

The out-of-tree golden comparison reran #900's harness (on `main` since
`eef0274c`) against this branch, with the three kit tools substituted into
today's provider. Both sides use the provider's default privacy. Nothing
from the run is committed:

- `catalog.json`: 35,437 → 35,437 bytes, byte-identical.
- `calls.json`: 17,640 → 17,640 bytes, byte-identical; every request matches.
- `failures.json`: 23,947 → 24,241 bytes (+294). **Only write 401 and write
  401 echo differ, in the back-port's direction**: each drops `answered`
  (no longer a served refusal), gains `writeOutcome: "unknown"`, and its
  message gains "The write was sent before Tithe.ly rejected its credential,
  so whether it took effect is unknown: check the target before repeating
  it." The code (`auth_required`), the handoff and non-retryability are
  unchanged. Every other row is identical, write 404, 409, 500, network and
  timeout included.
- The substituted provider matches those bytes in compare mode on Node and
  workerd, at the full and the always tier.

**Final-round verification.** `VITEST_MAX_WORKERS=2 pnpm run check` ran once
and passed:

- 441 test files passed and 5 were skipped; 22,680 tests passed and 325 were
  skipped.
- All 13 invariants and 156 spec references are backed by passing tests.
- Build, declarations, bundle caps and examples pass, and all 347 Chromium
  tests pass.
- `check:fast` passed with 480 related tests. The in-tree goldens pass at the
  always tier (Node 54 passed and 18 skipped; workerd 53 and 19) and the full
  tier (72 of 72 on each).

Every shipped entry's gzip size equals `origin/main`'s, measured on both
trees: the root at 393,052 B against its 399,882 B cap, `./worker` at
76,625 B, `examples/worker` at 733,424 B against 734,000 B,
`./providers/tithely` at 46,496 B and `./providers/stripe` at 261,971 B.
`dist/` holds no kit or prototype file.

Unshipped, with the same esbuild settings: every kit module over the root
costs 157,102 B, against 157,620 B at the previous head by the same method;
the Tithe.ly prototype entry costs 160,480 B over the root, and today's
Tithe.ly costs 10,054 B. Round 2's "about 120 KB" (below) measured only what
its prototype reached; B.5 reports the real migrated provider.

**Round-5 ruling and evidence (superseded by the final round above: the
adapter is deleted and the kit delegates through the core ledger).** The kit delegates single-write verdicts to
`classifyWriteOutcome` and `providerCallFailure` in the core's
`src/write-outcome.ts` (#902). It does not restate their verdict table.
While #902 is unmerged, `src/http/core-write-outcome.ts` vendors the identical
contract from #902 head `44dd4df3`, with only a pre-merge constructor and
served-context bridge. When #902 lands, that one adapter must switch to
imports/re-exports from `src/write-outcome.ts`. The ledger still composes
whole-call uncertainty and the separate Q8 write-401 policy.

Bulk binding uses lossless ordered multimaps, rejects undeclared duplicate
query/form/JSON identifying keys before fetch, and preserves declared
multi-value order. Call closure promptly settles paused credential/budget
Effects and aborts their underlying work. Renewal is call-owned only until
its first durable coordinator write (the claim CAS) is submitted.
Submission transfers preparation, the token request and fenced rotation
commit to the storage coordinator under its own deadlines. The caller's
wait remains interruptible throughout. Request closure closes
attached leases, including those opened by the Promise bridge. No shared
request-owned renewal fiber spans requests.

The out-of-tree comparison uses #900's harness and fixtures from
`origin/t3/provider-characterization-goldens` at `3ac58733` against #902's
**full head behavior at `44dd4df3`**, including its serialization and shared
failure-decision helper. Only the three prototype tools replace today's
tools; both sides set privacy to `return` to compare existing behavior.
No harness, back-port or golden from the run is committed:

- `catalog.json`: 35,458 → 35,458 bytes, byte-identical. The two `raw`
  descriptions and the mutate hatch's `result` description match #902.
- `calls.json`: 18,057 → 18,057 bytes, byte-identical; every request matches.
- `failures.json`: 23,725 → 24,075 bytes (+350). **Only write 401 and write
  401 echo differ**: the unknown-outcome sentence and `writeOutcome: "unknown"`
  are added; auth codes, handoffs and non-retryability survive. Write
  404/409 and timeout retain exactly #902's fields, without extra
  `writeOutcome`. There is no kit-divergence back-port prerequisite.

The only separate B.5 prerequisite after #902 is the write-401-with-handoff
back-port and goldens regeneration, as specified below. B.5 remains strictly
Tithe.ly's step 1 under 0011.

**Historical round-5 verification.** `VITEST_MAX_WORKERS=2 pnpm run check` ran once
and passed: 394 suites passed, 3 skipped; 18,859 tests passed, 313 skipped;
all 13 invariants and 154 spec references have passing coverage. All 347
Chromium tests pass. The requested kit/prototype, Stripe and Tithe.ly suites
pass on both projects (242 tests each: kit 109, Tithe.ly prototype 55,
Stripe prototype 3, Stripe provider 38, Tithe.ly provider 37); purity,
package-surface and stability pass (41 Node tests). `check:fast` passes with
390 related tests. Build, 88 reachable declarations with no Effect types,
every bundle cap and examples pass; `dist/` contains no kit/prototype files.
The out-of-tree Tithe.ly golden comparison passes on Node and workerd.
No full-gate load timeouts or isolated reruns were needed, despite session
host load of roughly 18–86. Public-contract scans find no Stripe/Tithe.ly
endpoint drift; Stripe's standing public-doc omissions and hosted-catalog
manual review remain advisory.

**Historical round-3 evidence (superseded by the round-4 ruling below).** The fixed-capacity and atomic-reservation regressions,
raw-status write mapping, recorded 401 body/later-failure cases and suspended
schema checks are in the prototype suites. The out-of-tree golden run on
#900's `f1a2df2b` substitutes the three prototype tools into the original
provider, with the privacy option set to `return` to compare its existing
behaviour. `catalog.json` stays 34,969 bytes and `calls.json` stays 17,331
bytes, both byte-identical. `failures.json` changes from 21,943 to 23,075
bytes (+1,132), in exactly nine write cases: 400, 401, 403, 404, 409, 422,
429, 500 and 401 echo. Each request stays identical. Seven change message
only; 429 also loses retryability and its wait; 500 changes code and
retryability. Read failures, refused connection and timeout stay identical.
The 401 handoffs remain. This harness's older core drops `writeOutcome` from
the wire; #902's explicit field makes all nine dispatched failures visibly
unknown and keeps refusal-code accounting from overriding them. No golden
or harness change from that run is committed.

**Historical round-3 verification.** The kit/prototype, Stripe and Tithe.ly suites pass
on Node and workerd, along with the purity, package-surface and stability
guards. `check:fast` passes. `pnpm run check` ran once: 18,503 tests passed,
4 failed and 304 were skipped; all 13 invariants and 154 spec references are
backed by passing tests. The full gate is **not green**. At an observed host
load of 25–165, the failures were in unchanged files: a 10 s QuickJS timeout,
a 5 s operator-store cancellation timeout and its following identity-state
failure, and an access-token adoption deadline assertion on workerd. All
three files pass in isolation (74 Node tests, 159 workerd tests). The stages
blocked by that test failure pass separately: build; 88 reachable declarations
with no Effect types; every bundle cap; examples; and all 347 Chromium tests.
`dist/` contains no `http/` or `kit-prototype` files. Passing isolated reruns
does not turn the failed full run into a clean gate.

Four constraints shape the design:

- **Unstable modules stay in three files.** effect 4.0.5 tags `effect/http`
  and `effect/http-api` `@stability unstable`. Only `src/http/client.ts`,
  `oauth.ts` and `vendor.ts` import them (`test/purity.node.test.ts`).
  Providers declare operations through names `vendor.ts` re-exports. That
  confines the unstable modules; it does not make them stable, and an effect
  upgrade may still change what those names do. Every other `effect` member
  the kit and its provider declarations use is tagged `@stability stable`,
  and `kit-stability.node.test.ts` checks it (Q7).
- **The kit stays out of the root graph.** The round-3 build measures the root at 379,170 B gzip
  against a 399,882 B cap, which leaves 20,712 B of headroom. The kit costs
  about 120 KB by round 2's measure, and 157 KB with every kit module by the
  final round's. A deployment pays that once, through its first kit provider
  entry. The purity suite checks that `src/index.ts` reaches nothing under
  `src/http/`.
- **Classification belongs to the call.** The registry's served verdict
  decides at run time; the builder only annotates the catalog, and the HTTP
  method never decides.
- **Step 1 preserves all agent-facing bytes.** Under [0011](./0011-provider-standard.md),
  every kit migration matches catalog, calls AND failures goldens. Safety
  changes are back-ported first; surface changes belong to step 2.

**A.2 as merged (#902, `eef0274c`).** The kit delegates every write verdict
to this contract (`src/write-outcome.ts`, `src/provider-call.ts`) and keeps
no copy of it:

- **Provenance, never codes.** A dispatched write is a known failure only on
  refusal provenance, recorded where the evidence was observed. Either (a) the
  ledger shows the request never left connecta, or (b) the downstream served a
  refusing status that passes `servedRefusal`: a 4xx other than 408
  (`refusedStatus`) that its provider does not read as `unavailable` or a
  timeout. Stripe's 424 is the reviewed example of that last clause. A 2xx, a
  408 and a 5xx never prove a write unapplied. The `REFUSALS` code set is
  gone. An error code is never evidence, whether it is a mapper's
  `rate_limited` after a 2xx, an output validator's `invalid_args` or a
  JSON-RPC `-32602`. Anything else after dispatch keeps its code and message
  for diagnostics, is never retryable, and carries `writeOutcome: "unknown"`.
- **The logical-call rule.** The evidence must hold for the whole logical call
  (`knownForLogicalCall`). Exactly one boundary was entered, the object the
  invocation invoked owns it, and the one request that call sent carries the
  refusal. Ownership means a boundary invoked with the `callTool` captured
  when it was built (`providerBoundary`), or a declared delegator
  (`delegatesEachCall`; GitHub is the only one). Identities are captured at
  boundary construction and entry, and requests join the call at dispatch.
  None is read back from a mutable property.
- **`isError` and `input_required` prove nothing for a write.** An MCP
  `isError` and an unsupported `input_required` suspension both arrive after
  the downstream handler ran, so either one on a write is unknown.
- **Advice is a segment of its own.** Advice to send a call again is a
  structured `resendAdvice` segment beside the error, never part of
  `message`. Output composes it only once the outcome allows it: for a read
  or a known refusal. Key-reuse advice (`keyResendAdvice`) also needs its key
  to protect the whole logical call (`keyProtectsLogicalCall`).
- **Repeatability needs a sent key.** Only a genuine, legal idempotency key
  the vendor receives, recorded on the request that carried it, makes a
  direct write repeatable, and only when it protects the whole logical call.
  No operation hint counts.
- **A transport failure is never evidence.** Every native-fetch transport
  failure on a write is unknown (#902 round 8), because one `fetch` can hide
  several attempts. Neither an errno nor "never connected" proves a write
  unsent. B.2's guarded `HttpClient` is the documented place to own
  transport attempts (B.2).
- **401 (Q8, decided).** A write answered 401 is unknown by default, unless a
  reviewed `authBeforeExecution` declaration says the vendor authenticates
  first. The 401 back-port (#917) made it the core's rule for today's
  providers, with `authBeforeExecution` as the core's reviewed declaration;
  the kit forwards its matched proof to the core's ledger entry
  (`ProviderRequest.authBeforeExecution`).

_Superseded (#902's draft, rounds 2–5; the merged contract above replaces it
where they differ):_ A.2 (#902) is not merged yet. Its draft adds `deriveContext`/`contextKey`,
`callClassification`, the shared `unknownOutcome`, and the
deployment-controlled `sensitiveFields` privacy projection, and stops `api()`
OAuth from resending a write. Its fix round extends the rule that a dispatched
write is never resent and never advertised as retryable to `remoteMcp()`,
Google Workspace, and OAuth recovery failures. Its second fix round adds the
explicit `writeOutcome: "unknown"` on `ConnectorCallError` and
`CallErrorDetails`, which `classifyWriteOutcome` reads before its refusal
codes, so an authorization verdict reached after a write left keeps its code
and handoff and is still counted unknown. This record uses those names and
verdicts. The explicit unknown field agrees with A.2. The decided round-4
contract below delegates verdicts to the core's `classifyWriteOutcome` and
`providerCallFailure`;
rounds 2–3's rule that every dispatched failure is unknown is superseded. The static OAuth divergence is explicitly
planned B.2 work below, not shipped alignment. The verdict functions live in the core. Until #902 merges, one temporary
adapter vendors its identical contract; `attachServedClassification` bridges
the served verdict and `unknownWrite` carries only Q8/whole-call uncertainty.

## Decision

### B.1 Call and operation services

Today a call's state lives in side tables keyed on the identity of the context
object. The table below sorts that state by owner and lifetime:

| State                                                                                           | Today                                                                    | Owner and lifetime                                      | B.1                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Caller                                                                                          | `connector-caller.ts` `callers`                                          | operation (any registry operation)                      | `Caller`, in the operation layer                                                                      |
| Catalog-cache policy, OAuth partition and sealer                                                | `catalog-cache.ts` `settings`, `oauth-partition.ts`, `oauth-sealing.ts`  | operation                                               | the operation entry; moved into services by D.4                                                       |
| Admission permit                                                                                | `call-admission-context.ts` `permits`                                    | call                                                    | `Budget`, whose `charge` refuses once the call closes                                                 |
| Served classification                                                                           | A.2's `call-classification.ts`                                           | call                                                    | `Classification`                                                                                      |
| Recovery facts                                                                                  | `call-recovery.ts` `facts`, which invocation reads via `dispatchContext` | call, read by invocation afterwards                     | `Recovery`, which writes into a record the invocation owns                                            |
| Per-call sent secrets                                                                           | `sent-secrets.ts` `contexts` and `wrappedCredentials`                    | call, included in the request set                       | `Secrets`                                                                                             |
| Credentials                                                                                     | `ctx.credential`, plus the `trackCredentialReads` mutation               | call                                                    | `Credentials`; every read registers what it returns                                                   |
| Signal                                                                                          | `ctx.signal`                                                             | call                                                    | `Signal`                                                                                              |
| Requests sent                                                                                   | `provider-call.ts`'s request ledger and logical call (#902)              | call                                                    | the core's `Ledger`, which `api()`'s boundary reads (B.3), beside the kit's `Dispatches` reservations |
| OAuth grant use                                                                                 | `ctx.oauth` and `static-oauth.ts` closures                               | call until claim CAS submission; coordinator thereafter | `Grant` (B.2)                                                                                         |
| Request set of sent secrets, invocation auth, handoffs, `rejectedScopes`, request-token flights | WeakMaps keyed on `requestScope`                                         | request                                                 | request-owned; a `RequestScope` service in D.1                                                        |
| `remoteMcp()` sessions and transports                                                           | `requestScope` finalizers in `remote-mcp.ts`                             | request                                                 | request-owned; unchanged until D.6                                                                    |

The defect 0009 names is call state keyed on a context that a `{...ctx}` copy
replaces. Request-keyed state does not have it, but it needs the same explicit
teardown rules as call state (below).

```ts
// src/runtime/call.ts (prototype: src/http/services.ts). Each key is one
// `class K extends Context.Service<K, Shapes[K]>()("connecta/call/K") {}`.
interface OperationShapes {
  Caller: ConnectorCaller | undefined;
}
interface CallShapes extends OperationShapes {
  Budget: { readonly charge: Effect.Effect<void, CallAdmissionError> };
  Classification: "read" | "write";
  Recovery: { readonly record: (facts: Readonly<Record<string, string>>) => Effect.Effect<void> };
  Secrets: SentSecrets;
  Credentials: { readonly values: Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError> };
  Signal: AbortSignal | undefined;
  Dispatches: Dispatch[]; // permanent reservations and dispatch facts (B.2)
  Ledger: { open; dispatch }; // the core's request ledger (src/provider-call.ts), which api()'s boundary decides from (B.3)
  RequestSecrets: SentSecrets; // the request's whole set: redacts a body before anything cuts it (#911)
  WriteCapacity: ReadonlyMap<string, ReadonlyMap<string | undefined, WriteRequest | undefined>>; // B.4: fixed slots and item-derived requests
}
// What one request inside a call is; set by `Send`, read by the transport and refresh-once.
const RequestFacts = Context.Reference<{ effect: "call" | "read"; step?: string; item?: string; operation?: OperationRef }>(…, { defaultValue: () => ({ effect: "call" }) });
```

**B.1 implementation reconciliation with #902/#917.** The merged contract
wins over these prototype details:

- _Superseded:_ the B.1 table/snippet's single `Classification` conflates
  the effective tool classification with a served verdict on direct calls.
  `Classification` is the effective verdict; `ServedClassification` is absent
  for a direct call. `callClassification` reads only the latter. This preserves
  the merged direct keyed-write exception without granting it to served writes.
- _Superseded:_ the prototype's single `Signal` is insufficient for the merged
  direct-call abort contract once API boundary teardown aborts its lease.
  `SourceSignal` retains the caller's original signal; `Signal` is the revocable
  lease signal. Settlement reads the former, so ordinary closure cannot turn
  a mapped failure into caller-cancellation wording.
  Request-owned joins retain the original request signal separately from an
  invocation's deadline signal: finalizing that deadline must not revoke
  auxiliary work that still belongs to the open request.
- The ledger is the merged append-only physical ledger, including remote MCP
  and nested boundaries, provided as `Ledger`, `ProviderLedger` and
  `LogicalLedger`. No physical entries are merged or reused. `settleWrite`
  remains the single Q8 decider, at invocation or the direct outermost boundary.
  Invocation retains its logical-call and recovery records across revocation.

B.1 moves the common prototype services and view/request lifetime machinery
from `src/http/services.ts` to `src/runtime/call.ts`. HTTP-specific dispatch
reservations, request facts and renewal middleware remain in the unshipped
kit for B.2/B.4; they import the live common services. The operation entry also
holds catalog policy/observations, OAuth partition and sealer as services,
removing their context-keyed security tables along with the call tables.
`Memo` also owns Google's per-call subject resolution and Cloudflare's per-call
ownership lookup count; neither retains a context-keyed table.

The #917 nested-call follow-up is fixed: child leases inherit parent closure,
child ledgers close recursively, and pending authentication is interrupted
before dispatch. Delegated provenance is deferred: propagating wrapper read,
auxiliary or declared-refusal proof to each physical delegated send requires
an explicit transport linkage that survives custom/copied-init delegation.
Services alone do not prove that relationship. The separate immutable records
and #917's conservative expectations remain intact; no B.2 transport work is
included here.

**Operations outside a call (discovery, status, `startAuth`).** Caller state is
not call state. `catalog-cache.ts` refuses its private fallback without an
authenticated caller, and `remote-mcp.ts` puts the caller in its negotiation
partition, on contexts no invocation built. So B.1 has two layers:

- **The operation layer** is built by `registry.contextFor` for every
  operation of a scoped `RegistryView`: `listTools` through
  `loadDownstreamTools`, `statusFor`, `startAuth`, resource reads, skill
  reads, and the context each call starts from. It carries the admitted
  `Caller` (from `scope.caller`), the catalog-cache policy and the OAuth
  partition and sealer. A context built without a scope (an operator probe,
  an OAuth callback, a credential route) has no caller, as today, and fails
  closed wherever a caller is required.
- **Derived contexts** resolve to their origin's entry: `authorizingContext`
  for `startAuth`, catalog-cache's listing context, and the request-token
  mint all become A.2's `deriveContext`. A plain `{...ctx}` copy resolves to
  nothing, so it fails closed instead of reading another caller's state.
- **The call layer** adds the call services to an operation entry. A call
  never changes its operation's caller.

An invocation's first admission permit marks its request scope as admitted.
That mark is sticky for the scope's whole lifetime: closing the admitted call
never lets a copied view enter a standalone path. An unregistered copy in that
scope fails closed, and even a copy whose anonymous entry was registered before
admission cannot mint a call without its own `Budget`. Explicit anonymous
credential probes remain uncharged. Independent direct `api()` calls may share
an unadmitted scope: standalone calls and probes have no served invocation to
charge. Request membership detects missing authority; it never recovers the
original view's caller, permit or ledger.

**Provision (calls).** Invocation builds the call layer once per dispatch, in
the scoped attempt that already owns the permit (the `call(permit)` closure in
`invocation.ts`). It takes each service from code, never from arguments
(INV-4):

- `Caller` comes from the operation entry, which came from the admitted
  registry scope.
- `Budget` comes from the permit.
- `Classification` is `target.definition.classification`. That is the
  registry's served verdict, so deployment config wins over the tool's own
  annotation.
- `Recovery` writes into a record the invocation holds, which replaces
  `dispatchContext` and `recoveryFor`.
- `Secrets` is a per-call set included in the request set.
- `Credentials` reads through the registry's credential access.
- `Signal` is the call signal from `withDeadlineEffect`.

**Lifetime.** A `Context` service is a value: code can keep one past its call,
and ending a fiber revokes nothing it handed out. A scope does not cancel a
Promise the call started either. So every call-owned capability has an
explicit finalizer and a closed-state check:

- `openCall` returns a lease whose `close` is the call's finalizer. Invocation
  registers it on the attempt scope (`Effect.addFinalizer`), so success,
  failure, the deadline and cancellation all close it.
- `Credentials.values` and `Budget.charge` check the lease before they start,
  race every await against closure, and pass an abort signal to the underlying
  work. Closing settles paused uses promptly without waiting for their Promise
  to settle or a test to release it. A use after close fails with
  `connector_call_failed` ("This call has ended…"). `Recovery.record` drops late facts,
  because invocation has already read the record. Each lease owns an
  `AbortController`, forwards the admitted parent signal, and aborts its own
  `Signal` on close, removing the parent listener. Closing the containing
  request closes every attached call lease too. The transport checks this
  signal before preparation and immediately before dispatch, races pending
  preparation (including authentication that never reads `Credentials`)
  against it, and passes it to fetch. Retained and pending work cannot send
  after either boundary closes.
- The Promise view's `credential`, `chargeConnectorCall` and
  `recordRecovery` go through the same lease, so a retained view refuses in
  the same way. B.1 closes the Promise view's credentials too; it does not
  wait for D.6.
- Every Promise-view capability and connector operation races its **whole
  caller-facing Promise** at its entry boundary. `settleOnClose` checks the
  owner before synchronously starting work, observes any detached rejection,
  and settles the caller when its call lease or request closes. Correctness
  does not depend on finding and racing every internal storage, crypto,
  token-resolver or response-cleanup await. Credentials and budget services
  already provide the same structural race at their Effect boundary.
  Per-await races remain where they abort real I/O or stop a storage
  continuation from submitting another write. A detached continuation must
  still pass the transport's preparation/dispatch checks and the lease's
  capability guards; it cannot deliver a result to the closed caller.
  Handler and helper races sit inside the existing write/fact settlement
  boundary, preserving its single decider. Auxiliary joins use the request
  owner, and shared session joins retain separate caller waiters. Submitted
  refresh coordination and tracked cleanup retain their independent owners.

What a call owns and what its request owns are kept apart:

- **Call-owned:** the lease's capabilities, the dispatch ledger, the grant's
  use for this call and the caller's renewal wait. Renewal preparation is
  call-owned only until the first durable coordinator write (the claim CAS)
  is submitted. Closing either the call or request before that
  submission promptly aborts preparation: no CAS, no token request and no
  state change. Late read results cannot resume renewal. A closed capability
  fails with "This call has ended…".
- **Storage-coordinator-owned from claim submission:** ownership transfers
  synchronously when the first claim CAS is submitted, before its promise
  settles and before any authorization-server token request. The coordinator
  completes preparation under its independent 35-second deadline, then uses
  a 20-second deadline for the token request and response body and commits
  the rotated grant under the existing epoch and spent-fingerprint fences.
  A winning claim proceeds to the token request and commit; a losing claim
  follows the existing contention/adoption path. Workers retains completion
  through `defer`/`waitUntil`. Neither the call nor request signal can stop
  this work after submission. Closure still promptly ends the caller's wait;
  the closed call consumes no result, changes no ledger renewal fact and
  sends/resends no resource request. Cancellation therefore cannot abandon
  a fenced claim without completing its token exchange. No rollback or
  cancellation-triggered re-consent exception is needed.
  Authorization-code exchange submits no refresh claim; its auxiliary token
  fetch and its pending wait abort on explicit request revocation, including
  operations with a `requestScope` and no external signal. A token reply that
  arrives after revocation cannot persist access or refresh tokens. The
  callback route retains its existing uninterruptible ownership and does not
  revoke its scope midway through exchange; explicit revocation is a separate
  boundary. An aborted code exchange requires another authorization, not
  recovery of a durable refresh claim.
- **Request-owned:** a `remoteMcp()` session or transport, a request-token
  flight, the request's sent-secret set, invocation auth and handoffs. They
  outlive the call that opened them and close when the request scope closes.
  A session that needs a credential after the call that opened it reads it
  through the operation's credential access under the request signal, never
  through a call's `Credentials`, which is closed by then.
  Operation preparation and I/O resolve the request signal even when no
  caller signal was supplied. Request-owned auxiliary work ignores call
  closure while retaining request revocation and external cancellation.
  A shared remote MCP session does not lend its connection lifetime to
  renewal preparation: each challenged response binds that preparation to
  its initiating call until claim submission transfers coordinator ownership.
- **Closing a request cannot be cut short.** Revocation comes first and
  cannot throw: the request's operation and call views stop resolving, and
  every call lease reached through them closes, so no caller, credential or
  charge outlives the request. Then the request signal aborts and every
  finalizer runs, each guarded on its own, in reverse order. Failures are
  collected and thrown together as one `AggregateError` after all of it ran,
  so a second `close` has nothing left to repair. A view opened on a request
  that already closed resolves nothing.

**Two ways into the connector.** `Connector.callTool` is published and
Promise-shaped, so services cannot reach a handler through it.

1. **Effect path (every `api()` connector).** `api()` registers an Effect entry
   beside its connector, a function from `(name, args, options)` to an
   `Effect` that requires the call services. It is held in a module-private
   WeakMap keyed on the `Connector`, the same pattern as
   `registerInvocationAuth`. When an entry exists, invocation runs it in the
   attempt fiber with `Effect.provideContext(services)`. One core in `api()`
   builds both this entry and `callTool`, so argument validation, result
   redaction, and withheld handler text stay identical. A kit tool then sees
   services and never a context; what it keeps past the call is closed
   (above).
2. **Promise view (custom handlers, unmigrated providers, `remoteMcp()`).**
   `contextView(lease, operation)` builds the published `ConnectorContext`, or
   `ApiHandlerContext` for a handler:
   - `storage`, `logger`, `baseUrl`, `publicUrl`, `oauthClientName`,
     `requestScope`, `timeoutMs` and `defer` come from the registry's base.
   - `credential`, `signal`, `fetch` and `oauth` are facades over the lease.

   Views resolve through one module-private table keyed on the view a copy was
   derived from, so A.2's derived copies read the same entry. `callerOf`,
   `chargeConnectorCall`, `recordRecovery`, `sentSecretsFor` and
   `callClassification` become one-line lookups. The six WeakMaps become one.
   The published types do not change (INV-13); caller, permit and recovery
   stay off them, as today.

**Probes.** `testCredential(s)` gets a call layer built from the candidate
values, with no `Caller`, a `Budget` that never charges, and `Classification`
`"read"`. It copies no context. Most of the twelve `{...ctx}` sites 0009 counts
are probes, so this removes them. The rest become `deriveContext` calls in
A.2.

**New tests (B.1).** The prototype already proves each rule on its own
mechanism (`http-kit.test.ts`, "call services"); B.1 proves them on
invocation and the registry:

- "INV-7: a service kept past its call refuses to read credentials, charge, or
  record", and the same for a retained Promise view.
- "INV-7: closing a call or request promptly settles paused credentials and
  budget without releasing their underlying operations", including the
  Promise bridge's request ownership.
- "INV-7: closing a call or request promptly refuses production OAuth renewal
  paused before claim submission, with no CAS, token request or state change",
  through `api()` static OAuth and the SDK's downstream OAuth grant path.
- "INV-5 INV-7 INV-9: closing a call or request after claim submission promptly
  refuses the caller while the coordinator finishes the token request and
  rotation commit without resending a resource request". Pauses cover claim
  submission before CAS completion, the read after claim CAS, liveness and
  dispatch replies, spent CAS and the dispatched token request, for read and
  write 401s. Further tests prove losing-claim adoption and the independent
  preparation deadline (`test/call-renewal-lifetime.test.ts`).
- "INV-4 INV-10: discovery, status, and startAuth views carry each request's
  own caller across two pools", through `RegistryView`s for `alice` on `crm`
  and `bob` on `tickets`: catalog-cache's private fallback, `remoteMcp()`'s
  negotiation partition, and `startAuth`'s authorizing copy each read their
  own caller, and a spread copy reads none.
- "INV-7: a request-owned session outlives a call but not its request, and its
  pending work ends with the request".
- "INV-7: a finalizer that throws, in any position, stops no other cleanup,
  and the request's views and leases are revoked first".
- "INV-9: invocation reads recovery facts from the call's record, not from a
  context".
- "INV-4: an api() Effect entry receives the admitted caller and the served
  classification, never one named in arguments".

### B.2 Guarded client and refresh-once

`guardedClient(options)` is built with `HttpClient.makeWith`. In 4.0.5,
`HttpClient.make` (and with it `FetchHttpClient`) opens a span through
`Effect.useSpan` and writes `b3` and `traceparent` headers while
`TracerPropagationEnabled` is on, which is the default. That would change the
requests sent and hand request facts to whatever tracer is installed.

| `guarded-fetch.ts`                                                                                              | Kit                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL: https (http only on loopback), no URL credentials, query or fragment; throws at construction (INV-11) | `confinementBase`, the same function                                                                                                                    |
| Path is provider-relative with no `?` or `#`; origin and prefix re-checked after normalization                  | `preprocess`; `RequestRefused` → `invalid_args`, before any credential is read                                                                          |
| `query`: `undefined` dropped; an array repeats its key                                                          | `HttpApiClient` encodes the operation's query Schema; struct field order is wire order                                                                  |
| `admit(url)` on the encoded URL, before authentication                                                          | `GuardedOptions.admit`, an Effect, in `preprocess` before `authenticate`                                                                                |
| Constant headers, then request headers, then auth applied last; a shadowing auth header is refused              | `preprocess`: constants, then `authenticate` (an Effect over `Credentials` or `Grant`); a collision is `RequestRefused`                                 |
| JSON `body` gets `Content-Type: application/json`; `rawBody` is sent as framed; the two are exclusive           | `HttpClientRequest.bodyJsonUnsafe` / `bodyUrlParams` / `bodyText` set the type; the wire carries the body's retained text                               |
| `sentSecretsFor(ctx).header(v)` per auth value, then `.request(url, init)` on the final URL and form body       | the `Secrets` service, with the same calls; a form body is registered from its text                                                                     |
| `visibleHeaders` added after registration; a collision is refused                                               | the `write` builder adds the idempotency header in `postprocess`, after registration                                                                    |
| `fetch` override: `oauthBearer` routes through `ctx.oauth.fetch`                                                | `refreshOnce` over `bearer`, below                                                                                                                      |
| `redirect: "manual"`; 301, 302, 303, 307 and 308 cancel the body and refuse                                     | `postprocess`: `RedirectRefused` → `connector_call_failed`, non-retryable                                                                               |
| Declared `Content-Length` over the ceiling refused, except on HEAD or an ok `prefixOnly` read                   | `postprocess`: `ResponseTooLarge`; `prefixOnly` arrives with its first user (Google media)                                                              |
| Streamed body capped at one chunk past the ceiling, then cancelled; no stream → measure the buffer              | `readReply`: `Stream.runFoldEffect` over `response.stream`; `EmptyBodyError` falls back to a measured `arrayBuffer`                                     |
| 204, 205, 304 and HEAD have no body                                                                             | the same sets                                                                                                                                           |
| Bytes decoded as UTF-8, never `text()` (INV-6)                                                                  | `TextDecoder` over the bounded bytes                                                                                                                    |
| `jsonResult` tells unparseable text from a transport failure                                                    | `connect`'s settle step: `StatusFailure` with the parsed body, `UnreadableBody` for a 2xx that is not JSON; empty is `undefined`                        |
| `fetch` rejection → `unavailableCallError(cause, url, …, signal)`: errno and host only                          | `TransportFailure`, mapped through `unavailableCallError` unchanged; the ledger records `lost`, since no rejection proves a write unsent (#902 round 8) |
| `ctx.signal` handed to `fetch`                                                                                  | the `Signal` service combined with the fiber's interrupt signal through `AbortSignal.any`                                                               |
| `retryAfterMs(headers)`                                                                                         | the same function, moved to a module both transports share                                                                                              |

A provider never holds an `HttpClientResponse` or a raw body. `Send` returns an
`Answer` that already passed the value-safety boundary (B.4).

**Fixed capacity and the dispatch ledger.** Write capacity belongs to the
**tool declaration at construction**, never to `Send`. `writeSteps` is a
closed set of literal step names; the default is one implicit `write` step.
Each entry is either `"once"`, or a bulk declaration with a positive finite
`maxItems` and a pure selector of deterministic item identities from validated
arguments. The builder snapshots the declaration at construction. After input
validation/decoding, before the program runs, it calls each selector exactly
once, copies its identities, and refuses duplicate/empty identities or a set
past the declared bound. The selector must derive identities from arguments,
never an attempt counter, a random value, or mutable retry state. The allowed
set never grows while the program runs or retries. A send naming an undeclared
step or unselected item is refused before preparation or dispatch. A bulk tool
uses `sendItem("rows", row.id)`: the kit derives each request with the
step's pure `request(item, args)` declaration exactly once before `run`,
snapshots it, and keys the reservation on canonical identifying request
content as well as its closed slot. Arbitrary selected strings alone prove
no identity. Aliases with identical canonical request content are rejected
across the whole call before any send; rotating through selected ids cannot
send an unchanged request twice. `sendPath` and direct-client paths must
match the bound request at the transport boundary too. An upload declares
`session` and `bytes` as separate `"once"` steps.

The prototype canonically compares method, normalized path, and lossless
ordered multimaps of query, form and JSON identifying paths. Distinct keys
sort canonically; repeated values keep their order and multiplicity. JSON
structure, nested paths and escaped property names are retained. Duplicate
identifying keys are rejected before dispatch unless the snapshotted item
contract declares multi-value semantics for that query/form key or JSON
Pointer. The comparison never uses `Object.fromEntries` to collapse wire
parameters. Unrecognized body encodings fail closed. B.4 extends the same
binding to typed operations and uploads with reviewed canonical identity
adapters (or vendor idempotency keys), never by ignoring unsupported content. Each vendor review must verify its identifying content,
including equivalent aliases/encodings, so two ids cannot name the same
logical request. The kit derives the request from the item, not from the
program's current retry counter.

```ts
interface Dispatch {
  readonly write: boolean;          // served classification is write, effect is call
  readonly step?: string;           // construction-declared step; default write
  readonly item?: string;           // identity in the call's fixed, bounded item set
  readonly operation?: OperationRef;
  state: "reserved" | "preparing" | "pending" | "lost" | "answered"; // "unconnected" is gone (#902 round 8)
  status?: number;                  // recorded as soon as the resource server answers
  headers?: Headers;
  failure?: HttpFailure;            // only this request's own failure, never a blocked retry's
  renewed?: true;
  request?: ProviderRequest;        // its core ledger entry, dispatched synchronously before fetch
}
```

**Atomic, permanent reservation.** `Send` reserves the `(call, step, item)`
slot in one synchronous check-and-insert before encoding a body, authenticating,
or awaiting any preparation. The transport atomically claims that reservation
before it evaluates preparation. A direct `HttpClient` call reserves and claims
there instead. Nothing yields between the slot check and insertion or claim,
so `Effect.all(..., { concurrency: "unbounded" })` cannot admit two sends.
A wrapper that retries below `Send` sees the same claimed reservation and is
refused too. A reservation is **never released**, including after a failure
before dispatch. This deliberately gives up an in-call retry even when nothing
left: retaining the slot makes two sends impossible; a new deliberate call
gets fresh capacity, and a failure the ledger proves unsent (provenance (a))
may still be advertised retryable. No request id, body, URL, retry counter or
new step name can mint capacity.

Reservation and replay share the core's `readRequest` classifier. Only
positive read classification together with the method actually sent being
GET/HEAD proves a read; any recognized method-override header forces a write.
A reviewed POST read, missing classification, or an auxiliary label does not
prove a read. Known writes keep their early claim before preparation; after
preparation, the transport checks the core entry and final outgoing headers
(including authentication) and atomically claims capacity for any additional
physical write before dispatch. An undeclared step/item is refused there.

`reserved` and `preparing` have not dispatched. Immediately before `fetch`,
in the same synchronous step, the transport enters the request in the core
ledger (`dispatchProviderRequest`, which refuses a request whose call has
ended), marks the slot `pending` and associates it with the attempt. A read
needs no reservation and enters both ledgers there. Every fetch rejection is
`lost`. _Superseded (rounds 3–5):_ a rejection was `unconnected` for a
never-connected errno (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EAI_FAIL`,
`EHOSTUNREACH`), which proved the write unsent. #902 round 8 showed that one
`fetch` can hide several attempts, so the last attempt's errno says nothing
about the first. A write interrupted after dispatch stays `pending`.
Authorization-server requests never enter this resource ledger.

The slot's `failure` records only its own preparation or answer failure, never
`ResendRefused` from a later attempt. `Send`'s attempt slot distinguishes its
request from later auxiliary requests. B.3 maps a blocked retry to the
original reservation's own answer, carrying that attempt's provenance, and
the core decides over the whole call. A first attempt that never dispatched
reports its own failure, and the ledger proves it unsent; a sole served
refusal stays known; anything else that left is unknown and non-retryable.
A recorded 401 keeps its auth handoff until renewal succeeds (Q8).

This holds below Effect retries, program retries, 307/308 followers, replaying
renewals, reconnects and new request ids. It also holds when a retry tries fresh
step names or item ids. Only requests the core positively classifies as reads
may be replayed; `{ effect: "read" }` does not bypass capacity. Auxiliary
requests the core classifies as writes need their own declared steps. Tests cover async-auth
concurrency through both entry paths, preparation failure, the reviewer's
`Effect.suspend` counter repro, fixed upload steps, bounded bulk concurrency,
whole-loop retries, duplicate/unselected ids and construction bounds.

**Two transports during Phase C (Q6).** `guarded-fetch.ts` stays a Promise
module for unmigrated providers, and is deleted with its last caller. It does
not become a facade over the kit client: `remote-mcp.ts` imports
`retryAfterMs` from it, and the kit client alone adds 31,260 B gzip to the
root, more than the root's headroom. B.2 moves the pure pieces
(`confinementBase`, `retryAfterMs`, the redirect and bodiless sets) into one
plain module both transports import, and adds a parity suite. The suite runs
one fixture matrix (confinement, header precedence and collision, form
registration, redirects, declared and streamed ceilings, errno normalization,
`Retry-After`) through both transports and requires the same requests, the
same core ledger entries and the same mapped failures. The never-connected
errno set this paragraph once listed was deleted by #902 round 8.

**Transport attempts (#902 rounds 8–9).** B.2's guarded `HttpClient` is the
documented place to own transport attempts: one attempt per send, and no
hidden resends on Node. Until it does, the kit inherits native `fetch`'s
behaviour, as `guarded-fetch.ts` does, and #902 recorded three ways one
`fetch` can send a request more than once:

- **421.** Node's fetch (undici) resends a request answered 421 Misdirected
  Request, even with `redirect: "manual"`. Round 8 reproduced a Planning
  Center POST arriving twice when the listener stayed open.
- **`RetryAgent`.** An operator-installed undici dispatcher such as
  `RetryAgent` retries a reset connection behind the same call.
- **HTTP/2 refused stream.** A fetch that negotiates h2 can resend after
  `REFUSED_STREAM`. Node 22's built-in fetch does not negotiate h2, so this was
  not reproducible on CI's Node; it is expected on Node 24 and 26.

So no rejection is evidence today. Every transport failure of a write that
left, on the kit or on `guarded-fetch.ts`, is unknown and never retryable,
however the last attempt failed. Owning attempts means B.2 sends through a
dispatcher it configures (no retry interceptor, no 421 or refused-stream
resend) or refuses to send. Even then a rejection becomes evidence only by a
separate decision taken with the core contract, never by a kit rule. Round 9
adds the other half: repeatability comes only from a genuine key the vendor
receives (`ProviderRequest.key`), never from a method or an operation hint.

**B.2 runtime decision and attempt evidence (2026-10-22).** Node sends
through `src/http/node-transport.ts`, installed in the plain runtime slot by
`listen` from `/node`. The root and Worker graphs import neither that module
nor undici. Undici 6.29.1 (the Node 22-supported 6.x line) is an exact optional
peer and dev dependency, and the Node template installs that exact version.
The owned client uses low-level `Client.request`, `allowH2: false`,
`idempotent: false`, `pipelining: 0`, no interceptors and no redirects. Every
send gets its own client, closed with the response body or cancellation; it
never obtains the operator's global dispatcher. A Node write without this
slot fails before dispatch, naming `@zackbart/connecta/node`; a read may use
native fetch. Importing the root alone does not configure a Node sender.
The configured slot is deployment code, never request data.

The Node 26.12.0 socket repro answered a POST 421 with the listener kept
open: native fetch delivered twice; the owned client delivered once. A
global RetryAgent configured for POST/503 delivered twice (both undici 6's
Node 22-compatible fetch and Node 26's native fetch using undici 8's global
dispatcher protocol); the owned client delivered once under the hostile
global dispatcher. HTTP/2 did **not** reproduce a hidden resend: native Node
26 with HTTP/2 explicitly enabled delivered one stream, then rejected on
`REFUSED_STREAM` with `ERR_HTTP2_STREAM_ERROR`; the default HTTP/1.1 probe
delivered once. The owned sender disables HTTP/2 entirely. These observations
are evidence for those probes, not a claim that native fetch never retries.

Workers uses native fetch with manual redirects, the call/fiber abort signal,
and a bounded response reader. The
[Workers Request contract](https://developers.cloudflare.com/workers/runtime-apis/request/)
defines manual redirect handling; its
[fetch contract](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
does not expose an undici dispatcher or promise one physical network attempt.
There is no application replay or configurable retry middleware on this path;
platform-internal recovery is not evidence of non-dispatch. In both runtimes
all transport rejections remain `lost`, and the core never infers an unsent
write from an errno.

**Phase C transport decision.** `guarded-fetch.ts` keeps native fetch and its
existing provider overrides for this PR; it does not receive the owned
Node-dispatcher change. Changing those OAuth/delegated sends is a separate
migration. No provider changes transport here. Both transports share
`src/http-policy.ts`; `guarded-transport-parity.test.ts` compares one fixture
table's exact requests, sent-secret registration, core ledger entries and
mapped failures, on Node and workerd. Header precedence is case-insensitive:
request headers replace constants even when their names differ in case, and
collision messages name the lowercase field. This corrects the Promise
helper's prior accidental concatenation of differently cased overrides; the
maintained provider goldens remain unchanged. Its table replaces the superseded
transport tests in `http-kit.test.ts`. Production Grant/facade parity also
replaces its synthetic renewal/accounting cases; generic Grant interruption,
direct-client overrides and vendor authentication proof remain distinct.
Fixed-capacity tests retain their existing generated cases.

**Refresh-once** (`src/http/oauth.ts`). `Grant` is any renewable token. The
rule replaces four per-provider renewals after a 401: the static OAuth grant,
Google's service-account mint, Infisical's login, and GitHub's App
installation token.

```ts
class Grant extends Context.Service<Grant, {
  readonly token: Effect.Effect<string, HttpFailure>;
  readonly refresh: (stale: string) => Effect.Effect<string, HttpFailure>; // rotated-in token, else one coordinated refresh
  readonly rejected: Effect.Effect<never, HttpFailure>;                    // latch the request scope; the grant's own verdict
}>()("connecta/http/Grant") {}
```

1. A 401 earns one `refresh(stale)`. Renewal is call-owned only until the
   first durable coordinator write (the claim CAS) is submitted. Closing
   the call or request before submission aborts with no CAS, token request
   or state change; late reads cannot resume preparation. At submission,
   ownership transfers synchronously to the OAuth storage coordinator,
   before CAS completion or token dispatch. Preparation keeps its independent
   35-second deadline; the token request and body have a 20-second deadline,
   followed by the fenced grant commit. A winning claim sends the token
   request and commits the rotation; a losing claim follows the existing
   loser path. `defer`/`waitUntil` retains completion on Workers. No call or
   request signal controls that work after submission, and no rollback is
   introduced. The caller's wait remains call-owned: closure promptly fails
   it with "This call has ended…", and the closed call cannot consume a
   renewal result, mark its 401 renewed or send/resend a resource request.
   Cross-isolate coordination uses storage (`downstream-oauth.ts`), never a
   request-owned fiber shared across requests. Other grant implementations
   forward cancellation to their call-owned I/O. The 401's body is read under
   the ceiling first, so nothing stays open while renewing.
2. A request the core's shared `readRequest` classifier proves read is
   replayed once: positive read classification, an actual GET/HEAD method,
   and no recognized method-override header. This supersedes the earlier
   wording that reviewed POST reads or `{ effect: "read" }` alone earn a
   replay. Reviewed POST reads and auxiliary POSTs instead reserve write
   capacity (or are refused) and receive no 401 replay. Kit and Promise OAuth
   middleware consult the actual core entry; neither keeps a second classifier.
   `authenticate` runs again and reads the renewed token. A second 401 runs
   `rejected`, which keeps `static-oauth`'s request-scope latch and its
   `downstream_oauth_required` wording.
3. A write request is never resent (INV-9), whatever its method. Its answer
   was recorded in the ledger when the resource server gave it. The renewal
   still runs, so the next deliberate call works, but whatever the
   authorization server does (refuses the refresh for good, throttles it,
   fails DNS, goes down) is not this write's verdict. The ledger keeps one
   fact from it, `renewed` when the renewal succeeded, because that alone
   decides whether the agent still needs the `authorize_connector` handoff.
   Refresh-once then hands the write's own 401 back to the pipeline, and the
   core's Q8 decision (`settleWrite`, #917) reports it from the ledger. A
   caller who leaves during the renewal gets the same verdict: the builder's
   edge records the 401's facts when the call's signal aborted
   (`recordUnauthorized`; until #917 the kit's own `departedVerdict` decided
   here), and the core decides. A refresh-once that did resend would still
   be stopped by the one-dispatch guard.
4. Refresh-once decides no verdict. The tests prove the rule both ways (a
   read built tool served as a write is not resent; a write built tool served
   as a read is replayed only for a positive GET/HEAD), for a renewal that succeeds, for each renewal
   failure, and for a cancellation.

The static OAuth facade bounds each discarded 401 challenge at 1 MiB before
renewing; an oversized challenge does not start renewal. Broken bounded body
reads retain the 401, and Q8 remains the core's decision. The kit uses its
provider's declared response ceiling.

`ctx.oauth.fetch` keeps its published contract for custom handlers. It returns
a `Response` and allows every `apiOrigins` origin, so it shares this decision,
not the client: #902 makes its renewal failures keep the write's unknown
outcome too (`unsentAfterUnauthorized`, with `writeOutcome: "unknown"`). The
one difference #902 left, a renewal that fails without an authorization
verdict (a throttled or unreachable token endpoint) reported as
`connector_call_failed`, is gone: the 401 back-port (#917) made
`unsentAfterUnauthorized` keep the resource server's auth verdict and its
handoff until renewal succeeds, always non-retryable with
`writeOutcome: "unknown"`, the kit's verdict. B.2 adds parity tests through `Grant` and
`ctx.oauth.fetch` for permanent refusal, throttling, DNS failure, outage,
cancellation, successful renewal and oversized/broken 401 bodies. It also
checks direct calls and caught/uncaught program accounting against #902's
`classifyWriteOutcome`, and records the wording changes in the OAuth goldens.

Since #902 the goldens record one 401 behaviour for a write: it is never
resent. Google mints a token and sends the write once (two requests), and
Infisical logs in again without resending it. Both already report the write
unknown with its auth code. Since the 401 back-port (#917), providers on
`guarded-fetch.ts`, Tithe.ly among them, report it the same way, and C.5 and
C.7 adopt Q8 as it stands. _Superseded (round 2):_ the goldens
recorded Google minting and resending once, writes included, and C.7 was to
stop that resend. #902's first fix round stopped it.

### B.3 Tagged errors, vendor facts and the wire mapping

Every kit failure is one tag of `HttpFailure`. Each tag reaches the wire
through `toConnectorCallError` (`src/http/errors.ts`). For a write, that
mapping is the vendor's verdict and its provenance, not the write's outcome:
`api()`'s boundary decides that with the core (below).

| Tag                | Raised by                                                              | Wire                                                                                   |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `RequestRefused`   | confinement, `admit`, header collision                                 | `invalid_args`, before anything is sent                                                |
| `TransportFailure` | `fetch` rejected                                                       | `unavailableCallError`: errno and host only                                            |
| `RedirectRefused`  | 3xx                                                                    | `connector_call_failed`, non-retryable                                                 |
| `ResponseTooLarge` | declared or streamed bytes past the ceiling                            | `connector_call_failed`, non-retryable                                                 |
| `ResendRefused`    | a second dispatch of a logical write in one call (B.2)                 | the original attempt's own answer, with its provenance; the core decides over the call |
| `StatusFailure`    | non-2xx, or an in-band refusal mapped as a status                      | the vendor's rules, then its table, then the defaults                                  |
| `UnreadableBody`   | a 2xx that is not JSON                                                 | `connector_call_failed` with the vendor's `unreadable` text                            |
| `Refusal`          | the provider or kit's own verdict (in-band, credential, cursor, grant) | the carried `ConnectorCallError`                                                       |

`StatusFailure` carries its `operation` (`{ method, template, flags? }`), set by
`Send` before the answer is read, so value safety decides what the failure may
quote before any detail exists.

**B.3 implementation reconciliation (2026-10-22).** `src/http/errors.ts`
is the internal failure contract, with one completeness-checked tag vocabulary
shared by the typed-client boundary. Providers remain unmigrated. Mapping
rules now have ten compact table rows in `http-kit.test.ts`; Stripe's former
360-combination comparison is sixteen distinct branch rows, keeping its
separate token-narrowing and core-provenance checks. The whole-call core table
remains unchanged.

A blocked physical write reports its first reservation's answer even when
the tool is classified read: the core's positive-read rule can require write
capacity for a POST or method override. The default server-error range is
500–599. The core retains a diagnostic `retryAfterMs` on a generic unknown
write while forbidding retry; Q8 removes both retryability and wait. The kit
preserves those core fields and never strips them with a second outcome rule.
No caller-facing Promise entry is added; B.1's boundary/lifetime matrix and
B.2's transport/renewal contracts remain the entry points.

**The vendor contract.** Classification and wording are two steps, and the
first cannot reach prose:

```ts
interface VendorErrors<F extends Facts> {
  readonly provider: string;                                   // prose only, never parsed
  readonly facts: (tokens: unknown) => F;                      // over a token-only copy of the body; runs on every failure
  readonly headers?: readonly string[];                        // reviewed allowlist, by name; nothing else is visible
  readonly classify?: ReadonlyArray<(input: Classified<F>) => Verdict | undefined>; // across statuses, in order
  readonly statuses: { 401; 403; 404 /* required */; [status: number]; serverError?; otherwise? }; // Classified<F> => Verdict
  readonly detail: (input: { status; facts: F; headers; withheld: boolean; body?: unknown }) => string; // after classification
  readonly unreadable: string;
  readonly authBeforeExecution?: { evidence: string; matches: (input: Classified<F>) => boolean }; // Q8, raw 401 only
  // nonExecution: removed in the final round. A 5xx never proves a write unapplied (#902).
}
interface Classified<F> { status; facts: F; headers; retryAfterMs; operation: OperationRef; withheld: boolean } // no detail, no body
interface Verdict { code; retryable?; retryAfterMs?; current?; words?: (detail: string) => string; advice?: string }
```

The kit runs them in this order for every `StatusFailure`:

1. **Tokens.** `facts` receives a copy of the error body that keeps only
   tokens (1–128 characters of `[A-Za-z0-9_.:[\]-]`, keys included), finite
   numbers, booleans and null, to a depth of 32. A vendor's message, a URL or
   a quoted value is not there to read, so even a careless extractor (one
   that tests `String(error.message).includes("expired")`) finds nothing. A
   one-word message survives only as the token it is.
2. **Facts.** The extractor's result keeps tokens, finite numbers and
   booleans. Lists stay complete: a rule sees every reason, however many,
   bounded only by the response ceiling.
3. **Classification.** The `classify` rules, then the status table, then the
   defaults, each given `Classified`: the status, the facts, the allowlisted
   headers, `retryAfterMs`, the operation and `withheld`. There is no detail
   line and no body in that type, so a rule that reads either does not
   compile, and at run time this failure's detail line does not exist yet. A
   rule returns a `Verdict`: a code and its retry advice.
4. **Wording.** Only now does the kit call `detail`, with each list cut to its
   first eight entries for display, and the body only when the operation
   does not withhold vendor text. The verdict's `words` receives that line and
   returns the message; without `words` the message is the line itself.
   `words` decides nothing: the code, retry advice and wait were copied from
   the verdict before it ran. Advice to send the call again is never in
   `words`. It is the verdict's `advice`, attached as #902's structured
   `resendAdvice` segment, and output composes it only where the outcome
   allows: for a read or a known refusal, never for an unknown write.

- **Headers are an allowlist.** Only the names a vendor's review lists are
  visible to rules and wording, and a value longer than 128 characters or with
  a control character is dropped. `Retry-After` is read separately into
  `retryAfterMs`.
- **Value safety decides first.** `withheld` comes from the connection's
  `ResultSafety.withholdsErrors(operation)` (B.4). When it is true, `detail`
  receives no `body`, only facts and allowlisted headers, so a stored secret
  a vendor echoes in its prose cannot reach the wording.
- **401, 403 and 404 are required by the type.** Their meaning differs by
  vendor. A 404 is `not_found` only where absence can be told apart from
  reach. Tithe.ly's 404 is deliberately `connector_call_failed`.
- **Defaults cover the rest:** 400 and 422 → `invalid_args`; 429 →
  `rate_limited` with `Retry-After`; 5xx → `unavailable` with `Retry-After`;
  any other status → `connector_call_failed`, non-retryable.
- **409 has no default.** A vendor that documents its 409 may name it
  `conflict`. The code is the agent's diagnosis; the write's outcome reads
  it only through `servedRefusal`. A write's own served 404 or 409 is a known
  failure by provenance (b) only when it passes `servedRefusal`: the status
  is a 4xx other than 408 (`refusedStatus`), and the code the provider maps
  it to (`classifyCallError(error).code`) is neither `unavailable` nor
  `timeout`. It must also answer the one request the logical call sent, and
  the failure must carry no explicit unknown marker. A vendor that maps its
  404 or 409 to `unavailable` or `timeout` leaves that write unknown and
  never retryable, on the kit and the core alike; mapped to `unavailable`, it
  becomes `connector_call_failed` with `writeOutcome: "unknown"`. Tithe.ly
  keeps `connector_call_failed`, non-retryable and in unchanged words, for
  both, because it cannot tell absence from reach or name the conflict. That
  code passes `servedRefusal`, so both are known failures and neither carries
  a `writeOutcome`.
- **What the types cannot stop.** A rule that closes over mutable module state
  could carry one failure's wording into the next failure's classification.
  That is code review's to refuse; the contract makes it the only way, and a
  visible one.

**Stripe** (`stripeFailure`, proven equal over 16 distinct branch rows):

```ts
const stripeErrors: VendorErrors<{ type?; code?; declineCode?; param? }> = {
  provider: "Stripe",
  facts: (tokens) => ({ type, code, declineCode: decline_code, param }),  // error.* fields
  headers: ["request-id", "stripe-rate-limited-reason"],
  detail: ({ status, facts, headers, withheld, body }) =>
    `Stripe ${kind || `HTTP ${status}`}${param}: ${withheld ? "Stripe's message is withheld…" : message(withholdEmbeddedUrlsIn(body))}${requestId}`,
  classify: [({ status, facts }) => status === 429 && facts.code === "lock_timeout"
    ? { code: "conflict", retryable: true, retryAfterMs: 1_000, words: (detail) => `${detail} Another request is changing this object…`,
        advice: " Retry after it finishes." } : undefined],
  statuses: { 429: rate_limited(reason header, retryAfterMs ?? 1_000, advice " Back off before retrying."), 401: auth_required, 403: provider_permission_denied,
    404: not_found, 400/409/422: invalid_args, 402: connector_call_failed, 424: unavailable, serverError: unavailable (no wait) },
};
```

Stripe's own raw HTTP 429 + `lock_timeout` answer maps to `conflict` with
its existing 1,000 ms wait and its advice to retry after the other request
finishes. On a write it is a known refusal by provenance (b), a served 4xx
other than 408 on the call's one request, not because of its code. The same
token on a raw 503 is unknown, since a 5xx never proves a write unapplied.
Stripe's 424 maps to `unavailable`, which `servedRefusal` reads as no
refusal, so a write answered 424 is unknown too. The case table and the
Stripe suite cover all three. _Superseded (rounds 4–5):_ a `nonExecution`
declaration citing the vendor's
[object-lock-timeout guarantee](https://docs.stripe.com/rate-limits#object-lock-timeouts)
marked the 429 non-executed. The merged contract has no third kind of
provenance, so the declaration and the kit's `nonExecution` field are gone.
The guarantee still justifies the retry advice.

The one narrowing: a `param` outside the token grammar (a param name with
spaces) is dropped where `stripeFailure` quotes it; the suite records it.

**Cloudflare** (`failureFor` in `cloudflare/rest.ts`):

```ts
const cloudflareErrors: VendorErrors<{ codes: number[]; authCode: boolean }> = {
  provider: "Cloudflare",
  // errors[].code and every error_chain code, all of them.
  facts: (tokens) => { const codes = errorCodes(errorsOf(tokens)); return { codes: [...codes], authCode: [...codes].some((code) => AUTH_ERROR_CODES.has(code)) }; },
  headers: ["cf-ray"],
  detail: ({ facts, headers, withheld, body }) =>
    `${withheld ? `Cloudflare error code ${facts.codes.join(", ")}. Its text is withheld…` : describeErrors(errorsOf(withholdEmbeddedUrlsIn(body)))}${headers["cf-ray"] ? ` Ray ${headers["cf-ray"]}.` : ""}`,
  classify: [
    // 429 before the authentication codes: Cloudflare reuses 10000 on throttled responses.
    ({ status, retryAfterMs }) => status === 429 ? { code: "rate_limited", retryAfterMs: retryAfterMs ?? 300_000, words } : undefined,
    ({ status, facts }) => status === 401 || facts.authCode ? { code: "auth_required", words } : undefined,
  ],
  statuses: { 401: auth_required, 403: provider_permission_denied, 404: not_found,
    400/405/409/415/422: invalid_args, serverError: unavailable (no wait), otherwise: connector_call_failed },
};
// `result` (B.4) turns `success: false` into StatusFailure({ status: status === 200 ? 400 : status, body, operation }).
```

**Google Workspace** (`classifyApiFailure` in `_shared/google/workspace.ts`):

```ts
function googleErrors(context: FailureContext): VendorErrors<{ reasons: string[] }> {
  const has = (facts, ...names) => names.some((name) => facts.reasons.includes(name));
  return {
    provider: context.provider,
    facts: (tokens) => ({ reasons: [...reasonsOf(record(record(tokens).error))] }), // every errors[].reason, details[].reason, status
    detail: ({ status, body }) => message(body) ? `${context.provider}: ${message(body)}` : `${context.provider} returned HTTP ${status}.`,
    classify: [
      ({ status }) => status === 401 ? authRequired : undefined,
      ({ facts }) => has(facts, "accessNotConfigured", "SERVICE_DISABLED") ? apiDisabled : undefined,
      ({ status, facts, retryAfterMs }) =>
        status === 429 || has(facts, "rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED") ? rateLimited(retryAfterMs) : undefined,
      ({ facts }) => has(facts, "insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ? scopeMissing : undefined,
      ({ facts }) => has(facts, "exportSizeLimitExceeded") ? exportTooLarge : undefined,
      ({ facts }) => has(facts, "domainPolicy") ? domainPolicy : undefined,
      ({ facts }) => has(facts, "insufficientFilePermissions", "forbidden") ? itemPermission : undefined,
      // `Send(op, request, { flags: { revisionGuarded: true } })` sets the operation's flag.
      ({ status, facts, operation }) => operation.flags?.revisionGuarded && (status === 400 || status === 409) &&
        has(facts, "FAILED_PRECONDITION", "failedPrecondition", "ABORTED", "aborted") ? revisionConflict : undefined,
      ({ status, facts }) => status === 400 && has(facts, "FAILED_PRECONDITION", "failedPrecondition") ? precondition : undefined,
    ],
    statuses: { 401: auth_required, 403: provider_permission_denied, 404: context.notFound === "absent" ? not_found : ambiguous },
  };
}
// Each verdict carries its words: `apiDisabled = { code: "connector_call_failed", retryable: false, words: (detail) => `${detail} The ${api} is not enabled…` }`.
```

Today's `reasonsOf` reads every reason before it decides, so a 403 whose
ninth reason is `RATE_LIMIT_EXCEEDED` is `rate_limited`. The kit agrees
because rules see complete lists; only the detail line sees the first eight
(`http-kit.test.ts` holds that case). A Google product adds its own rules
ahead of these (Drive's `cannotDownloadAbusiveFile`), reading `facts.reasons`,
so the `googleReasonsOf` side table goes away. `googleOutcomeOf`'s phases
become the ledger.

**Write outcome — decided, final round: the core decides, the kit records
provenance.** INV-9 forbids automatically replaying a dispatched write; it
does not make every vendor answer unknown, and it does not let the kit judge
which answers are refusals. The kit keeps no verdict table:

1. **Provenance is recorded where it is observed.** The transport enters each
   resource request in the core ledger synchronously before `fetch`, with its
   method, any genuine idempotency key it carries, and `auxiliary` for an
   `{ effect: "read" }` request inside a write call. It records the status as
   soon as the resource server answers. The mapping marks a failure that is
   its own request's served answer with that request (`vendorRefusal`, which
   holds only for a refusing status). Nothing else in the kit marks a
   failure.
2. **`api()`'s boundary decides.** It closes the ledger when the handler
   settles and hands the failure to `providerCallFailure` with `finalize`. A
   write is a known failure only by (a), no request but auxiliary ones left,
   or (b), the one request the logical call sent was served a refusal that
   passes `servedRefusal`. Anything else after dispatch is unknown and never
   retryable:
   - a non-refusing answer (including 2xx) followed by an oversized or
     unreadable body, or a 2xx followed by an in-band refusal;
   - a 408, a 5xx or a redirect;
   - a transport failure or the caller's abort;
   - a second write step, or an auxiliary failure after the write.

   A served 4xx refusal stays known regardless of body size: its provenance
   comes from the resource server's status, not from reading the body. A
   mapped `unavailable` or timeout still fails `servedRefusal`. The 401
   exception follows Q8 below, retaining its unknown outcome and handoff
   regardless of body size until renewal succeeds; renewal removes the
   handoff, never the unknown outcome. The shared transport parity table
   proves the oversized-400 and oversized-2xx write outcomes on both paths.

   The core keeps the failure's code as a diagnostic; an `unavailable` that
   is no timeout becomes `connector_call_failed` with the core's
   unknown-outcome words. A direct write whose one request carried a key the
   vendor honors keeps its retry advice. A served write is reconciled by the
   invocation (`uncertainCall`), which also promotes a timeout to
   `write_outcome_unknown`. Advice composes only after this decision, so an
   unknown write never carries it.

3. **Q8 is the core's rule; the kit records its facts.** Say a write request
   was answered 401, preferring an unrenewed one. The call's failure is then
   that 401's vendor verdict, with `writeOutcome: "unknown"`, non-retryable,
   and the words "The write was sent before <vendor> rejected its credential,
   so whether it took effect is unknown". That holds whatever the call met
   afterwards: a renewal, an auxiliary request, or the caller leaving
   (`departedVerdict`). The core keeps an explicit unknown marker in every
   branch, so the auth code, `reconciliationRequired` and the
   `authorize_connector` handoff survive. A renewal that succeeded reports the
   core's `unsentAfterUnauthorized`. With the vendor's `authBeforeExecution`
   evidence, the 401 is its own served refusal and step 2 weighs it like any
   other: known only if it was the one request the call sent. Since the 401
   back-port (#917) this is decided once, by the core's `settleWrite` over
   the whole logical call, and the kit no longer composes it: it records on
   each write request's ledger entry the 401's own vendor verdict and its
   matched proof (`recordUnauthorized`, `ProviderRequest.authBeforeExecution`),
   and a renewal that produced a different token (`ProviderRequest.renewed`).
   The words above are the core's, so the kit's results are unchanged except
   that a blocked resend's words now precede the 401 sentence.
4. **A blocked resend reports the first attempt.** `ResendRefused` maps to
   the first attempt's own answer, with that attempt's provenance, plus "A
   second attempt to send it was stopped before it left". The second attempt
   never left, so step 2 decides as it would for the first attempt alone.

Kit code calls `unsentAfterUnauthorized` and `providerFailureMessage` for
steps 3 and 4, and reaches `providerCallFailure` only through `api()`.
Neither `classifyWriteOutcome` nor `servedRefusal` is called by kit code, and
no kit file restates either. `test/kit-core-verdicts.test.ts` is the guard
against drift: a kit that disagreed with the core on any case would fail its
row.

`authBeforeExecution` is a **trusted, per-vendor review obligation**. It
requires non-empty evidence text and a narrow predicate over the raw status,
token facts and reviewed headers, never a mapped code or prose. Construction
rejects missing evidence or a missing predicate. The reviewer of each vendor
declaration must verify the claim and the predicate against vendor
documentation. A broad predicate, or a link with no supporting guarantee, is
not proof. The predicate is trusted code: types cannot verify vendor
semantics. It only narrows Q8; no declaration can make any other answer a
refusal.

Idempotency keys never allow an automatic resend or erase an ambiguous
outcome; they supply reconciliation facts and, for a direct caller whose key
protects the whole call, repeatability.

A write is reported unknown even when the vendor answered it with a 2xx and
the call then failed (rule 6 of rounds 4–5; the core does the same). The
alternative, accounting it as `ok`, was rejected:

- The call failed, so the agent has no result to compare the target against.
- A 2xx is one request's status, not the tool's success. A later step, or the
  provider's own check of the reply, can still find the write incomplete, and
  the kit cannot tell those apart.
- Counted `ok`, a caught failure would drop out of a program's
  `writes.unknown` and lose its reconciliation facts.
- There is no wire code for "the write succeeded and the tool failed". A
  connector-raised one belongs to the contract phase.

Unknown never invites a repeat, so reconciling it is one read.

_Superseded (rounds 4–5): write outcome over the entire call ledger._ The
rules below composed the core's single-write verdict over the kit's own
ledger. The final round replaces them: the core's ledger and logical-call
rule now do the whole-call composition, so the kit keeps only Q8 and the
resend words. Specifically, rule 1's "proven no connection", rule 4's
reliance on `REFUSALS`, rule 5's `nonExecution` proof and its example are
gone; the merged core keeps `rate_limited` as the diagnostic code of a write
answered 503 rather than `connector_call_failed`. Rule 6's wording ("had
already accepted this call's write") is replaced by the core's. Rule 4's
claim that `classifyWriteOutcome` accounts Tithe.ly's answered 404/409 as
unknown is also wrong under the merged core: both pass `servedRefusal`, so
`providerCallFailure` marks them known failures and the classifier reports
`failed` (`test/kit-core-verdicts.test.ts`). The text is kept for the
reasoning:

**Write outcome over the entire call ledger — decided, rounds 4–5.** The kit
calls the core's `providerCallFailure` and `classifyWriteOutcome` in
`src/write-outcome.ts`, including #902's explicit unknown-outcome precedence.
It never reimplements their failure decision or refusal set. Until #902
merges, `core-write-outcome.ts` vendors that identical contract behind one
adapter; then the adapter switches to the core module's exports.
INV-9 forbids automatically replaying a dispatched write; it does not make
every vendor answer unknown. This orchestrator ruling supersedes the
“everything after dispatch is unknown” rule from rounds 2–3.

For each write reservation, first distinguish no dispatch (`reserved` or
`preparing`), proven no connection (`unconnected`), a definite refusal, and
an execution that may have happened. Then decide over **all** write entries,
never just the last failed or retried step:

1. **Nothing may have executed.** No write left, or every dispatched write is
   proven non-executed. Keep the failure's own code, message and retry advice.
   Permanent reservations still prohibit another dispatch within this call.
2. **A write answered raw HTTP 401 (Q8).** Read its own recorded status,
   headers/operation and available parsed body, never an auxiliary failure's
   facts. Keep `auth_required` / `downstream_oauth_required`,
   `authorize_connector` and `reconciliationRequired`, add
   `writeOutcome: "unknown"`, remove retryability and wait. This survives
   body failures, renewal failures, auxiliary failures and cancellation.
   Only a successful renewal drops the handoff (use #902's renewed-but-unsent
   `connector_call_failed` words, still unknown). An unrenewed 401 takes
   precedence over a renewed one. Exception: reviewed `authBeforeExecution`
   evidence and a matching narrow raw-fact predicate prove this step refused
   before execution; then its refusal stands **only if no other write may
   have executed**. A `nonExecution` rule cannot bypass this 401 exception.
3. **A second dispatch was blocked (`ResendRefused`).** Start from that slot's
   own original answer/failure, but inspect every other slot before returning.
   A retryable proven lock refusal for `bytes` cannot erase an accepted
   `session` write; the whole call is unknown, non-retryable, without a wait.
   The same applies when the blocked slot never dispatched or connected.
4. **The write's OWN vendor failure.** Map vendor facts into the ordinary
   error, then call the core's `providerCallFailure` with the served verdict
   and transport's dispatch/response/status facts. Return its exact error
   fields; do not add `writeOutcome` or alter timeout retryability locally.
   Definite refusals preserve the core's code and retry advice, including
   429's wait. Tithe.ly's answered 404/409 preserve `connector_call_failed`,
   non-retryability and **no extra `writeOutcome`**, just as #902 does.
   `classifyWriteOutcome` still accounts those non-refusal errors as unknown:
   an HTTP response is not an MCP tool's `isError`, so it does not set the
   classifier's `answered` flag. Raw 401 uses rule 2. The call's verdict
   must also account for every other write step (rule 6).
5. **Ambiguous single-write failures.** The shared helper decides these,
   including raw 5xx mapped by vendor facts, network loss, redirects and
   body failures. The kit never copies a second verdict table. For example,
   raw 503 mapped to `rate_limited` becomes the core's non-retryable
   `connector_call_failed` with explicit unknown outcome. A timeout carries
   exactly #902's error fields: the invocation classifies it unknown, without
   the kit adding `writeOutcome` or replacing its diagnostics. Reviewed
   `nonExecution` evidence with a narrow predicate over raw facts can prove
   a step did not execute; a synthetic status cannot replace the transport's
   raw status. Any other step that may have run still triggers rule 6.
6. **Another step may have executed.** Every verdict path, including refusal
   exceptions, a blocked retry, `departedVerdict`, auxiliary failures and
   provider checks, must retain whole-call uncertainty. Preserve an auth
   code for its handoff; otherwise use `connector_call_failed`, always
   unknown and non-retryable with no wait. The message states any known 2xx
   acceptance or that the write was sent. Several proven refusals alone do
   not create uncertainty; one accepted or ambiguous write does.

`nonExecution` and `authBeforeExecution` are **trusted, per-vendor review
obligations**. Each declaration requires non-empty evidence text and a narrow
predicate over raw status + token facts + reviewed headers, never mapped code
or prose. Construction rejects missing evidence or predicates. The reviewer
of this record and each vendor declaration must verify each claim and
predicate against vendor documentation; Stripe's linked lock-timeout
non-processing guarantee is the model, checked for this prototype. A broad
predicate or a link with no supporting guarantee is not proof. These
predicates are trusted code: types cannot verify vendor semantics.

Timeouts keep exactly the core helper's fields and retryability; invocation
owns their unknown-outcome classification and any promotion to
`write_outcome_unknown`. Idempotency keys never allow an
automatic resend or erase ambiguous outcome; they supply reconciliation
facts. #902 reads `writeOutcome` before refusal codes in direct calls and
caught/uncaught program accounting.

Rule 6's reasoning for reporting a 2xx-then-failed write unknown now stands
above, under the final round's decision.

The goldens show invocation already marks an entered write's `auth_required`
`reconciliationRequired`, while `classifyWriteOutcome` on `main` counts it as
a refusal. #902 adds the explicit outcome, and rule 2 uses it, so the code,
the accounting and the wording agree and the handoff survives. The kit delegates the base verdict to the core contract through the single
adapter. Q8 and whole-call ledger composition use the same explicit outcome
field; #902's constructor owns it once merged.

### B.4 The kit

**Vendor (`src/providers/<name>/api.ts`).** A provider declares operations
with constructors that `vendor.ts` re-exports, so it never names an unstable
module.

```ts
export const get, post, put, patch, del;  // HttpApiEndpoint constructors, re-exported
export function vendor(name: string, ...operations: [Operation, ...Operation[]]): Vendor;
export function connect<R>(vendor: Vendor, guarded: GuardedClient<R>, options: {
  readonly errors: VendorErrors;
  readonly safety: ResultSafety;                             // required: the value-safety boundary
  readonly result?: (body, answer: { status; headers; operation; withheld }) => Effect.Effect<unknown, HttpFailure>; // unwrap or in-band refusal
}): Connection<R>;                                           // { provider, errors, safety, send, sendPath }
type Send<R> = <Op extends Operation>(operation: Op, request: RequestOf<Op>, options?: {
  readonly effect?: "read";                                  // an auxiliary lookup inside a write tool; never inferred
  readonly step?: string;                                    // a construction-declared step (B.2), default write
  readonly item?: string;                                    // bound to its snapshotted request, never a free alias
  readonly flags?: Readonly<Record<string, true>>;           // facts the vendor's rules read, such as revisionGuarded
}) => Effect.Effect<Answer, HttpFailure, R>;                 // Answer = { status, data }: settled and safe
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec; // the vendor contract drift checks compare
export function operations(vendor: Vendor): string[];          // manifest's operations as "METHOD /path", sorted: ProviderKitFacts.operations
```

- Schemas use the stable `effect` `Schema`. Query struct field order is wire
  order. Optional fields use `Schema.optionalKey`.
- **Integers use the kit's `Integer`**: any finite whole number, rendered
  `type: integer`, which is what catalogs and `api()`'s validator have always
  meant. `Schema.Int` decodes only safe integers and renders that bound;
  `Schema.Number` renders `anyOf` number or `"Infinity"`/`"-Infinity"`/`"NaN"`.
  Neither appears in a kit declaration.
- **String lengths count code points**, as JSON Schema does and as `api()`'s
  validator (`@cfworker/json-schema`'s `ucs2length`) does today: an astral
  character is one, a combining mark is one, and a lone surrogate is one.
  That validator is the contract agents already meet, so the kit matches it.
  Effect's `isMinLength` and `isMaxLength` count UTF-16 units and render an
  approximation (`"😀".repeat(300)` is 300 to the catalog and 600 to the
  decoder), so kit declarations use the kit's `isMinChars` and `isMaxChars`,
  which count code points with the validator's loop and render `minLength`
  and `maxLength` exactly. `isMinLength(1)` is exact either way and stays.
- A success Schema describes the vendor's envelope leniently, for the manifest
  only.
- The client runs in `response-only` mode. HttpApiClient's own decoding reads
  the whole body with no ceiling (`response.arrayBuffer`), turns an empty 200
  into `null`, which the success Schema then rejects, and its `SchemaError`
  can quote the value.
- There is no `HttpApiSecurity`, because it is server middleware.
  Authentication is `GuardedOptions.authenticate`.
- Each vendor declares its documented error envelope once, for the manifest.
  Status meaning stays in code (B.3).

**The value-safety boundary (`src/http/safety.ts`).** Every answer, from a
declared operation or a hatch's path, takes one route inside `connect`, and a
provider cannot reach a body any earlier:

1. confinement, `admit`, then authentication, before anything is sent;
2. the bounded read;
3. JSON parse, then the request's whole sent-secret set (`RequestSecrets`)
   redacts the parsed body before anything can cut, trim or extract from it
   (#911's `redactBeforeCut`), on a failure's body and a success's alike;
4. a non-2xx becomes `StatusFailure` with its operation, and B.3 asks
   `withholdsErrors(operation)` before it builds any detail; a 2xx that did
   not parse is `UnreadableBody`;
5. the vendor's `result` hook: unwrap an envelope, or fail an in-band refusal.
   It receives `withheld`; a vendor whose review withholds any operation's
   text raises its in-band refusals as `StatusFailure`, so the same check
   applies (Cloudflare does), and only a vendor that withholds nothing, such
   as Tithe.ly, may quote its own reason in a `Refusal`;
6. `ResultSafety.redact(data, operation)`: the vendor's reviewed redaction
   (the REST family's `ValueSafety`, by operation), then A.2's
   `sensitiveFields` drop at any depth unless deployment code chose
   `"return"`;
7. only then the provider: paging strategies, projections, `raw` results and
   hatch replies all read the redacted, privacy-projected `data`, so no value
   reaches a cursor or a result before redaction.

Page facts a vendor keeps outside its data (Cloudflare's `result_info`,
Vercel's `pagination`) are read by the `result` hook from the envelope it
unwraps; the data itself is redacted before any strategy reads it.
`resultSafety` refuses at construction a connection with neither a reviewed
table nor a written reason for having none (INV-11), and a `sensitiveFields`
value other than `"drop"` or `"return"`. Sent-secret registration stays as a
separate layer, because a stored downstream secret may never have been sent.

**Tool builders (`src/http/tools.ts`).** Each builder returns an ordinary
`ApiTool`. Kit tools therefore sit in `api()` beside hand-written ones and keep
its validation, redaction and withheld handler text.

```ts
type Input = Schema.Top & { readonly DecodingServices: never };
interface ToolSpec<I extends Input, O extends Schema.Top> {
  readonly name: string;
  readonly description: string;
  readonly input: I;   // -> inputSchema, closed
  readonly output: O;  // -> outputSchema; `run` is typed by it
  readonly writeSteps?: Readonly<Record<string, "once" | {
    readonly maxItems: number;
    readonly items: (args: I["Type"]) => readonly string[]; // pure bounded selector, once before run
    readonly request: (item: string, args: I["Type"]) => WriteRequest; // kit derives and snapshots the request for each item
  }>>;
  readonly run: (args: I["Type"]) => Effect.Effect<O["Type"], HttpFailure, CallServices>;
}
function list<I extends Input, Row extends Schema.Top>(connection: Connection, spec: Omit<ToolSpec<I, never>, "output" | "run"> & {
  readonly key: string; readonly row: Row; readonly cursor?: "plain" | "bound";
  readonly page: (args: I["Type"], cursor: string | undefined) => Effect.Effect<Page<Row["Type"]>, HttpFailure, CallServices>;
}): ApiTool;                                                                    // output { [key]: Row[], page }
function get<I extends Input, O extends Schema.Top>(connection: Connection, spec: ToolSpec<I, O>): ApiTool;
function read<I extends Input, O extends Schema.Top>(connection: Connection, spec: ToolSpec<I, O> & { readonly review?: string }): ApiTool;
function write<I extends Input, O extends Schema.Top>(connection: Connection, spec: ToolSpec<I, O> & {
  readonly destructive: boolean;
  readonly idempotency?: { readonly header: string; readonly key: (args: I["Type"]) => string | undefined };
}): ApiTool;
function action<I extends Input, O extends Schema.Top>(connection: Connection, spec: ToolSpec<I, O>): ApiTool;
```

`read` and `write`, with `write`'s `idempotency`, are prototyped; `list`,
`get`, `action` and the `review` check arrive in B.4.

The upload builder and byte-body request shape are deferred to C.7 (Google Drive), the first upload migration; B.4 retains separate `session` and `bytes` write steps.

`idempotency` declares a genuine key the vendor honors, taken from validated
arguments (an `idempotencyKey` argument, say). One key protects one request,
so a tool with more than one write step cannot declare it (a construction
error). A blank key, or one an HTTP header cannot carry, is refused before
anything leaves. The key is recorded for reconciliation (`Recovery`) before
dispatch. It is sent as a visible header after sent-secret registration, on
the tool's own requests only, and entered on the core ledger request that
carried it. Only that recorded key makes a direct write repeatable
(`keyProtectsLogicalCall`); a served write is still reconciled, never
retried.

| Builder                       | Catalog verdict | Annotations                                                                                      |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `list`, `get`, `read`         | read            | `readOnlyHint: true`                                                                             |
| `write({destructive: false})` | write           | `readOnlyHint: false`                                                                            |
| `write({destructive: true})`  | destructive     | `readOnlyHint: false, destructiveHint: true`                                                     |
| `action`                      | destructive     | `readOnlyHint: false, destructiveHint: true, idempotentHint: false`, for money, mail and refunds |

- **The builder annotates; the call decides.** The builder's verdict is what
  the catalog advertises and what a probe (a call no invocation dispatched)
  runs under. At run time the call's `Classification` is the registry's served
  verdict, and refresh-once, the ledger and the write-outcome rule read it.
  The prototype's suites prove a read served as a write is never replayed and
  reports an unknown outcome, and a write served as a read keeps a retryable
  verdict.
- **A `read` that sends anything other than GET or HEAD must carry `review`**,
  the REST kit's `readPosts` rule made universal. `Send` fails closed with a
  defect when a read-built tool sends another method without one.
- **A request inside a write call counts as the write** unless the provider
  marks it `{ effect: "read" }`. The method never decides.
- **The builder closes its lease** when the run ends (`Effect.ensuring`). When
  the caller left after the vendor answered a write with 401, it rejects with
  that answer's verdict (B.3's Q8 step: the auth code, never retryable,
  `writeOutcome: "unknown"`) rather than the bare abort reason; any other
  cancellation keeps the reason, which invocation reports as it does today,
  an unknown outcome.
- **Both catalog schemas come from Schemas.** `catalogSchema(schema, mode)`
  renders connecta's dialect:
  - drop the default `additionalProperties: true`;
  - close inputs, and always give the root a `required` list;
  - an array's own keywords before `items`, as hand-written catalogs spell it;
  - merge a primitive `anyOf` into a `type` array, but only when each branch's
    keywords apply to its own type alone;
  - drop nothing the decoder enforces.

  A property description on `Schema.Unknown` goes through
  `Schema.annotateKey`; Effect drops a value annotation there.

- **An input check the catalog cannot state is refused at construction.** The
  builder walks the input Schema's AST, including `Suspend.thunk()` with an
  identity recursion guard. It explicitly allows only the reviewed JSON forms
  (String, Number, Boolean, Null, Unknown, Never, Literal, Objects, Arrays,
  Union, Suspend); every other form and encoding transformation fails
  construction. New Effect AST forms therefore fail closed. Object index
  parameters and values are traversed too. Every check with no JSON Schema
  rendering, or one Effect marks approximate, is refused: a UTF-16 string length,
  a RegExp whose flags differ. An array's `isMaxLength` renders `maxItems`
  exactly and stays.

- **Catalog and decoder accept the same values.** `api()` validates arguments
  against the rendered schema first, so agents read the same `invalid_args`;
  the builder then decodes with the Schema, and a decode failure is a defect
  whose text `api()` withholds. An agreement check runs every kit tool's
  input properties through boundary values under both and requires the same
  accept/reject:
  - numbers: 0, ±1, 1.5, 99, 100, 2^53, −2^53, 1e21;
  - ASCII strings: empty, one space, one character, 512 and 513 characters;
  - astral characters: one emoji, 256, 512 and 513 of them, `"/"` and 300 of
    them, and 511 characters plus one emoji;
  - combining marks: `"e\u0301"` once, 256 and 257 times;
  - lone surrogates: a high one, a low one, a reversed pair, 512 and 513
    high ones, and 511 characters plus a dangling high surrogate;
  - wrong types and over-long arrays.

  A second check runs a tool with `isMinChars(2)` and `isMaxChars(3)`, since
  the shipped tools bound no string below by more than one. The Tithe.ly suite
  keeps the cases that found each drift: `list_charges({ accountId: "u",
  createdAfter: 9007199254740992 })` succeeds today and on the kit, and so
  does a `tithely_api_mutate` path of `"/"` and 300 emoji.

- **`run` is typed by `output`.** A projection that returns untouched rows does
  not compile. The prototype keeps one cast for Tithe.ly's `raw` flag; B.5
  preserves the schema bytes until step 2 (Q3).

**Paging (`src/http/paging.ts`).** One strategy set, all producing
`Page<Row> = {rows, page: {hasMore, nextCursor}}`, all reading redacted data:

| Strategy                 | How the next page is found                               | Today in                           |
| ------------------------ | -------------------------------------------------------- | ---------------------------------- |
| `lookahead` (prototyped) | ask for `limit + 1` rows; the cursor is the last kept id | Tithe.ly                           |
| `token`                  | the vendor's `has_more` and next token                   | Stripe, Notion, Cloudflare, Vercel |
| `offset`                 | rows already returned                                    | Breeze, Planning Center            |
| `page`                   | page numbers from body or headers                        | GitHub, CCB, Overflow              |
| `link`                   | the cursor parameter of a confined `next` URL            | Stripe v2, Vercel                  |

- `allRows(fetchPage)` is the `Stream` that programs and the hatch walk.
- **One cursor codec, two modes.** `plain` hands the vendor's cursor through,
  and every migrated list keeps it (Q5). `bound` is base64url of `{v, d, c}`,
  where `d` is 128 bits of SHA-256 over the tool name and its arguments,
  cursor and limit excluded; a cursor from another call is `invalid_args`.
  When Drive, Gmail, Sheets, Forms and Slides migrate, `bound` replaces their
  private codecs only if it reproduces their cursor bytes; otherwise each
  keeps its codec until the contract phase.

**Hatch (`src/http/hatch.ts`).** The hatch is `restTools` on the kit
transport, with an explicit verdict per operation in place of "GET means read,
plus `readPosts`". It sends through `Connection.sendPath`, the same route and
boundary as `send` (prototyped by `tithely_api_mutate`).

```ts
function hatch(options: {
  readonly name: string;                    // tool prefix: <name>_api_search, _details, _read, _write
  readonly index: OperationIndex;           // _shared/rest/operation-index.ts, unchanged
  readonly verdicts: Readonly<Record<`${RestMethod} ${string}`, "read" | "write" | "destructive" | "refuse">>;
  readonly connection: Connection;          // its ResultSafety wraps the REST ValueSafety by operation
}): ApiTool[];
```

An operation with no verdict is refused, so Breeze's GET writes need one. The
hatch retires the `_api_get`/`_api_mutate` pairs in each provider's **step 2**
under 0011. B.5 must retain Tithe.ly's existing hatch names and all surface
bytes; kit primitives never authorize a step-1 rename.

**Provider (`src/http/provider.ts`).** The builder is built on `defineProvider`,
not `asProviderFactory`. `defineProvider` already validates `purpose`, the
common options and the title, and renders the guide through
`ProviderContext.usageGuide`.

```ts
function defineApiProvider<O extends ProviderOptions>(definition: Omit<ProviderDefinition<O>, "kind" | "create"> & {
  readonly vendor: Vendor;
  readonly baseUrl: (options: Readonly<O>) => string;                 // environment or override; checked at construction
  readonly maxResponseBytes: number;
  readonly headers?: GuardedOptions["headers"];                      // constants first; auth applied last, shadowing refused
  readonly admit?: GuardedOptions["admit"];                          // before any credential read, as in B.2
  readonly pageSize?: { readonly default: number; readonly max: number }; // becomes the `defaultPageSize` option and its check
  readonly credential?: ConnectorCredentialConfig;                    // exclusive with oauth
  readonly oauth?: (options: Readonly<O>) => ApiOAuthConfig;
  readonly authenticate: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, CallServices | Grant>;
  readonly errors: VendorErrors;
  readonly safety: (options: Readonly<O>) => SafetyOptions;           // reviewed table or reason, and the sensitiveFields option
  readonly result?: ConnectOptions["result"];
  readonly probe: { readonly operation: Operation; readonly request: unknown; readonly describe: (reply: unknown) => string };
  readonly guide: (options: Readonly<O>) => ProviderGuideInput;
  readonly hatch?: Omit<Parameters<typeof hatch>[0], "connection">;  // name, index, verdicts; the kit builds the hatch tools
  readonly tools: (kit: { connection: Connection; pageSize: number; options: Readonly<O> }) => ApiTool[];
}): ProviderFactory<O>; // kit: ProviderKitFacts set on the definition; the connector declares tracksEveryRequest
```

The probe becomes `testCredential(s)`. It runs `authenticate` against the
candidate values, sends one operation, and maps a failure through the vendor
table. It copies no context.

`defineApiProvider` wraps its `api()` connector in `tracksEveryRequest`:
every kit request enters the core ledger, so an empty ledger proves a write
never left (provenance (a)). It also sets the definition's `kit`, decision
0011's `ProviderKitFacts` seam (S.1), under exactly that seam's names:

- `operations`: `operations(vendor)`, every operation of `manifest(vendor)`
  as `"METHOD /path"`, sorted. `providers:generate` writes it into
  `drift.json` v2's `generated.operations`, and `providers:check` keys each
  `endpoints` entry by one of them;
- `pageSize`: the declaration above, `{ default, max }`, which the generated
  `## Conventions` states for every paged read;
- `hatch`: `{ name, verdicts }` from the hatch declaration, from which the
  Conventions name the hatch tools and the operations refused by design.

The B.4 Tithe.ly reference declares `TITHELY_KIT_FACTS` the same way:
all ten named operation variants derived from its vendor, page size 25
of at most 99, and no `hatch`, because step 1 keeps `tithely_api_get` and
`tithely_api_mutate` and the standard hatch arrives with step 2. Its suite
checks all eleven tools' catalog and request/result bytes, and the page size against the catalog's `limit`. `manifest(vendor)`
keeps the method, path and parameter names for the drift checks; the
operation set comes from code, never a hand-typed list.

`src/provider.ts` stays Effect-free, as `purity.node.test.ts` requires.

### How the kit keeps the invariants

| INV | Mechanism                                                                                                                                                                                                                                                                                                                           | Evidence: existing, then new                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The builder annotates the class; the served classification decides at run time; byte-identical catalog; catalog and decoder agree, string lengths in code points; inexact input checks refused                                                                                                                                      | `rest-connector.test.ts` "INV-1: names four tools…"; `kit-prototype.test.ts` "INV-1" (catalog, served classification); `http-kit.test.ts` "INV-1" (boundary agreement beyond ASCII, code points, refusal, served classification); A.3 `catalog.json`                                                                                                       |
| 2   | Kit tools are `ApiTool`s; registry enforcement unchanged                                                                                                                                                                                                                                                                            | `connector-read-only.test.ts` "INV-2: defaults writable…"                                                                                                                                                                                                                                                                                                  |
| 3   | Confinement and `admit` run before credentials; agents name no base or credential                                                                                                                                                                                                                                                   | `guarded-fetch.test.ts` confinement suite; `http-kit.test.ts` "INV-3: confines…" and "INV-3 INV-5: admits…"                                                                                                                                                                                                                                                |
| 4   | `Caller` comes from the admitted scope on every operation; `Classification` from the served definition                                                                                                                                                                                                                              | `mcp-core.test.ts` "INV-4: binds SDK envelope…"; `http-kit.test.ts` "INV-4 INV-10: discovery, status, and startAuth views…"; B.1's registry tests                                                                                                                                                                                                          |
| 5   | Credentials only through services; every sent value registered; a body redacted with the request's whole set before any cut; one value-safety boundary; withheld text decided before any detail                                                                                                                                     | `sent-secrets.test.ts` "INV-5: api OAuth registers both tokens…"; `http-kit.test.ts` "INV-5" (boundary, hatch, withheld); `kit-prototype.test.ts` "INV-5" (sensitive fields, a reply quoting the credential)                                                                                                                                               |
| 6   | Bounded bytes, token-only facts, rules typed without prose and run before any wording, allowlisted headers, `TextDecoder`, errno-only transport facts, withheld handler and decode text                                                                                                                                             | `guarded-fetch.test.ts` "INV-6: decodes bounded bytes…"; `http-kit.test.ts` "INV-6" (token facts, rule order, compile-fail fixture, complete lists); Stripe `kit-prototype.test.ts` "INV-6"                                                                                                                                                                |
| 7   | Explicit call finalizers and closed-state checks; request-owned resources close with the request, revocation first and every step run; `fetch` gets the call signal                                                                                                                                                                 | `call-admission.test.ts` "INV-7: stops a retained connector context…"; `http-kit.test.ts` "INV-7" (retained service, pending read, retained view, request-owned session, throwing finalizers); `kit-prototype.test.ts` "INV-7"                                                                                                                             |
| 8   | Catalogs are static; no change                                                                                                                                                                                                                                                                                                      | `catalog-cache.test.ts` "INV-8: a missing SQL chunk forces a complete live refresh"                                                                                                                                                                                                                                                                        |
| 9   | One dispatch per logical write below every resend path; fixed capacity and permanent atomic reservations; every request entered in the core ledger before `fetch` and its own answer marked with its provenance; the core decides the write over the logical call; a write answered 401 keeps its code with an unknown outcome (Q8) | `rest-connector.test.ts` "INV-9: dispatches a write once…"; `write-provenance.test.ts`; `kit-core-verdicts.test.ts` "INV-9" (the kit and the core over one case table); `http-kit.test.ts` "INV-9" (ledger, guard triggers, provenance, auxiliary failures, renewals, cancellation, idempotency key); `kit-prototype.test.ts` "INV-9"; A.3 `failures.json` |
| 10  | Renewal only inside a call; probes and operation views never start authorization                                                                                                                                                                                                                                                    | `api-oauth.test.ts` "INV-10: reports auth_required from status…"                                                                                                                                                                                                                                                                                           |
| 11  | Base URL, ceiling, page size, value-safety review and options checked at construction                                                                                                                                                                                                                                               | `provider-definition.test.ts` "INV-11: rejects invalid common options before create runs"; `http-kit.test.ts` "INV-11"                                                                                                                                                                                                                                     |
| 12  | `src/http/` is unreachable from the root; area modules confined to three files; stable members only elsewhere                                                                                                                                                                                                                       | `purity.node.test.ts` "keeps the provider kit out of the root graph" and "confines Effect's unstable area modules…"; `kit-stability.node.test.ts`                                                                                                                                                                                                          |
| 13  | Factories return `Connector`; kit types are internal; the build does not emit the prototype                                                                                                                                                                                                                                         | `package-surface.node.test.ts` "INV-13: publishes no Effect type in any reachable declaration"; `check:declarations`                                                                                                                                                                                                                                       |

### Migration order

Each step is one PR. Each must pass `pnpm run check` and match the goldens.

- **B.1.** Adds `src/runtime/call.ts` with both layers, the registry's
  operation entries, invocation's provision and finalizer, `api()`'s Effect
  entry and shared core, `contextView`, and the one table behind the existing
  readers. It includes the tests above. Agent-facing output is unchanged.
- **B.2.**
  - Moves `client.ts` and `oauth.ts` out of prototype status, with the ledger
    and its entry in the core ledger before every `fetch`.
  - Adds the shared pure module and the two-transport parity suite (Q6).
  - Owns transport attempts: one attempt per send, with no hidden 421,
    HTTP/2 refused-stream or dispatcher resend, or the send is refused. A
    transport rejection still proves nothing about a write unless a separate
    decision with the core says so.
  - Builds `Grant` over `static-oauth.ts`: `token`, `refresh`, and `rejected`
    with its latch. Aligns `src/auth/static-oauth.ts` with the kit's resource
    auth verdict and handoff until renewal succeeds; the parity matrix and
    direct/program accounting checks above are required, planned B.2 work.
    `ctx.oauth.fetch` shares the decision.
- **B.3.** Adds `errors.ts` for vendor facts, wording, provenance and the Q8
  handoff. The write's outcome stays the core's: `api()`'s boundary decides it
  with `providerCallFailure` over the core ledger, and neither that function,
  `servedRefusal` nor `classifyWriteOutcome` moves into the kit or gains a
  copy. Vendor mappers become facts, an allowlist and rules, with parity
  suites like Stripe's. The case table (`kit-core-verdicts.test.ts`) grows
  with each mapper. _Superseded (round 5):_ a temporary pre-merge adapter
  vendored #902's functions until it landed; the final round deleted it.
- **B.4.** Adds `safety.ts`, `vendor.ts`, `tools.ts` with all five builders,
  `paging.ts` with all five strategies, `json-schema.ts` with `Integer` and
  the agreement check, `hatch.ts`, `provider.ts`, and the stability guard
  over every kit and provider declaration file. Each comes with a unit suite
  like `http-kit.test.ts`.
- **B.5, the gate (Q1).** Moves `src/providers/tithely/` onto the kit
  completely: every tool, the writes, the credential and 401 paths, every
  failure path and the hatch.
  - **B.5 is Tithe.ly's STEP 1 under 0011.** `catalog.json`, `calls.json` AND
    `failures.json` must be byte-identical. Safety and write-outcome changes
    are back-ported into today's providers first; routine kit differences
    are not exceptions. Hatch renames, the catalog's `raw` union and every
    other surface change belong to Tithe.ly's separate step 2, never B.5.
  - **Prerequisite sequence, decided by the orchestrator (round 5):** merge
    #902, switch the kit adapter to its shared core helpers, then land one
    separate write-401 back-port and regenerate goldens. All three are
    done: #902 merged, the final round deleted the adapter, and the 401
    back-port landed as #917. It keeps the
    auth code and handoff on the 401 and 401-echo rows, adds
    `writeOutcome: "unknown"`, and stays non-retryable. The final round's
    golden comparison showed those two rows were the only difference. The
    kit delegates every other verdict to the core: **do not back-port
    divergent kit wording or fields**. B.5 migrates against the regenerated
    bytes. No back-port or goldens regeneration is part of this design PR.
  - It reports, against today's provider: code lines, cyclomatic complexity
    per tool, the provider entry's gzip size, and catalog render time apart
    from per-call decode time (Q4).
  - `kit-prototype.ts` and its suite are deleted, and `tsconfig.build.json`
    stops excluding `src/http`.
  - Phase C starts only after B.5 merges. If B.5 shows that HttpApiClient adds
    cost without benefit (its bytes buy no typed request or manifest a
    hand-rolled encoder would not give, or an effect upgrade breaks it), the
    fallback is fixed now: keep the kit, drop `HttpApiClient`, and encode
    path, query and payload from the same Schemas in about 150 lines behind
    the same `connect`/`Send` signature over the guarded client, with
    `manifest` built from those declarations.

### Measured (round 2, c01183cf)

Builds use esbuild with `scripts/bundle-size.mjs` settings (neutral platform,
minified, gzip -9) on this branch. Deltas are over `src/index.ts`, which every
deployment imports.

| Bundle                                    | gzip bytes                    |
| ----------------------------------------- | ----------------------------- |
| root                                      | 380,179                       |
| root + today's Tithe.ly (12 tools)        | 389,655 (+9,476)              |
| root + kit modules, no provider           | 500,080 (+119,901)            |
| root + kit + Tithe.ly prototype (3 tools) | 504,246 (+4,166 over the kit) |
| `./providers/tithely` today, standalone   | 36,172                        |
| Tithe.ly prototype entry, standalone      | 162,270                       |

Each piece, added alone to the root, measured on `81cdffbc` before this
round's changes:

| Piece                          | gzip bytes |
| ------------------------------ | ---------- |
| `Schema` with JSON Schema      | +65,943    |
| `Schema` and `Stream` (paging) | +90,255    |
| `effect/http` client           | +31,156    |
| `effect/http-api` vendor       | +49,012    |

They share `Schema` and `Stream`, so the set costs about 120 KB, not their
sum. `examples/worker` imports no provider, so no capped entry moves. Bundle
cost is paid once per deployment and does not decide Q1.

**Lines.** The previous round counted the code `get_charge` and `list_charges`
need with the TypeScript scanner: 452 today, 381 on the kit (−16%), and
316 → 245 (−22%) without the 136 lines identical in both. Counting
non-blank, non-comment lines, `src/http/` grew from 729 to 1,209 over the
first review (the ledger, facts and bounds in `errors.ts`, the settle route in
`vendor.ts` and `safety.ts`, and B.1's lease, view and request-scope
prototype in `services.ts`, which B.1 moves to `src/runtime/call.ts`), and to
1,435 over the second: the one-dispatch guard, the write-outcome rules over
the ledger, the verdict and wording split, code-point lengths with the
construction check, and request cleanup that runs every step.
`guarded-fetch.ts` is 349 by the same count. B.5 replaces all of these with
whole-provider numbers.

### Decisions on the open questions

The previous draft asked eight questions. The orchestrator decided them:

1. **Effect-native with HttpApi.** The owner chose "everything in Effect";
   bundle cost is paid once per deployment and does not decide this. The gate
   is concrete: B.5 migrates Tithe.ly completely onto the kit, matching its
   goldens, and reports lines, complexity and bundle against today. Phase C
   starts only after that. The fallback if HttpApiClient adds cost without
   benefit is fixed in the migration order above.
2. **Defer the wire-code change.** Promoting ambiguous writes to
   `write_outcome_unknown` waits for the contract phase and its evals, which
   then promote every dispatched write whose `classifyWriteOutcome` is
   `unknown`. The kit delegates every write verdict, retryability and
   explicit field to the core: since the final round, `api()`'s boundary
   decides over the core ledger the kit records into, whole-call uncertainty
   included. It never adds a second timeout/404/409 contract. The handoff is
   not deferred: a write answered 401 keeps its auth code and
   `authorize_connector` handoff and carries #902's explicit
   `writeOutcome: "unknown"`, which `classifyWriteOutcome` reads before any
   provenance, so direct calls and caught and uncaught programs all report it
   as unknown, with reconciliation facts, and never as retryable.
3. **Tithe.ly's `raw` flag.** Keep A.2's deployment-controlled
   `sensitiveFields` and filter both branches. B.5 preserves the existing
   catalog bytes, including its output schema; the prototype's transitional
   cast remains until step 2 removes `raw` and declares the standard surface
   under 0011. No catalog union change is permitted in B.5.
4. **JSON Schema at runtime for now.** Rendering runs once per connector at
   construction. B.5 measures render cost and per-call decode cost
   separately; rendering moves to `providers:generate` only if a deployed
   shape's cap binds.
5. **Preserve current cursors during migration.** Migrated lists keep `plain`.
   `bound` is for codecs that are already bound; defaulting to it waits for
   the contract phase.
6. **Two transports with shared pure helpers and parity tests** (B.2).
7. **Extend the stability guard.** `kit-stability.node.test.ts` resolves every
   member of every `effect` module the kit and any provider declaration file
   reach (namespace imports, named imports, aliases such as `Schema as S`,
   member access in values and types), reads its `@stability` tag (on the
   export specifier for a renamed export), and fails on anything not stable
   outside the confined HTTP modules. Re-exporting the unstable HTTP APIs
   confines them to three files; it does not stabilize them.
8. **A write answered 401 is an unknown outcome by default, and keeps its
   auth code.** The owner and orchestrator ruled this for #902 and the kit
   alike. A refusal needs vendor-declared evidence that the vendor
   authenticates before it executes (`authBeforeExecution.evidence`,
   reviewed per vendor). Otherwise the error keeps the vendor's 401 code
   (`auth_required`, or `downstream_oauth_required` for an OAuth connector)
   so invocation keeps the structured `authorize_connector` handoff and
   `reconciliationRequired`. It is never retryable and carries
   `writeOutcome: "unknown"`, through every renewal failure and a
   cancellation. Only a renewal that succeeded drops the handoff
   (`connector_call_failed`, still unknown), because the credential then
   needs no recovery. A write is never resent automatically: refresh-once
   does not, and the transport's one-dispatch guard stops anything that
   tries. This is the separate Q8 policy composed over the core's verdict,
   not a second kit verdict table. **Decided:** the rule stands for every
   provider. The kit applies it, and the 401 back-port (#917) made it the
   core's for today's `guarded-fetch.ts` providers, with `authBeforeExecution`
   as the core's reviewed declaration. Google Workspace and Infisical already
   reported a write's 401 unknown since #902. B.5 needed only that back-port and
   regenerated goldens, with no divergent timeout/404/409 or description
   back-port; the final round's golden comparison showed the write 401 rows
   were the only difference, and #917 regenerated them.

## Consequences

- **Provider authors write declarations.** A provider becomes operations, a
  facts extractor and status table, a value-safety review, Schemas and
  projections. Paging, ledger, redirect, ceiling, secret and value-safety
  rules come from the kit. Every write verdict comes from the core, decided
  at `api()`'s boundary from the ledger the kit records into; only Q8 composes
  over it, and since the 401 back-port (#917) the core applies the same rule.
  No provider or kit copy forks the
  verdict table, and the committed case table catches one that tries.
- **Call state stops depending on object identity, and stops outliving its
  call.** Kit tools receive services on a fiber; every capability closes with
  its call, and request-owned resources close with their request. The
  Promise view keeps one table until `remoteMcp()` moves.
- **A write's verdict rests on facts recorded when they happened.** A refusal
  is the one request's served answer, marked where it was observed; nothing
  after it can turn an unknown write into a refusal or a retry: not a renewal
  or its failure, not a cancellation, not an auxiliary request's 401, 429 or
  5xx, not the provider's own refusal, not an error code.
- **A write leaves once.** The transport refuses a second dispatch of any
  logical write in a call, whatever above it asked: a retry, a redirect
  follower, a replaying renewal, a reconnect, a new request id. Every tool's write capacity is fixed at construction; a tool sending
  several declares its steps and bounded, input-derived item identities.
  Reservation happens atomically before any asynchronous preparation and
  is never released within a call.
- **Only a write answered 401 reads differently.** #902 already gave today's
  providers the rest: writes answered 5xx or 408, cut off, or refused at
  connect are unknown and never retryable, and a failure after a write left
  carries no retry advice. On the kit a write answered 401 keeps
  `auth_required` and its handoff, but is never retryable and its outcome is
  unknown. The 401 back-port (#917) gave today's providers the same, with
  regenerated goldens, so B.5's byte-identical step 1 has no prerequisite
  left; today's providers never receive divergent kit wording or fields.
- **Classification cannot read prose.** Vendor rules see tokens and
  allowlisted headers and return a code; the message is rendered afterwards.
  A vendor whose current mapper branches on message text must find a code or
  a header for it, or keep the text out of the decision.
- **The kit is internal until a later decision publishes it** (0009). Custom
  `api()` handlers and published declarations do not change (INV-13).
- **Deployments pay about 120–160 KB gzip once,** when they configure their
  first kit provider (round 2's measure, then the final round's). The root
  does not change, and the purity suite holds that.
- **Reconsider if** an effect upgrade forces changes beyond `client.ts`,
  `oauth.ts` and `vendor.ts`, B.5 trips the HttpApiClient fallback, or a
  migrated provider cannot match its goldens without a new kit primitive.
  That provider then stays on the old path until the kit grows the primitive.
  A kit change that needs a verdict the core does not give is a change to
  the core contract, decided there, never a kit rule.
