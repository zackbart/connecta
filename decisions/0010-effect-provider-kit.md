---
status: proposed
date: 2026-10-20
issues: []
supersedes: []
---

# The Effect provider kit

[0009](./0009-effect-native-rewrite.md) chose to rebuild the HTTP layer on
Effect and sequenced the work as B.1–B.5. This record fixes the design of
B.1–B.4. A prototype under `src/http/` runs Tithe.ly's `get_charge` and
`list_charges` (`src/providers/tithely/kit-prototype.ts`). Nothing live imports
it, and the build does not emit it.

The prototype gives two kinds of evidence:

- **Against `index.ts`.** `kit-prototype.test.ts` compares catalog entries,
  the requests sent, and the mapped results for 31 fixture cases, plus
  credential refusal, the Basic header, caller abort, and the endpoint
  manifest. It passes on Node and workerd.
- **Against A.3's goldens.** Run through the harness of PR #900 (at
  `e9cc0315`), the two kit tools reproduce their `catalog.json` and
  `calls.json` entries and all nine `failures.json` cases byte for byte, on
  Node and workerd. That run found a difference the comparison suite missed:
  the kit defaulted HTTP 409 to `conflict`, where Tithe.ly answers
  `connector_call_failed`. The default is gone (B.3), and the suite now has a
  409 case. That run is not committed, because the harness lands with #900;
  B.5 makes it the gate.

Four constraints shape the design:

- **Unstable modules stay in three files.** effect 4.0.5 tags `effect/http`
  and `effect/http-api` `@stability unstable`. Only `src/http/client.ts`,
  `oauth.ts` and `vendor.ts` import them, and `test/purity.node.test.ts` now
  enforces that. Every `Schema`, `Stream`, `Context`, `Data` and `Effect`
  member the kit uses is tagged `@stability stable`. `Schema`'s unstable
  members are network value types (IP, MAC, DNS, cookies) that the kit does
  not use.
- **The kit stays out of the root graph.** The root measures 380,179 B gzip
  against a 399,882 B cap, which leaves 19,703 B of headroom. The kit costs
  about 116 KB. A deployment pays that once, through its first kit provider
  entry. The purity suite now checks that `src/index.ts` reaches nothing under
  `src/http/`.
- **Classification belongs to the call.** The registry's served verdict
  decides; the HTTP method never does.
- **Agent-facing bytes do not change.** A migrated provider matches its
  goldens unless its PR records a deliberate change.

A.2 is not merged yet. Its draft adds `deriveContext`/`contextKey`,
`callClassification` and a shared `unknownOutcome`, and stops `api()` OAuth from
resending a write. This record uses those names. If A.2's review changes a
verdict, the kit takes A.2's verdict; each one lives in a single place in the
kit.

## Decision

### B.1 Call services

Today a call's state lives in side tables keyed on the identity of the context
object. The table below sorts that state by lifetime:

| State                                                                                           | Today                                                                    | Lifetime                             | B.1                                                          |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------ |
| Caller                                                                                          | `connector-caller.ts` `callers`                                          | call                                 | `Caller`                                                     |
| Admission permit                                                                                | `call-admission-context.ts` `permits`                                    | call                                 | `Budget`, whose `charge` refuses once the permit is released |
| Served classification                                                                           | A.2's `call-classification.ts`                                           | call                                 | `Classification`                                             |
| Recovery facts                                                                                  | `call-recovery.ts` `facts`, which invocation reads via `dispatchContext` | call, read by invocation afterwards  | `Recovery`, which writes into a record the invocation owns   |
| Per-call sent secrets                                                                           | `sent-secrets.ts` `contexts` and `wrappedCredentials`                    | call, included in the request set    | `Secrets`                                                    |
| Credentials                                                                                     | `ctx.credential`, plus the `trackCredentialReads` mutation               | call                                 | `Credentials`; every read registers what it returns          |
| Signal                                                                                          | `ctx.signal`                                                             | call                                 | `Signal`                                                     |
| Requests sent                                                                                   | none                                                                     | call                                 | `Dispatches`, read by the write-outcome rule (B.3)           |
| OAuth grant                                                                                     | `ctx.oauth` and `static-oauth.ts` closures                               | call                                 | `Grant` (B.2)                                                |
| OAuth partition and sealer                                                                      | `oauth-partition.ts`, `oauth-sealing.ts`                                 | connector context, for any operation | kept in the one table below; moved into services by D.4      |
| Request set of sent secrets, invocation auth, handoffs, `rejectedScopes`, request-token flights | WeakMaps keyed on `requestScope`                                         | request                              | unchanged; a `RequestScope` service in D.1                   |

Request-keyed state is already sound: the request scope is an object that dies
with its request (INV-7). The defect 0009 names is call state keyed on a
context that a `{...ctx}` copy replaces.

```ts
// src/runtime/call.ts (prototype: src/http/services.ts). Each key is one
// `class K extends Context.Service<K, CallShapes[K]>()("connecta/call/K") {}`.
interface CallShapes {
  Caller: ConnectorCaller | undefined;
  Budget: { readonly charge: Effect.Effect<void, CallAdmissionError> };
  Classification: "read" | "write";
  Recovery: { readonly record: (facts: Readonly<Record<string, string>>) => Effect.Effect<void> };
  Secrets: SentSecrets;
  Credentials: { readonly values: Effect.Effect<ConnectorCredentialValues | null, ConnectorCallError> };
  Signal: AbortSignal | undefined;
  Dispatches: { count: number };
}
type CallServices = Caller | Budget | Classification | Recovery | Secrets | Credentials | Signal | Dispatches;
```

**Provision.** Invocation builds `Context<CallServices>` once per dispatch. It
does so in the scoped attempt that already owns the permit (the `call(permit)`
closure in `invocation.ts`), and gets each service from code, never from
arguments (INV-4):

- `Caller` comes from the admitted registry scope.
- `Budget` comes from the permit.
- `Classification` is `target.definition.classification`. That is the
  registry's served verdict, so deployment config wins over the tool's own
  annotation.
- `Recovery` writes into a record the invocation holds, which replaces
  `dispatchContext` and `recoveryFor`.
- `Secrets` is a per-call set included in the request set.
- `Credentials` reads through the registry's credential access.
- `Signal` is the call signal from `withDeadlineEffect`.

The attempt's scope finalizer closes the state. `Budget` refuses, as it already
does after release (`call-admission.test.ts`, "INV-7: stops a retained
connector context from charging after its invocation ends"). The signal is
already aborted on exit. On the Effect path below, `Credentials` then refuses
and `Recovery` ignores late facts.

**Two ways into the connector.** `Connector.callTool` is published and
Promise-shaped, so services cannot reach a handler through it.

1. **Effect path (every `api()` connector).** `api()` registers an Effect entry
   beside its connector, a function from `(name, args, options)` to an
   `Effect` that requires `CallServices`. It is held in a module-private
   WeakMap keyed on the `Connector`, the same pattern as
   `registerInvocationAuth`. When an entry
   exists, invocation runs it in the attempt fiber with
   `Effect.provideContext(services)`. One core in `api()` builds both this
   entry and `callTool`, so argument validation, result redaction, and
   withheld handler text stay identical. A kit tool then sees services and
   never sees a context. Nothing can copy or retain the call state, because
   it is a value on a fiber that the scope interrupts. That is INV-7 by
   construction.
2. **Promise view (custom handlers, unmigrated providers, `remoteMcp()`).**
   `contextView(services, base)` builds the published `ConnectorContext`, or
   `ApiHandlerContext` for a handler:
   - `storage`, `logger`, `baseUrl`, `publicUrl`, `oauthClientName`,
     `requestScope`, `timeoutMs` and `defer` come from the registry's base.
   - `credential`, `signal`, `fetch` and `oauth` are facades over the services.

   The view is entered into one module-private table that maps
   `contextKey(view)` to its `Context<CallServices>`, so A.2's derived copies
   resolve to the same entry.
   `callerOf`, `chargeConnectorCall`, `recordRecovery`, `sentSecretsFor` and
   `callClassification` become one-line lookups. Six WeakMaps become one,
   and the table goes away when D.6 moves `remoteMcp()`.

   The published types do not change (INV-13). Caller, permit and recovery
   stay off them, as today. On this path, closing `Credentials` waits for
   D.6, because a `remoteMcp()` session can outlive the call that opened it.

An earlier draft carried the services in an enumerable symbol slot on the
context. That survives `{...ctx}`, but it puts call state on an object that
deployment code receives. A.2 replaces every copy with `deriveContext` anyway.

**Probes.** `testCredential(s)` gets a `Credentials` service built from the
candidate values, with no `Caller`, a `Budget` that never charges, and
`Classification` `"read"`. It copies no context. Most of the twelve `{...ctx}`
sites 0009 counts are probes, so this removes them. The rest
(`authorizingContext` and the request-token mint) become `deriveContext` calls
in A.2.

**New tests (B.1):**

- "INV-7: a context view retained past its call cannot charge, read
  credentials, or record recovery"
- "INV-4 INV-9: a derived copy of the view reads the same caller, permit,
  classification and recovery"
- "INV-9: invocation reads recovery facts from the call's record, not from
  a context"
- "INV-4: an api() Effect entry receives the admitted caller and the served
  classification, never one named in arguments"

### B.2 Guarded client and refresh-once

`guardedClient(options)` is built with `HttpClient.makeWith`. In 4.0.5, `HttpClient.make` (and with it `FetchHttpClient`)
opens a span through `Effect.useSpan` and writes `b3` and `traceparent`
headers while `TracerPropagationEnabled` is on, which is the default. That
would change the requests sent and hand request facts to whatever tracer is
installed.

| `guarded-fetch.ts`                                                                                              | Kit                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL: https (http only on loopback), no URL credentials, query or fragment; throws at construction (INV-11) | `confinementBase`, the same function                                                                                                   |
| Path is provider-relative with no `?` or `#`; origin and prefix re-checked after normalization                  | `preprocess`; `RequestRefused` → `invalid_args`, before any credential is read                                                         |
| `query`: `undefined` dropped; an array repeats its key                                                          | `HttpApiClient` encodes the operation's query Schema; struct field order is wire order                                                 |
| `admit(url)` on the encoded URL, before authentication                                                          | `GuardedOptions.admit`, an Effect, in `preprocess` before `authenticate` (prototyped)                                                  |
| Constant headers, then request headers, then auth applied last; a shadowing auth header is refused              | `preprocess`: constants, then `authenticate` (an Effect over `Credentials` or `Grant`); a collision is `RequestRefused`                |
| JSON `body` gets `Content-Type: application/json`; `rawBody` is sent as framed; the two are exclusive           | `HttpClientRequest.bodyJsonUnsafe` / `bodyUrlParams` / `bodyText` set the type; the wire carries the body's retained text (prototyped) |
| `sentSecretsFor(ctx).header(v)` per auth value, then `.request(url, init)` on the final URL and form body       | the `Secrets` service, with the same calls; a form body is registered from its text (prototyped)                                       |
| `visibleHeaders` added after registration; a collision is refused                                               | the `write` builder adds the idempotency header in `postprocess`, after registration                                                   |
| `fetch` override: `oauthBearer` routes through `ctx.oauth.fetch`                                                | `refreshOnce` over `bearer`, below                                                                                                     |
| `redirect: "manual"`; 301, 302, 303, 307 and 308 cancel the body and refuse                                     | `postprocess`: `RedirectRefused` → `connector_call_failed`, non-retryable                                                              |
| Declared `Content-Length` over the ceiling refused, except on HEAD or an ok `prefixOnly` read                   | `postprocess`: `ResponseTooLarge`; `prefixOnly` arrives with its first user (Google media)                                             |
| Streamed body capped at one chunk past the ceiling, then cancelled; no stream → measure the buffer              | `readReply`: `Stream.runFoldEffect` over `response.stream`; `EmptyBodyError` falls back to a measured `arrayBuffer`                    |
| 204, 205, 304 and HEAD have no body                                                                             | the same sets                                                                                                                          |
| Bytes decoded as UTF-8, never `text()` (INV-6)                                                                  | `TextDecoder` over the bounded bytes                                                                                                   |
| `jsonResult` tells unparseable text from a transport failure                                                    | `json(reply)`: `StatusFailure` with the parsed body, `UnreadableBody` for a 2xx that is not JSON; empty is `undefined`                 |
| `fetch` rejection → `unavailableCallError(cause, url, …, signal)`: errno and host only                          | `TransportFailure`, mapped through `unavailableCallError` unchanged                                                                    |
| `ctx.signal` handed to `fetch`                                                                                  | the `Signal` service combined with the fiber's interrupt signal through `AbortSignal.any`                                              |
| `retryAfterMs(headers)`                                                                                         | the same function, moved to a module both transports share                                                                             |

A provider never holds an `HttpClientResponse`. `Send` returns a `Reply`
(`{status, headers, text}`) that was already read under the ceiling.

**Two transports during Phase C.** `guarded-fetch.ts` stays a Promise module
for unmigrated providers, and is deleted with its last caller. It does not
become a facade over the kit client. `remote-mcp.ts` imports `retryAfterMs`
from it, and the kit client alone adds 31,260 B gzip to the root, more than
the root's headroom. B.2 moves the pure pieces (`confinementBase`,
`retryAfterMs`, the redirect and bodiless sets) into one plain module that
both transports import. That way they cannot drift, and the goldens guard
everything else.

**Refresh-once** (`src/http/oauth.ts`, prototyped). `Grant` is any renewable
token. The rule replaces four per-provider renewals after a 401: the static
OAuth grant, Google's service-account mint, Infisical's login, and GitHub's
App installation token.

```ts
class Grant extends Context.Service<Grant, {
  readonly token: Effect.Effect<string, HttpFailure>;
  readonly refresh: (stale: string) => Effect.Effect<string, HttpFailure>; // rotated-in token, else one coordinated refresh
  readonly rejected: Effect.Effect<never, HttpFailure>;                    // latch the request scope; the grant's own verdict
}>()("connecta/http/Grant") {}
```

1. A 401 earns one `refresh(stale)`. The grant coordinates it across isolates
   (`downstream-oauth.ts`, unchanged).
2. A call whose served classification is `read` is replayed once.
   `authenticate` runs again and reads the renewed token. A second 401 runs
   `rejected`, which keeps `static-oauth`'s request-scope latch and its
   `downstream_oauth_required` wording.
3. A `write` is never resent (INV-9), whatever its method. The refresh still
   happens, so the next deliberate call works. This call fails with
   `connector_call_failed`, non-retryable, saying the outcome is unknown. This
   is A.2's verdict for `ctx.oauth.fetch`: a server may act on a request
   before it rejects the token.
4. `http-kit.test.ts` proves the rule both ways. A GET classified as a write
   (Breeze) is not resent, and a POST classified as a read (a reviewed REST
   read) is replayed.

`ctx.oauth.fetch` keeps its published contract for custom handlers. It returns
a `Response` and allows every `apiOrigins` origin, so it shares this decision,
not the client.

The goldens record two divergent 401 behaviours today:

- Google mints and resends once, writes included. Its transport argues that a
  401 is a refusal before the request did anything.
- Infisical logs in again without resending a write.

INV-9 forbids replaying a dispatched write, so C.7 stops Google's resend and
records the change. C.5 adopts the rule as it stands. What such a failure
should say is open question 8.

### B.3 Tagged errors and the wire mapping

Every kit failure is one tag of `HttpFailure`. Each tag reaches the wire
through `toConnectorCallError` (`src/http/errors.ts`):

| Tag                | Raised by                                                              | Wire                                                        |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| `RequestRefused`   | confinement, `admit`, header collision                                 | `invalid_args`, before anything is sent                     |
| `TransportFailure` | `fetch` rejected                                                       | `unavailableCallError`: errno and host only                 |
| `RedirectRefused`  | 3xx                                                                    | `connector_call_failed`, non-retryable                      |
| `ResponseTooLarge` | declared or streamed bytes past the ceiling                            | `connector_call_failed`, non-retryable                      |
| `StatusFailure`    | non-2xx                                                                | the vendor table, then the defaults                         |
| `UnreadableBody`   | a 2xx that is not JSON                                                 | `connector_call_failed` with the vendor's `unreadable` text |
| `Refusal`          | the provider or kit's own verdict (in-band, credential, cursor, grant) | the carried `ConnectorCallError`                            |

```ts
interface VendorErrors {
  readonly provider: string;                                  // prose only, never parsed
  readonly detail: (body: unknown, status: number) => string; // one line; never the raw body
  readonly unreadable: string;
  readonly statuses: {
    readonly 401: StatusRule; readonly 403: StatusRule; readonly 404: StatusRule; // required
    readonly [status: number]: StatusRule | undefined;
    readonly serverError?: StatusRule; readonly otherwise?: StatusRule;
  };
}
type StatusRule = (facts: { status: number; detail: string; retryAfterMs: number | undefined }) => ConnectorCallError;
```

- **401, 403 and 404 are required by the type.** Their meaning differs by
  vendor. The same 403 means an ungranted capability at one vendor and a
  missing token scope at another. A 404 is `not_found` only where absence can
  be told apart from reach. Tithe.ly's 404 is deliberately
  `connector_call_failed`.
- **Defaults cover the rest:**
  - 400 and 422 → `invalid_args`
  - 429 → `rate_limited` with `Retry-After`
  - 5xx → `unavailable` with `Retry-After`
  - any other status → `connector_call_failed`, non-retryable
- **409 has no default.** `conflict` is a refusal, so it tells invocation that
  a write did not land. Only a vendor that documents its 409 may say that.

**Write outcome by construction.** A builder maps every failure through this
one function. It passes the call's served `Classification`, whether any
request reached `fetch` (`Dispatches`), and whether the request carried an
idempotency key. For a dispatched write without a key, a retryable
`unavailable` from any tag becomes `connector_call_failed`, non-retryable. The
message is the REST kit's own `unknownOutcome` text, so REST goldens hold:
"Whether the write took effect at {provider} is unknown: it carried no
idempotency key, so check the target before repeating it."

Two failures are exempt:

- A timeout, which invocation already reports as `write_outcome_unknown`.
- A `TransportFailure` whose errno proves no connection was made
  (`ECONNREFUSED`, `ENOTFOUND`, `EAI_*`, `EHOSTUNREACH`).

Every other verdict after dispatch is already non-retryable or a refusal, and
`classifyWriteOutcome` reads it as an unknown outcome or a refusal. Counting
dispatches is what makes the rule hold by construction. A provider cannot
escape it by wrapping an outage in `Refusal`. The tag does not decide; the
dispatch does. A failure before the first dispatch proves nothing was sent.

A write whose request carries an idempotency key keeps the vendor's verdict,
and its `Recovery` facts carry the key.

### B.4 The kit

**Vendor (`src/providers/<name>/api.ts`).** A provider declares operations
with constructors that `vendor.ts` re-exports, so it never names an unstable
module.

```ts
export const get, post, put, patch, del;  // HttpApiEndpoint constructors, re-exported
export function vendor(name: string, ...operations: [Operation, ...Operation[]]): Vendor;
export function connect<R>(vendor: Vendor, guarded: GuardedClient<R>): Send<R>;
export type Send<R = CallServices> = <Op extends Operation>(
  operation: Op,
  request: RequestOf<Op>,                     // { params?, query?, payload? }, typed from the Schemas
  options?: { readonly effect?: "read" },     // an auxiliary lookup inside a write tool; never inferred
) => Effect.Effect<Reply, HttpFailure, R>;
export function manifest(vendor: Vendor): OpenApi.OpenAPISpec; // for scripts/drift-check.mjs only
```

- Schemas use the stable `effect` `Schema`.
- Query struct field order is wire order.
- Optional fields use `Schema.optionalKey`.
- Use `Schema.Int` or `Schema.Finite`, never `Schema.Number`. Its JSON Schema
  is `anyOf` number or `"Infinity"`/`"-Infinity"`/`"NaN"`.
- A success Schema describes the vendor's envelope leniently, for the manifest
  only.
- The client runs in `response-only` mode. HttpApiClient's own decoding reads
  the whole body with no ceiling (`response.arrayBuffer`). It turns an empty
  200 into `null`, which the success Schema then rejects. Its `SchemaError`
  can also quote the value.
- There is no `HttpApiSecurity`, because it is server middleware.
  Authentication is `GuardedOptions.authenticate`.
- Each vendor declares its documented error envelope once, for the manifest.
  Status meaning stays in code.

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
function list<I extends Input, Row extends Schema.Top>(errors: VendorErrors, spec: Omit<ToolSpec<I, never>, "output" | "run"> & {
  readonly key: string; readonly row: Row; readonly cursor?: "plain" | "bound";
  readonly page: (args: I["Type"], cursor: string | undefined) => Effect.Effect<Page<Row["Type"]>, HttpFailure, CallServices>;
}): ApiTool;                                                                     // output { [key]: Row[], page }
function get<I extends Input, O extends Schema.Top>(errors: VendorErrors, spec: ToolSpec<I, O>): ApiTool;
function read<I extends Input, O extends Schema.Top>(errors: VendorErrors, spec: ToolSpec<I, O> & { readonly review?: string }): ApiTool; // prototyped
function write<I extends Input, O extends Schema.Top>(errors: VendorErrors, spec: ToolSpec<I, O> & {
  readonly destructive: boolean;
  readonly idempotency?: { readonly header: string; readonly key: (args: I["Type"]) => string };
}): ApiTool;
function action<I extends Input, O extends Schema.Top>(errors: VendorErrors, spec: ToolSpec<I, O>): ApiTool;
```

| Builder                       | Verdict     | Annotations                                                                                      |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `list`, `get`, `read`         | read        | `readOnlyHint: true`                                                                             |
| `write({destructive: false})` | write       | `readOnlyHint: false`                                                                            |
| `write({destructive: true})`  | destructive | `readOnlyHint: false, destructiveHint: true`                                                     |
| `action`                      | destructive | `readOnlyHint: false, destructiveHint: true, idempotentHint: false`, for money, mail and refunds |

- **The builder fixes the class.** The method never does, so Breeze's GET
  writes are `write`s. A `read` that sends anything other than GET or HEAD
  must carry `review`, the REST kit's `readPosts` rule made universal. The
  builder puts `review` beside the call's services, and `Send` fails closed
  with a defect when a read sends another method without one.
- **A request inside a write tool counts as the write.** It counts toward
  `Dispatches`, unless the provider marks it `{ effect: "read" }`, an
  auxiliary lookup. The method never decides.
- **Both catalog schemas come from Schemas.** `catalogSchema(schema, mode)`
  renders connecta's dialect:
  - drop the default `additionalProperties: true`;
  - close inputs, and always give the root a `required` list;
  - drop Effect's implicit safe-integer bounds;
  - merge a primitive `anyOf` into a `type` array, but only when each branch's
    keywords apply to its own type alone.

  That is enough for byte-identical Tithe.ly entries. B.4 adds a refusal at
  construction for any check that renders no JSON Schema keyword.

- **Arguments are validated twice.** `api()` validates them against the
  rendered schema first, so agents read the same `invalid_args`. The builder
  then decodes with the Schema. A decode failure is a defect, because the two
  must agree, and `api()` withholds its text (prototyped).
- **`run` is typed by `output`.** A projection that returns untouched rows does
  not compile. The prototype needs one cast to keep Tithe.ly's `raw` flag for
  parity. The argument-dependent output is what B.5 must declare (open
  question 3).

**Paging (`src/http/paging.ts`).** One strategy set, all producing
`Page<Row> = {rows, page: {hasMore, nextCursor}}`:

| Strategy                 | How the next page is found                               | Today in                           |
| ------------------------ | -------------------------------------------------------- | ---------------------------------- |
| `lookahead` (prototyped) | ask for `limit + 1` rows; the cursor is the last kept id | Tithe.ly                           |
| `token`                  | the vendor's `has_more` and next token                   | Stripe, Notion, Cloudflare, Vercel |
| `offset`                 | rows already returned                                    | Breeze, Planning Center            |
| `page`                   | page numbers from body or headers                        | GitHub, CCB, Overflow              |
| `link`                   | the cursor parameter of a confined `next` URL            | Stripe v2, Vercel                  |

- `allRows(fetchPage)` is the `Stream` that programs and the hatch walk.
- **One cursor codec, two modes.** `plain` hands the vendor's cursor through.
  Every shipped list keeps it for its goldens.
- `bound` is base64url of `{v, d, c}`. `d` is 128 bits of SHA-256 over the tool
  name and its arguments, cursor and limit excluded. A cursor from another
  call is `invalid_args`.
- `bound` replaces the five private codecs (Drive, Gmail, Sheets, Forms,
  Slides) when those providers migrate.

**Hatch (`src/http/hatch.ts`).** The hatch is `restTools` on the kit transport,
with an explicit verdict per operation in place of "GET means read, plus
`readPosts`":

```ts
function hatch(options: {
  readonly name: string;                    // tool prefix: <name>_api_search, _details, _read, _write
  readonly index: OperationIndex;           // _shared/rest/operation-index.ts, unchanged
  readonly verdicts: Readonly<Record<`${RestMethod} ${string}`, "read" | "write" | "destructive" | "refuse">>;
  readonly valueSafety: ValueSafety;        // unchanged
  readonly send: GuardedClient;
  readonly errors: VendorErrors;
}): ApiTool[];
```

An operation with no verdict is refused, so Breeze's GET writes need one. The
hatch retires the `_api_get`/`_api_mutate` pairs of Tithe.ly, Breeze, CCB,
Planning Center and Overflow. Each rename is a recorded catalog change in that
provider's Phase C PR.

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
  readonly probe: { readonly operation: Operation; readonly request: unknown; readonly describe: (reply: unknown) => string };
  readonly guide: (options: Readonly<O>) => ProviderGuideInput;
  readonly tools: (kit: { send: Send; pageSize: number; options: Readonly<O> }) => ApiTool[];
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

| INV | Mechanism                                                                                                              | Evidence: existing, then new                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | The builder fixes the class; no method inference; byte-identical catalog                                               | `rest-connector.test.ts` "INV-1: names four tools…"; `connector-read-only.test.ts` "INV-1 INV-2: omits non-read tools…"; `kit-prototype.test.ts` "INV-1"; A.3 `catalog.json`                           |
| 2   | Kit tools are `ApiTool`s; registry enforcement unchanged                                                               | `connector-read-only.test.ts` "INV-2: defaults writable…"                                                                                                                                              |
| 3   | Confinement and `admit` run before credentials; agents name no base or credential                                      | `guarded-fetch.test.ts` confinement suite; `http-kit.test.ts` "INV-3: confines…" and "INV-3 INV-5: admits…"                                                                                            |
| 4   | `Caller` and `Classification` come from admission and the served definition                                            | `mcp-core.test.ts` "INV-4: binds SDK envelope…"; `http-kit.test.ts` B.1 test; B.1 "INV-4: an api() Effect entry…"                                                                                      |
| 5   | Credentials only through services; every sent value registered, form bodies included; key problems refused before send | `sent-secrets.test.ts` "INV-5: api OAuth registers both tokens…"; `request-secret-redaction.test.ts` "INV-5: api handler errors redact…"; `kit-prototype.test.ts` "INV-5" and the credential-echo case |
| 6   | Bounded bytes, `TextDecoder`, errno-only transport facts, withheld handler and decode text                             | `guarded-fetch.test.ts` "INV-6: decodes bounded bytes…"; `http-kit.test.ts` "INV-6"                                                                                                                    |
| 7   | Services live on the call's fiber; the scope closes the state; `fetch` gets the call signal                            | `call-admission.test.ts` "INV-7: stops a retained connector context…"; `kit-prototype.test.ts` "INV-7"; B.1 "INV-7: a context view retained…"                                                          |
| 8   | Catalogs are static; no change                                                                                         | `catalog-cache.test.ts` "INV-8: a missing SQL chunk forces a complete live refresh"                                                                                                                    |
| 9   | Served class, dispatch count and idempotency decide the write outcome; a write is never resent after a 401             | `rest-connector.test.ts` "INV-9: dispatches a write once…"; `program-writes.test.ts` "INV-9: reports write_outcome_unknown…"; `http-kit.test.ts` "INV-9" (three tests); A.3 `failures.json`            |
| 10  | Renewal only inside a call; probes never start authorization                                                           | `api-oauth.test.ts` "INV-10: reports auth_required from status…"                                                                                                                                       |
| 11  | Base URL, ceiling, page size and options checked at construction                                                       | `provider-definition.test.ts` "INV-11: rejects invalid common options before create runs"; `http-kit.test.ts` "INV-11"                                                                                 |
| 12  | `src/http/` is unreachable from the root; area modules confined to three files                                         | `purity.node.test.ts` "keeps the provider kit out of the root graph" and "confines Effect's unstable area modules…" (new)                                                                              |
| 13  | Factories return `Connector`; kit types are internal; the build does not emit the prototype                            | `package-surface.node.test.ts` "INV-13: publishes no Effect type in any reachable declaration"; `check:declarations`                                                                                   |

### Migration order

Each step is one PR. Each must pass `pnpm run check` and match the goldens.

- **B.1.** Adds `src/runtime/call.ts`, invocation's provision and scope
  finalizer, `api()`'s Effect entry and shared core, `contextView`, and the
  one table behind the existing readers. It includes the four tests above.
  Agent-facing output is unchanged.
- **B.2.**
  - Moves `client.ts` and `oauth.ts` out of prototype status.
  - Adds the shared pure module for both transports.
  - Builds `Grant` over `static-oauth.ts`: `token`, `refresh`, and `rejected`
    with its latch. `ctx.oauth.fetch` shares the decision.
- **B.3.** Adds `errors.ts`. The REST kit's failure mappers and A.2's
  `unknownOutcome`/`sendingOnce` move onto `toConnectorCallError`, and vendor
  tables keep their prose.
- **B.4.** Adds `vendor.ts`, `tools.ts` with all five builders, `paging.ts`
  with all five strategies, `json-schema.ts`, `hatch.ts` and `provider.ts`.
  Each comes with a unit suite like `http-kit.test.ts`.
- **B.5.** Moves `src/providers/tithely/` onto the kit:
  - Its tools match `test/goldens/tithely/`. The hatch rename and any `raw`
    change are recorded.
  - `kit-prototype.ts` and its suite are deleted, and `tsconfig.build.json`
    stops excluding `src/http`.
  - The Tithe.ly entry grows by about 122 KB gzip (36,172 B to 158,501 B
    standalone). That is report-only since #899.

### Measured

Builds use esbuild with `scripts/bundle-size.mjs` settings (neutral platform,
minified, gzip -9) on main at `81cdffbc`. Deltas are over `src/index.ts`,
which every deployment imports.

| Bundle                                    | gzip bytes                    |
| ----------------------------------------- | ----------------------------- |
| root                                      | 380,179                       |
| root + today's Tithe.ly (12 tools)        | 389,602 (+9,423)              |
| root + kit modules, no provider           | 496,120 (+115,941)            |
| root + kit + Tithe.ly prototype (2 tools) | 499,753 (+3,633 over the kit) |
| root + guarded client only                | 411,439 (+31,260)             |
| `./providers/tithely` today, standalone   | 36,172                        |
| Tithe.ly prototype entry, standalone      | 158,501                       |

Each piece, added alone to the root:

| Piece                          | gzip bytes |
| ------------------------------ | ---------- |
| `Schema` with JSON Schema      | +65,943    |
| `Schema` and `Stream` (paging) | +90,255    |
| `effect/http` client           | +31,156    |
| `effect/http-api` vendor       | +49,012    |

They share `Schema` and `Stream`, so the set costs about 116 KB, not their
sum. Effect's minified bytes go from 108 KB in the root to 473 KB with the kit.
`examples/worker` imports no provider, so no capped entry moves.

**Lines.** These count non-blank, non-comment code that `get_charge` and
`list_charges` need: transport, failures, paging, schemas, projection and tool
bodies, found with the TypeScript scanner.

- Today: 452 lines. On the kit: 381 (−16%).
- 136 of those lines are identical in both: projection, argument parsing and
  key-pair checks.
- Without the identical lines: 316 → 245 (−22%). Tithe.ly's status prose and
  field descriptions do not shrink, so expect 25–35% for a whole provider like
  it. 0009's 40–45% holds for providers with many list tools and hand-written
  output schemas.
- The kit is 685 code lines. It replaces `guarded-fetch.ts` (358), plus every
  provider's ladder, paging, cursor codec and hand-written output schemas.

### Open questions, with recommendations

1. **Keep HttpApiClient, or encode requests ourselves?** Keep it in
   `response-only` mode, for typed requests and the manifest. If an upgrade
   breaks `vendor.ts`, the fallback is local: about 150 lines of Schema-driven
   path, query and payload encoding behind the same declarations.
2. **Promote every ambiguous write to `write_outcome_unknown`?** Not in B.3.
   That changes an agent-facing code, and 0009 defers such changes to the
   contract phase with evals. Then invocation's `enrich` promotes every
   dispatched write whose `classifyWriteOutcome` is `unknown`.
3. **Tithe.ly's `raw` flag?** A.2 drops sensitive fields from `raw` results
   unless deployment code sets `sensitiveFields: "return"`. B.5 keeps that
   contract and declares `raw` honestly: the output is a union of the
   projection and a record schema, so the catalog shows the bypass. It does
   not hide it behind a cast. Removing `raw` waits for the contract phase.
4. **Render catalog JSON Schema at build time?** Not yet. Rendering runs once
   per connector at construction, and its cost is inside the `Schema` number
   above. Move it to `providers:generate` only if a deployed shape's cap binds.
5. **Default to bound cursors?** Only in the contract phase, with evals.
   Migrated lists keep `plain`.
6. **Keep `guarded-fetch.ts` during Phase C?** Yes, with its pure pieces
   shared (B.2). Making it a facade would charge every unmigrated provider for
   the client before it benefits, and would pull the client toward the root
   through `remote-mcp.ts`.
7. **Enforce stable-only `effect` members outside the three files?** Yes, in
   B.4: a Node-only test resolves each `Schema.*`, `Stream.*` and `Effect.*`
   member that `src/http/` uses to its `@stability` tag in the installed
   `.d.ts`.
8. **Is a write answered 401 refused or unknown?** Both readings refuse to
   resend it. `classifyWriteOutcome` and Google's transport treat a 401 as a
   refusal; A.2 reports an unknown outcome, because a server may act before it
   checks the token. Keep A.2's: the agent checks the target before
   repeating, at the cost of one read. The verdict lives in `refreshOnce`
   alone, so a different answer from A.2's review changes one line.

## Consequences

- **Provider authors write declarations.** A provider becomes operations, a
  status table, Schemas and projections. Error, paging, write-outcome,
  redirect, ceiling and secret rules come from the kit and cannot be skipped.
- **Call state stops depending on object identity.** Kit tools receive
  services on a fiber. The Promise view keeps one table until `remoteMcp()`
  moves.
- **The kit is internal until a later decision publishes it** (0009). Custom
  `api()` handlers and published declarations do not change (INV-13).
- **Deployments pay about 116 KB gzip once,** when they configure their first
  kit provider. The root does not change, and the purity suite holds that.
- **Reconsider if** an effect upgrade forces changes beyond `client.ts`,
  `oauth.ts` and `vendor.ts`, or a migrated provider cannot match its goldens
  without a new kit primitive. Either way, that provider stays on the old
  path until the kit grows the primitive.
