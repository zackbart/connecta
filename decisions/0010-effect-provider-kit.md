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

The prototype gives three kinds of evidence:

- **Against `index.ts`.** `kit-prototype.test.ts` (52 tests) compares catalog
  entries, the requests sent, and the mapped results for 43 fixture cases,
  including the write's statuses, in-band refusal, refused connection and
  confinement. It names every deliberate difference and asserts it: A.2's
  write outcomes and sensitive fields, and this record's 401 rule.
- **Against A.3's goldens.** Run out of tree through PR #900's harness (at
  `b32182cb`), with the three kit tools substituted into today's provider:
  `catalog.json` and `calls.json` are byte-identical, and `failures.json`
  differs in exactly three write cases (401, the 401 echo, and 500), each the
  deliberate change named above. An earlier run found that the kit defaulted
  HTTP 409 to `conflict`, where Tithe.ly answers `connector_call_failed`; the
  default is gone (B.3).
- **Against today's mappers.** `src/providers/stripe/kit-prototype.test.ts`
  maps 360 combinations of status, error body, headers and value-safety
  verdict through `stripeFailure` and through the kit, and requires the same
  code, message, retry advice and wait.

`test/http-kit.test.ts` (39 tests) covers the kit's own rules, and
`test/kit-stability.node.test.ts` the stability guard (Q7). Every suite but the
Node-only guard passes on Node and workerd.

Four constraints shape the design:

- **Unstable modules stay in three files.** effect 4.0.5 tags `effect/http`
  and `effect/http-api` `@stability unstable`. Only `src/http/client.ts`,
  `oauth.ts` and `vendor.ts` import them (`test/purity.node.test.ts`).
  Providers declare operations through names `vendor.ts` re-exports. That
  confines the unstable modules; it does not make them stable, and an effect
  upgrade may still change what those names do. Every other `effect` member
  the kit and its provider declarations use is tagged `@stability stable`,
  and `kit-stability.node.test.ts` checks it (Q7).
- **The kit stays out of the root graph.** The root measures 380,179 B gzip
  against a 399,882 B cap, which leaves 19,703 B of headroom. The kit costs
  about 118 KB. A deployment pays that once, through its first kit provider
  entry. The purity suite checks that `src/index.ts` reaches nothing under
  `src/http/`.
- **Classification belongs to the call.** The registry's served verdict
  decides at run time; the builder only annotates the catalog, and the HTTP
  method never decides.
- **Agent-facing bytes do not change.** A migrated provider matches its
  goldens unless its PR records a deliberate change.

A.2 (#902) is not merged yet. Its draft adds `deriveContext`/`contextKey`,
`callClassification`, the shared `unknownOutcome`, and the
deployment-controlled `sensitiveFields` privacy projection, and stops `api()`
OAuth from resending a write. Its fix round extends the rule that a dispatched
write is never resent and never advertised as retryable to `remoteMcp()`,
Google Workspace, and OAuth recovery failures. This record uses those names
and verdicts. Where A.2's review changes one, the kit takes A.2's; each lives
in one place in the kit. The prototype carries a ten-line copy of
`callClassification` (`attachServedClassification`) until #902 merges.

## Decision

### B.1 Call and operation services

Today a call's state lives in side tables keyed on the identity of the context
object. The table below sorts that state by owner and lifetime:

| State                                                                                           | Today                                                                    | Owner and lifetime                  | B.1                                                         |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------- |
| Caller                                                                                          | `connector-caller.ts` `callers`                                          | operation (any registry operation)  | `Caller`, in the operation layer                            |
| Catalog-cache policy, OAuth partition and sealer                                                | `catalog-cache.ts` `settings`, `oauth-partition.ts`, `oauth-sealing.ts`  | operation                           | the operation entry; moved into services by D.4             |
| Admission permit                                                                                | `call-admission-context.ts` `permits`                                    | call                                | `Budget`, whose `charge` refuses once the call closes       |
| Served classification                                                                           | A.2's `call-classification.ts`                                           | call                                | `Classification`                                            |
| Recovery facts                                                                                  | `call-recovery.ts` `facts`, which invocation reads via `dispatchContext` | call, read by invocation afterwards | `Recovery`, which writes into a record the invocation owns  |
| Per-call sent secrets                                                                           | `sent-secrets.ts` `contexts` and `wrappedCredentials`                    | call, included in the request set   | `Secrets`                                                   |
| Credentials                                                                                     | `ctx.credential`, plus the `trackCredentialReads` mutation               | call                                | `Credentials`; every read registers what it returns         |
| Signal                                                                                          | `ctx.signal`                                                             | call                                | `Signal`                                                    |
| Requests sent                                                                                   | none                                                                     | call                                | `Dispatches`, the ledger the write-outcome rule reads (B.3) |
| OAuth grant                                                                                     | `ctx.oauth` and `static-oauth.ts` closures                               | call                                | `Grant` (B.2)                                               |
| Request set of sent secrets, invocation auth, handoffs, `rejectedScopes`, request-token flights | WeakMaps keyed on `requestScope`                                         | request                             | request-owned; a `RequestScope` service in D.1              |
| `remoteMcp()` sessions and transports                                                           | `requestScope` finalizers in `remote-mcp.ts`                             | request                             | request-owned; unchanged until D.6                          |

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
  Dispatches: Dispatch[]; // the ledger (B.2) the write-outcome rule reads (B.3)
}
// What one request inside a call is; set by `Send`, read by the transport and refresh-once.
const RequestFacts = Context.Reference<{ effect: "call" | "read"; operation?: OperationRef }>(…, { defaultValue: () => ({ effect: "call" }) });
```

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
- `Credentials.values` and `Budget.charge` check the lease before they start
  and again when their Promise settles. A use after close fails with
  `connector_call_failed` ("This call has ended…"); a read that was pending
  at close does not deliver its values. `Recovery.record` drops late facts,
  because invocation has already read the record. `Signal` aborts on exit, as
  today.
- The Promise view's `credential`, `chargeConnectorCall` and
  `recordRecovery` go through the same lease, so a retained view refuses in
  the same way. B.1 closes the Promise view's credentials too; it does not
  wait for D.6.

What a call owns and what its request owns are kept apart:

- **Call-owned:** the lease's capabilities, the dispatch ledger, the grant's
  use for this call. They close when the call's attempt scope ends.
- **Request-owned:** a `remoteMcp()` session or transport, a request-token
  flight, the request's sent-secret set, invocation auth and handoffs. They
  outlive the call that opened them and close when the request scope closes:
  their finalizers run in reverse order, the request signal aborts their
  pending work, and the request's operation views stop resolving. A session
  that needs a credential after the call that opened it reads it through the
  operation's credential access under the request signal, never through a
  call's `Credentials`, which is closed by then.

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
- "INV-7: a credential read pending when its call closes does not deliver".
- "INV-4 INV-10: discovery, status, and startAuth views carry each request's
  own caller across two pools", through `RegistryView`s for `alice` on `crm`
  and `bob` on `tickets`: catalog-cache's private fallback, `remoteMcp()`'s
  negotiation partition, and `startAuth`'s authorizing copy each read their
  own caller, and a spread copy reads none.
- "INV-7: a request-owned session outlives a call but not its request, and its
  pending work ends with the request".
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

| `guarded-fetch.ts`                                                                                              | Kit                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Base URL: https (http only on loopback), no URL credentials, query or fragment; throws at construction (INV-11) | `confinementBase`, the same function                                                                                             |
| Path is provider-relative with no `?` or `#`; origin and prefix re-checked after normalization                  | `preprocess`; `RequestRefused` → `invalid_args`, before any credential is read                                                   |
| `query`: `undefined` dropped; an array repeats its key                                                          | `HttpApiClient` encodes the operation's query Schema; struct field order is wire order                                           |
| `admit(url)` on the encoded URL, before authentication                                                          | `GuardedOptions.admit`, an Effect, in `preprocess` before `authenticate`                                                         |
| Constant headers, then request headers, then auth applied last; a shadowing auth header is refused              | `preprocess`: constants, then `authenticate` (an Effect over `Credentials` or `Grant`); a collision is `RequestRefused`          |
| JSON `body` gets `Content-Type: application/json`; `rawBody` is sent as framed; the two are exclusive           | `HttpClientRequest.bodyJsonUnsafe` / `bodyUrlParams` / `bodyText` set the type; the wire carries the body's retained text        |
| `sentSecretsFor(ctx).header(v)` per auth value, then `.request(url, init)` on the final URL and form body       | the `Secrets` service, with the same calls; a form body is registered from its text                                              |
| `visibleHeaders` added after registration; a collision is refused                                               | the `write` builder adds the idempotency header in `postprocess`, after registration                                             |
| `fetch` override: `oauthBearer` routes through `ctx.oauth.fetch`                                                | `refreshOnce` over `bearer`, below                                                                                               |
| `redirect: "manual"`; 301, 302, 303, 307 and 308 cancel the body and refuse                                     | `postprocess`: `RedirectRefused` → `connector_call_failed`, non-retryable                                                        |
| Declared `Content-Length` over the ceiling refused, except on HEAD or an ok `prefixOnly` read                   | `postprocess`: `ResponseTooLarge`; `prefixOnly` arrives with its first user (Google media)                                       |
| Streamed body capped at one chunk past the ceiling, then cancelled; no stream → measure the buffer              | `readReply`: `Stream.runFoldEffect` over `response.stream`; `EmptyBodyError` falls back to a measured `arrayBuffer`              |
| 204, 205, 304 and HEAD have no body                                                                             | the same sets                                                                                                                    |
| Bytes decoded as UTF-8, never `text()` (INV-6)                                                                  | `TextDecoder` over the bounded bytes                                                                                             |
| `jsonResult` tells unparseable text from a transport failure                                                    | `connect`'s settle step: `StatusFailure` with the parsed body, `UnreadableBody` for a 2xx that is not JSON; empty is `undefined` |
| `fetch` rejection → `unavailableCallError(cause, url, …, signal)`: errno and host only                          | `TransportFailure`, mapped through `unavailableCallError` unchanged; the ledger records `unconnected` or `lost`                  |
| `ctx.signal` handed to `fetch`                                                                                  | the `Signal` service combined with the fiber's interrupt signal through `AbortSignal.any`                                        |
| `retryAfterMs(headers)`                                                                                         | the same function, moved to a module both transports share                                                                       |

A provider never holds an `HttpClientResponse` or a raw body. `Send` returns an
`Answer` that already passed the value-safety boundary (B.4).

**The dispatch ledger.** The transport appends one `Dispatch` to the call's
`Dispatches` for every request it hands to `fetch`, and fills it in as it
happens:

```ts
interface Dispatch {
  readonly write: boolean;          // served classification is "write" and the request's effect is "call"
  readonly operation?: OperationRef;
  state: "pending" | "unconnected" | "lost" | "answered";
  status?: number;                  // set the moment the resource server answers
  headers?: Headers;
}
```

`unconnected` is recorded only when `fetch` itself rejected with an errno that
proves no connection (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EAI_FAIL`,
`EHOSTUNREACH`); any other rejection is `lost`, and a request interrupted in
flight stays `pending`. Requests a grant makes to its authorization server are
not resource requests and never enter the ledger.

**Two transports during Phase C (Q6).** `guarded-fetch.ts` stays a Promise
module for unmigrated providers, and is deleted with its last caller. It does
not become a facade over the kit client: `remote-mcp.ts` imports
`retryAfterMs` from it, and the kit client alone adds 31,260 B gzip to the
root, more than the root's headroom. B.2 moves the pure pieces
(`confinementBase`, `retryAfterMs`, the never-connected errno set, the
redirect and bodiless sets) into one plain module both transports import, and
adds a parity suite that runs one fixture matrix (confinement, header
precedence and collision, form registration, redirects, declared and streamed
ceilings, errno normalization, `Retry-After`) through both transports and
requires the same requests and the same mapped failures.

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

1. A 401 earns one `refresh(stale)`. The grant coordinates it across isolates
   (`downstream-oauth.ts`, unchanged). The 401's body is read under the
   ceiling first, so nothing stays open while renewing.
2. A request that is a read (the call's served classification is `read`, or
   the provider sent it with `{ effect: "read" }`) is replayed once.
   `authenticate` runs again and reads the renewed token. A second 401 runs
   `rejected`, which keeps `static-oauth`'s request-scope latch and its
   `downstream_oauth_required` wording.
3. A write request is never resent (INV-9), whatever its method. Its answer
   was recorded in the ledger when the resource server gave it. The renewal
   still runs, so the next deliberate call works, but its result is
   discarded: whatever the authorization server does (refuses the refresh
   for good, throttles it, fails DNS, goes down) is not this write's verdict.
   Refresh-once then hands the write's own 401 back to the pipeline, and B.3
   maps it from the ledger. A caller who leaves during the renewal gets the
   same verdict: the builder's edge reads the ledger when the call's signal
   aborted (`answeredVerdict`).
4. Refresh-once decides no verdict. The tests prove the rule both ways (a
   read built tool served as a write is not resent; a write built tool served
   as a read is replayed) and for each renewal failure and a cancellation.

`ctx.oauth.fetch` keeps its published contract for custom handlers. It returns
a `Response` and allows every `apiOrigins` origin, so it shares this decision,
not the client: #902's fix round makes its renewal failures keep the write's
unknown outcome too.

The goldens record two divergent 401 behaviours today:

- Google mints and resends once, writes included. Its transport argues that a
  401 is a refusal before the request did anything.
- Infisical logs in again without resending a write.

INV-9 forbids replaying a dispatched write, so C.7 stops Google's resend and
records the change; Google keeps a refusal only if its review cites the
evidence Q8 requires. C.5 adopts the rule as it stands.

### B.3 Tagged errors, vendor facts and the wire mapping

Every kit failure is one tag of `HttpFailure`. Each tag reaches the wire
through `toConnectorCallError` (`src/http/errors.ts`):

| Tag                | Raised by                                                              | Wire                                                        |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `RequestRefused`   | confinement, `admit`, header collision                                 | `invalid_args`, before anything is sent                     |
| `TransportFailure` | `fetch` rejected                                                       | `unavailableCallError`: errno and host only                 |
| `RedirectRefused`  | 3xx                                                                    | `connector_call_failed`, non-retryable                      |
| `ResponseTooLarge` | declared or streamed bytes past the ceiling                            | `connector_call_failed`, non-retryable                      |
| `StatusFailure`    | non-2xx, or an in-band refusal mapped as a status                      | the vendor's rules, then its table, then the defaults       |
| `UnreadableBody`   | a 2xx that is not JSON                                                 | `connector_call_failed` with the vendor's `unreadable` text |
| `Refusal`          | the provider or kit's own verdict (in-band, credential, cursor, grant) | the carried `ConnectorCallError`                            |

`StatusFailure` carries its `operation` (`{ method, template, flags? }`), set by
`Send` before the answer is read, so value safety decides what the failure may
quote before any detail exists.

**The vendor contract.** Classification reads machine-readable facts, never
prose:

```ts
interface VendorErrors<F extends Facts> {
  readonly provider: string;                                   // prose only, never parsed
  readonly facts: (body: unknown) => F;                        // codes, reasons, types; runs on every failure
  readonly headers?: readonly string[];                        // reviewed allowlist, by name; nothing else is visible
  readonly detail: (input: { status; facts: F; headers; withheld: boolean; body?: unknown }) => string;
  readonly classify?: ReadonlyArray<(facts: StatusFacts<F>) => ConnectorCallError | undefined>; // across statuses, in order
  readonly statuses: { 401; 403; 404 /* required */; [status: number]; serverError?; otherwise? };
  readonly unreadable: string;
  readonly authBeforeExecution?: { readonly evidence: string }; // Q8
}
interface StatusFacts<F> { status; facts: F; headers; retryAfterMs; operation: OperationRef; withheld: boolean; detail: Prose }
```

- **Facts are bounded.** A fact is a token (1–128 characters of
  `[A-Za-z0-9_.:[\]-]`), a finite number, or a boolean, or a list of at most
  eight. Anything else (prose, a URL, an object) is dropped before a rule
  runs, so a vendor's message cannot reach a classification even through a
  careless extractor.
- **Headers are an allowlist.** Only the names a vendor's review lists are
  visible to rules and wording, and a value longer than 128 characters or with
  a control character is dropped. `Retry-After` is read separately into
  `retryAfterMs`.
- **`detail` is wording only.** Rules receive it as `Prose`, which has no
  string methods: interpolating it works, branching on it does not compile.
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
- **409 has no default.** `conflict` is a refusal, so it tells invocation that
  a write did not land. Only a vendor that documents its 409 may say that.

**Stripe** (`stripeFailure`, proven equal over 360 cases):

```ts
const stripeErrors: VendorErrors<{ type?; code?; declineCode?; param? }> = {
  provider: "Stripe",
  facts: (body) => ({ type, code, declineCode: decline_code, param }),  // error.* fields
  headers: ["request-id", "stripe-rate-limited-reason"],
  detail: ({ status, facts, headers, withheld, body }) =>
    `Stripe ${kind || `HTTP ${status}`}${param}: ${withheld ? "Stripe's message is withheld…" : message(withholdEmbeddedUrlsIn(body))}${requestId}`,
  classify: [({ status, facts, detail }) => status === 429 && facts.code === "lock_timeout" ? conflict(detail, 1_000) : undefined],
  statuses: { 429: rate_limited(reason header, retryAfterMs ?? 1_000), 401: auth_required, 403: provider_permission_denied,
    404: not_found, 400/409/422: invalid_args, 402: connector_call_failed, 424: unavailable, serverError: unavailable (no wait) },
};
```

The one narrowing: a `param` outside the token grammar (a param name with
spaces) is dropped where `stripeFailure` quotes it; the suite records it.

**Cloudflare** (`failureFor` in `cloudflare/rest.ts`):

```ts
const cloudflareErrors: VendorErrors<{ codes: number[]; authCode: boolean }> = {
  provider: "Cloudflare",
  // errors[].code and every error_chain code; `authCode` is computed over all of them, before the list is bounded.
  facts: (body) => { const codes = errorCodes(errorsOf(body)); return { codes: [...codes], authCode: [...codes].some((code) => AUTH_ERROR_CODES.has(code)) }; },
  headers: ["cf-ray"],
  detail: ({ facts, headers, withheld, body }) =>
    `${withheld ? `Cloudflare error code ${facts.codes.join(", ")}. Its text is withheld…` : describeErrors(errorsOf(withholdEmbeddedUrlsIn(body)))}${headers["cf-ray"] ? ` Ray ${headers["cf-ray"]}.` : ""}`,
  classify: [
    // 429 before the authentication codes: Cloudflare reuses 10000 on throttled responses.
    ({ status, detail, retryAfterMs }) => status === 429 ? rate_limited(detail, retryAfterMs ?? 300_000) : undefined,
    ({ status, facts, detail }) => status === 401 || facts.authCode ? auth_required(status, detail) : undefined,
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
    facts: (body) => ({ reasons: [...reasonsOf(record(record(body).error))] }), // errors[].reason, details[].reason, status
    detail: ({ status, body }) => message(body) ? `${context.provider}: ${message(body)}` : `${context.provider} returned HTTP ${status}.`,
    classify: [
      ({ status, detail }) => status === 401 ? auth_required(detail) : undefined,
      ({ facts, detail }) => has(facts, "accessNotConfigured", "SERVICE_DISABLED") ? apiDisabled(detail) : undefined,
      ({ status, facts, detail, retryAfterMs }) =>
        status === 429 || has(facts, "rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED") ? rate_limited(detail, retryAfterMs) : undefined,
      ({ facts, detail }) => has(facts, "insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT") ? scopeMissing(detail) : undefined,
      ({ facts, detail }) => has(facts, "exportSizeLimitExceeded") ? exportTooLarge(detail) : undefined,
      ({ facts, detail }) => has(facts, "domainPolicy") ? domainPolicy(detail) : undefined,
      ({ facts, detail }) => has(facts, "insufficientFilePermissions", "forbidden") ? itemPermission(detail) : undefined,
      // `Send(op, request, { flags: { revisionGuarded: true } })` sets the operation's flag.
      ({ status, facts, operation }) => operation.flags?.revisionGuarded && (status === 400 || status === 409) &&
        has(facts, "FAILED_PRECONDITION", "failedPrecondition", "ABORTED", "aborted") ? revisionConflict() : undefined,
      ({ status, facts, detail }) => status === 400 && has(facts, "FAILED_PRECONDITION", "failedPrecondition") ? precondition(detail) : undefined,
    ],
    statuses: { 401: auth_required, 403: provider_permission_denied, 404: context.notFound === "absent" ? not_found : ambiguous },
  };
}
```

A Google product adds its own rules ahead of these (Drive's
`cannotDownloadAbusiveFile`), reading `facts.reasons`, so the `googleReasonsOf`
side table goes away. `googleOutcomeOf`'s phases become the ledger.

**Write outcome over the ledger.** A builder maps every failure through this
one function, with the call's served `Classification`, its `Dispatches`, and
whether the request carried an idempotency key. For a write, in order:

1. **Nothing left connecta.** No write request, or every one is `unconnected`:
   the vendor's verdict stands. A failure before the first dispatch proves
   nothing was sent; so does a write whose own `fetch` found no host. The
   count of dispatches does not decide this, because an authorization
   server's or an auxiliary read's failure is not the write's.
2. **The write was answered 401** (Q8). The verdict is fixed by that answer
   and nothing after it: the vendor's 401 rule for wording, then, without
   `authBeforeExecution` evidence, `connector_call_failed`, non-retryable:
   "{vendor 401 text} The write was sent before {provider} rejected its
   credential, so whether it took effect is unknown: check the target before
   repeating it." With evidence, the vendor's 401 refusal stands.
3. **The write carried an idempotency key.** The vendor's verdict stands, and
   its `Recovery` facts carry the key.
4. **Any retryable `unavailable` after dispatch** (a 5xx, a connection lost
   after sending, a provider's own `Refusal` wrapping an outage) becomes
   `connector_call_failed`, non-retryable, in the REST kit's `unknownOutcome`
   words, so REST goldens hold: "Whether the write took effect at {provider}
   is unknown: it carried no idempotency key, so check the target before
   repeating it." A timeout is exempt: invocation already reports it as
   `write_outcome_unknown`.

Every other verdict after dispatch is already non-retryable or a refusal the
vendor gave to the write itself. Rule 2's cost: an operator-recoverable
credential failure on a write loses invocation's structured
`authorize_connector` handoff (its words stay in the message, and the next
read gets the handoff). The goldens show invocation already marks an entered
write's `auth_required` `reconciliationRequired`, but `classifyWriteOutcome`
counts it as a refusal; rule 2 makes the code and the accounting agree with
the wording. The contract phase restores the handoff beside `uncertainCall`
(Q2).

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
  readonly flags?: Readonly<Record<string, true>>;           // facts the vendor's rules read, such as revisionGuarded
}) => Effect.Effect<Answer, HttpFailure, R>;                 // Answer = { status, data }: settled and safe
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec; // for scripts/drift-check.mjs only
```

- Schemas use the stable `effect` `Schema`. Query struct field order is wire
  order. Optional fields use `Schema.optionalKey`.
- **Integers use the kit's `Integer`**: any finite whole number, rendered
  `type: integer`, which is what catalogs and `api()`'s validator have always
  meant. `Schema.Int` decodes only safe integers and renders that bound;
  `Schema.Number` renders `anyOf` number or `"Infinity"`/`"-Infinity"`/`"NaN"`.
  Neither appears in a kit declaration.
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
3. a non-2xx becomes `StatusFailure` with its operation, and B.3 asks
   `withholdsErrors(operation)` before it builds any detail;
4. JSON parse (`UnreadableBody` otherwise);
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
  readonly idempotency?: { readonly header: string; readonly key: (args: I["Type"]) => string };
}): ApiTool;
function action<I extends Input, O extends Schema.Top>(connection: Connection, spec: ToolSpec<I, O>): ApiTool;
```

`read` and `write` are prototyped; `list`, `get`, `action`, `idempotency` and
the `review` check arrive in B.4.

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
  that answer's verdict (B.3, rule 2) rather than the bare abort reason; any
  other cancellation keeps the reason, which invocation reports as it does
  today.
- **Both catalog schemas come from Schemas.** `catalogSchema(schema, mode)`
  renders connecta's dialect:
  - drop the default `additionalProperties: true`;
  - close inputs, and always give the root a `required` list;
  - an array's own keywords before `items`, as hand-written catalogs spell it;
  - merge a primitive `anyOf` into a `type` array, but only when each branch's
    keywords apply to its own type alone;
  - drop nothing the decoder enforces.

  A property description on `Schema.Unknown` goes through
  `Schema.annotateKey`; Effect drops a value annotation there. B.4 adds a
  refusal at construction for any check that renders no JSON Schema keyword.

- **Catalog and decoder accept the same values.** `api()` validates arguments
  against the rendered schema first, so agents read the same `invalid_args`;
  the builder then decodes with the Schema, and a decode failure is a defect
  whose text `api()` withholds. An agreement check runs every kit tool's
  input properties through boundary values (0, ±1, 1.5, 2^53, −2^53, 1e21,
  empty and oversized strings, wrong types, over-long arrays) under both and
  requires the same accept/reject. The Tithe.ly suite keeps the case that
  found the drift: `list_charges({ accountId: "u", createdAfter:
  9007199254740992 })` succeeds today and on the kit.
- **`run` is typed by `output`.** A projection that returns untouched rows does
  not compile. The prototype keeps one cast for Tithe.ly's `raw` flag; B.5
  declares the union (Q3).

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
hatch retires the `_api_get`/`_api_mutate` pairs of Tithe.ly, Breeze, CCB,
Planning Center and Overflow. Each rename is a recorded catalog change in that
provider's Phase C PR; B.5 may keep Tithe.ly's names (the prototype does) and
rename in its own recorded step.

**Provider (`src/http/provider.ts`).** The builder is built on `defineProvider`,
not `asProviderFactory`. `defineProvider` already validates `purpose`, the
common options and the title, and renders the guide through
`ProviderContext.usageGuide`.

```ts
function defineApiProvider<O extends ProviderOptions>(definition: Omit<ProviderDefinition<O>, "kind" | "create"> & {
  readonly vendor: Vendor;
  readonly baseUrl: (options: Readonly<O>) => string;                 // environment or override; checked at construction
  readonly maxResponseBytes: number;
  readonly pageSize?: { readonly default: number; readonly max: number }; // becomes the `defaultPageSize` option and its check
  readonly credential?: ConnectorCredentialConfig;                    // exclusive with oauth
  readonly oauth?: (options: Readonly<O>) => ApiOAuthConfig;
  readonly authenticate: Effect.Effect<Readonly<Record<string, string>>, HttpFailure, CallServices | Grant>;
  readonly errors: VendorErrors;
  readonly safety: (options: Readonly<O>) => SafetyOptions;           // reviewed table or reason, and the sensitiveFields option
  readonly result?: ConnectOptions["result"];
  readonly probe: { readonly operation: Operation; readonly request: unknown; readonly describe: (reply: unknown) => string };
  readonly guide: (options: Readonly<O>) => ProviderGuideInput;
  readonly tools: (kit: { connection: Connection; pageSize: number; options: Readonly<O> }) => ApiTool[];
}): ProviderFactory<O>;
```

The probe becomes `testCredential(s)`. It runs `authenticate` against the
candidate values, sends one operation, and maps a failure through the vendor
table. It copies no context.

`manifest(vendor)` gives the method, path and parameter names of every
operation. `scripts/drift-check.mjs` digests it against the vendor's published
contract, so `drift.json` lists only the vendor sources, and the operation set
comes from code.

`src/provider.ts` stays Effect-free, as `purity.node.test.ts` requires.

### How the kit keeps the invariants

| INV | Mechanism                                                                                                                            | Evidence: existing, then new                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The builder annotates the class; the served classification decides at run time; byte-identical catalog; catalog and decoder agree    | `rest-connector.test.ts` "INV-1: names four tools…"; `kit-prototype.test.ts` "INV-1" (catalog, served classification); `http-kit.test.ts` "INV-1" (boundary agreement, served classification); A.3 `catalog.json` |
| 2   | Kit tools are `ApiTool`s; registry enforcement unchanged                                                                             | `connector-read-only.test.ts` "INV-2: defaults writable…"                                                                                                                                                         |
| 3   | Confinement and `admit` run before credentials; agents name no base or credential                                                    | `guarded-fetch.test.ts` confinement suite; `http-kit.test.ts` "INV-3: confines…" and "INV-3 INV-5: admits…"                                                                                                       |
| 4   | `Caller` comes from the admitted scope on every operation; `Classification` from the served definition                               | `mcp-core.test.ts` "INV-4: binds SDK envelope…"; `http-kit.test.ts` "INV-4 INV-10: discovery, status, and startAuth views…"; B.1's registry tests                                                                 |
| 5   | Credentials only through services; every sent value registered; one value-safety boundary; withheld text decided before any detail   | `sent-secrets.test.ts` "INV-5: api OAuth registers both tokens…"; `http-kit.test.ts` "INV-5" (boundary, hatch, withheld); `kit-prototype.test.ts` "INV-5" (sensitive fields)                                      |
| 6   | Bounded bytes and facts, allowlisted headers, `TextDecoder`, errno-only transport facts, withheld handler and decode text            | `guarded-fetch.test.ts` "INV-6: decodes bounded bytes…"; `http-kit.test.ts` "INV-6" (facts, prose); Stripe `kit-prototype.test.ts` "INV-6"                                                                        |
| 7   | Explicit call finalizers and closed-state checks; request-owned resources close with the request; `fetch` gets the call signal       | `call-admission.test.ts` "INV-7: stops a retained connector context…"; `http-kit.test.ts` "INV-7" (retained service, pending read, retained view, request-owned session); `kit-prototype.test.ts` "INV-7"         |
| 8   | Catalogs are static; no change                                                                                                       | `catalog-cache.test.ts` "INV-8: a missing SQL chunk forces a complete live refresh"                                                                                                                               |
| 9   | The ledger, the served class and idempotency decide; a write answered 401 keeps its verdict through renewal failure and cancellation | `rest-connector.test.ts` "INV-9: dispatches a write once…"; `http-kit.test.ts` "INV-9" (ledger, four renewal failures, cancellation, evidence); `kit-prototype.test.ts` "INV-9"; A.3 `failures.json`              |
| 10  | Renewal only inside a call; probes and operation views never start authorization                                                     | `api-oauth.test.ts` "INV-10: reports auth_required from status…"                                                                                                                                                  |
| 11  | Base URL, ceiling, page size, value-safety review and options checked at construction                                                | `provider-definition.test.ts` "INV-11: rejects invalid common options before create runs"; `http-kit.test.ts` "INV-11"                                                                                            |
| 12  | `src/http/` is unreachable from the root; area modules confined to three files; stable members only elsewhere                        | `purity.node.test.ts` "keeps the provider kit out of the root graph" and "confines Effect's unstable area modules…"; `kit-stability.node.test.ts`                                                                 |
| 13  | Factories return `Connector`; kit types are internal; the build does not emit the prototype                                          | `package-surface.node.test.ts` "INV-13: publishes no Effect type in any reachable declaration"; `check:declarations`                                                                                              |

### Migration order

Each step is one PR. Each must pass `pnpm run check` and match the goldens.

- **B.1.** Adds `src/runtime/call.ts` with both layers, the registry's
  operation entries, invocation's provision and finalizer, `api()`'s Effect
  entry and shared core, `contextView`, and the one table behind the existing
  readers. It includes the tests above. Agent-facing output is unchanged.
- **B.2.**
  - Moves `client.ts` and `oauth.ts` out of prototype status, with the ledger.
  - Adds the shared pure module and the two-transport parity suite (Q6).
  - Builds `Grant` over `static-oauth.ts`: `token`, `refresh`, and `rejected`
    with its latch. `ctx.oauth.fetch` shares the decision.
- **B.3.** Adds `errors.ts`. The REST kit's failure mappers and A.2's
  `unknownOutcome`/`sendingOnce` move onto `toConnectorCallError`. Each
  vendor's mapper is restated as facts, an allowlist and rules, with a suite
  like Stripe's that maps its fixtures through both and requires equality.
- **B.4.** Adds `safety.ts`, `vendor.ts`, `tools.ts` with all five builders,
  `paging.ts` with all five strategies, `json-schema.ts` with `Integer` and
  the agreement check, `hatch.ts`, `provider.ts`, and the stability guard
  over every kit and provider declaration file. Each comes with a unit suite
  like `http-kit.test.ts`.
- **B.5, the gate (Q1).** Moves `src/providers/tithely/` onto the kit
  completely: every tool, the writes, the credential and 401 paths, every
  failure path and the hatch.
  - Its tools match `test/goldens/tithely/`, except changes it records: the
    hatch rename if it makes one, the `raw` union (Q3), A.2's write outcomes
    and sensitive fields, and the 401 rule (Q8).
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

### Measured

Builds use esbuild with `scripts/bundle-size.mjs` settings (neutral platform,
minified, gzip -9) on this branch. Deltas are over `src/index.ts`, which every
deployment imports.

| Bundle                                    | gzip bytes                    |
| ----------------------------------------- | ----------------------------- |
| root                                      | 380,179                       |
| root + today's Tithe.ly (12 tools)        | 389,655 (+9,476)              |
| root + kit modules, no provider           | 498,290 (+118,111)            |
| root + kit + Tithe.ly prototype (3 tools) | 502,479 (+4,189 over the kit) |
| `./providers/tithely` today, standalone   | 36,172                        |
| Tithe.ly prototype entry, standalone      | 160,812                       |

Each piece, added alone to the root, measured on `81cdffbc` before this
round's changes:

| Piece                          | gzip bytes |
| ------------------------------ | ---------- |
| `Schema` with JSON Schema      | +65,943    |
| `Schema` and `Stream` (paging) | +90,255    |
| `effect/http` client           | +31,156    |
| `effect/http-api` vendor       | +49,012    |

They share `Schema` and `Stream`, so the set costs about 118 KB, not their
sum. `examples/worker` imports no provider, so no capped entry moves. Bundle
cost is paid once per deployment and does not decide Q1.

**Lines.** The previous round counted the code `get_charge` and `list_charges`
need with the TypeScript scanner: 452 today, 381 on the kit (−16%), and
316 → 245 (−22%) without the 136 lines identical in both. Counting
non-blank, non-comment lines, `src/http/` grows in this round from 729 to
1,209: the ledger, facts and bounds in `errors.ts`, the settle route in
`vendor.ts` and `safety.ts`, and B.1's lease, view and request-scope
prototype in `services.ts`, which B.1 moves to `src/runtime/call.ts`.
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
   `unknown` and restore a structured handoff beside `uncertainCall`. Until
   then the kit keeps truthful uncertainty and non-retryability now,
   including through recovery failures (B.3's ledger rules).
3. **Tithe.ly's `raw` flag.** Keep A.2's deployment-controlled
   `sensitiveFields`. B.5 declares the output honestly as a union of the
   projection and a record schema, and both branches are filtered, which the
   value-safety boundary does by construction. Removing `raw` waits for the
   contract phase.
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
8. **A write answered 401 is an unknown outcome by default.** A refusal needs
   vendor-declared evidence that the vendor authenticates before it executes
   (`authBeforeExecution.evidence`, reviewed per vendor). A write is never
   resent automatically, and a renewal failure never changes the verdict.

## Consequences

- **Provider authors write declarations.** A provider becomes operations, a
  facts extractor and status table, a value-safety review, Schemas and
  projections. Error, paging, write-outcome, redirect, ceiling, secret and
  value-safety rules come from the kit and cannot be skipped.
- **Call state stops depending on object identity, and stops outliving its
  call.** Kit tools receive services on a fiber; every capability closes with
  its call, and request-owned resources close with their request. The
  Promise view keeps one table until `remoteMcp()` moves.
- **A write's verdict is a fact recorded when the vendor answered.** Nothing
  after it, renewal or cancellation, can turn it into a refusal or a retry.
- **Some write failures read differently.** Tithe.ly-style writes answered
  401 or 5xx, or cut off after connecting, report an unknown outcome instead
  of `auth_required` or a retryable `unavailable`. Each migration records it.
- **The kit is internal until a later decision publishes it** (0009). Custom
  `api()` handlers and published declarations do not change (INV-13).
- **Deployments pay about 118 KB gzip once,** when they configure their first
  kit provider. The root does not change, and the purity suite holds that.
- **Reconsider if** an effect upgrade forces changes beyond `client.ts`,
  `oauth.ts` and `vendor.ts`, B.5 trips the HttpApiClient fallback, or a
  migrated provider cannot match its goldens without a new kit primitive.
  That provider then stays on the old path until the kit grows the primitive.
