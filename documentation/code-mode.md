# Code mode — the guest API contract

This is the normative description of what a program written for `execute_code`
is promised: what it can reach, what it gets back, how failures look, what it
may retry, what bounds it runs under, and what its execution leaves behind in
the activity surface. It is the interface a model actually programs against, so
it is specified in prose first and implemented second — the same discipline the
[MCP spec bump](https://github.com/zackbart/connecta/blob/main/records/mcp-2026-07-28.md) followed.

Two executors implement this document: QuickJS in a child process on Node, and
`DynamicWorkerExecutor` from `@cloudflare/codemode` on Workers. Divergence between
them is a bug unless it appears in [Executor exceptions](#executor-exceptions),
which names the reason. Anyone can implement a third from this document alone.

The [code-first exploration](https://github.com/zackbart/connecta/blob/main/records/code-first-exploration.md) is the evidence behind
the direction; [`ethos.md`](../ethos.md) carries the verdicts. Where its prototype
and this document disagree, this document wins. Clause identifiers (`A1`, `E3`, …)
are stable and cited by the tests in [Verification](#verification).

## Deploy-time capability

The `executor` passed to `createConnecta()` is required. `tools/list` is exactly
seven — `execute_code`, `search_tools`, `call_tool`, `call_destructive_tool`,
`authorize_connector`, `get_result`, and `skills`. Construction fails when the
executor is missing, and the removed `surface` option is rejected rather than
ignored ([#273](https://github.com/zackbart/connecta/issues/273)).

On Node, install the optional `quickjs-emscripten` peer and use the package's
QuickJS subpath:

```ts
import { createConnecta } from "@zackbart/connecta";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

const connecta = createConnecta({
  executor: quickJsExecutor(),
  // connectors, auth, storage…
});
```

`quickJsExecutor()` runs each program in a disposable child-process sandbox; its
CPU, wall-time, memory, stack, queue, result, log, and IPC bounds are configured
on the executor. Server bundlers must keep the `@zackbart/connecta/quickjs`
package files external so the child entry stays on disk. The
[Node template](../templates/node/README.md) carries the complete setup.

On Cloudflare Workers, the Worker Loader binding provides the required sandbox:

```ts
createConnecta({
  executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
  // connectors, auth, storage…
});
```

Dynamic Workers require the Workers Paid plan. The supported constructor passes only `loader`; `bindings`, `modules`, or
`globalOutbound` grant ambient guest authority and violate `P2`. The [Worker example](../examples/worker/README.md#code-mode) carries the full setup.

## What an executor must implement

The host side of the seam is two types in `src/types.ts` and nothing else.

```ts
interface Executor {
  readonly name?: string;                       // what /health and doctor report
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
  close?(): void | Promise<void>;
}

interface ExecutorProvider {
  name: string;                                              // a global's name
  fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
  prelude?: string;                       // host-authored guest code, not model input
}

interface ExecuteResult {
  result: unknown;      // the program's resolved value
  error?: string;       // set instead of result when the run failed
  logs?: string[];      // captured console output, in call order
}
```

Connecta passes exactly one provider, named `connecta`. An executor must:

1. **Expose each provider as a guest global** whose properties are its `fns`,
   called with the program's arguments and awaited. Connecta supplies `search`,
   `describe`, `call`, and `emit`.
2. **Evaluate `prelude` after the provider globals exist and before the
   program.** This is trusted host code. Connecta uses it to restore typed host
   errors in the guest without exposing the private error frame.
3. **Marshal values as JSON** in both directions (`P3`), and reject a host call
   whose function is not an own property of `fns` — the guest can ask for
   anything, including inherited members.
4. **Return, never throw, for a failed program**: set `error` to the guest's
   message, leave `result` undefined. `createExecuteTool` reads `error` first and
   matches it back to the failures recorded during the run, which is how an
   uncaught tool failure keeps its type (`E1`).
5. **Capture `console.log`, `console.warn`, and `console.error`** into `logs` in
   call order (`R5`), bounding what it retains.
6. **Bound the guest**: wall clock, memory, stack, and CPU (`L3`, `L5`). Keep
   ambient capabilities within the documented and tested `P2`/`X5` boundary.
7. **Grant no ambient authority of its own.** Never back this with `eval` or
   `node:vm`: the sandbox is a containment layer on top of connecta's boundary,
   not a replacement for it, and every capability arrives through `fns`.

Optionally implement `AdmittingExecutor` (`acquire()` returning a lease whose
`execute` runs once) for bounded admission (`L7`) and `close()` for shutdown;
connecta wraps a plain `Executor` with `withExecutorAdmission` otherwise. The
optional `name` — else a class's constructor name, which a minifier may rewrite
— is what [`/health` and `doctor`](./operations.md#the-cli) report.

Note what is *not* on this list: [emitted output](#emitted-output) asks nothing
of an executor — `connecta.emit` is just another provider function (`M8`).

## The program

**P1.** A program is one JavaScript `async` arrow-function expression. It is
evaluated once and its resolved value is the program's result. Both executors
also accept markdown-fenced code and a bare statement body, and each normalizes
those differently; that leniency is a courtesy to model output, not contract. A
program that is not an async arrow expression may be accepted, rejected, or
reinterpreted, so do not rely on it.

**P2.** The only capabilities in the contract are:

- `connecta.search`, `connecta.describe`, `connecta.call`, `connecta.emit`;
- `console.log`, `console.warn`, `console.error`, captured and returned.

Anything else a runtime happens to expose is outside the portable contract and
must not be used. QuickJS grants none of it. A loader-only Dynamic Worker denies
external egress and filesystem access and keeps its environment maps empty, but
it exposes the globals and runtime builtins described in `X5`.

**P3.** Values cross the host bridge as JSON. Arguments must be
JSON-serializable and results arrive as plain JSON values. A value outside JSON —
a cycle, a `BigInt`, a function, a class instance — never round-trips: it either
ends the run with an error or is converted lossily, executor's choice (`X9`).
Return JSON-shaped data and the question does not arise.

**P4.** Nothing survives an execution. There is no module scope, cache, or scratch storage carried to the next program, and no request-bound object outlives the request that created it. Within one execution, host calls share one downstream request scope. `S9`'s host-owned output observation is catalog metadata, not guest memory: a later program receives no prior value or object, only a labeled field/type schema through discovery.

**P5.** Plain JavaScript only. TypeScript syntax is a syntax error. Portable code
does not import: QuickJS blocks imports, while Dynamic Workers expose the `X5`
runtime modules. Neither executor exposes `require`.

## Addressing

**A1.** A tool has one canonical address, `<connectorId>.<toolName>`, exactly
as discovery returns it. Call it with `connecta.call(address, args)`. Punctuation
is preserved; no JavaScript identifier conversion takes place.

**A2.** Connectors create no guest globals. Connector ids that resemble a
JavaScript builtin, or would collide after sanitization, remain usable through
their canonical addresses. The bounded connector inventory in the tool
description shows canonical ids with bounded configured titles when present.

Clauses A3–A5 belonged to shortcut dispatch and are retired. Clients and stored
programs should follow the [migration guide](./upgrading.md#0230-program-api-pruning).

## The surface

Four functions, all `async`: `search`, `describe`, `call`, and `emit`. Nothing else works: reading any other
property yields a function — the guest namespace is a Proxy, so `typeof
connecta.toString` is `"function"` — but *calling* it fails, because the host
resolves only own members of the provider's `fns`. A program must treat the four
documented functions as the whole surface.

### connecta.search

```js
const page = await connecta.search({
  query: "pipeline run job logs",   // 2–4 distinctive action/object terms
  connector: "ci",                  // load one obvious connector, not every catalog
  safety: "readOnly",               // or "approvalRequired" / "all"
  limit: 8,                         // 1–100, default 8
  offset: 0,
  fullDescriptions: false,
  includeSchemas: "compact",        // or "json"
  includeSchemaKeys: true,          // default true in code mode
});
```

**S1.** Returns one flat page: `{ tools, total, offset, limit, hasMore }`, plus `nextOffset` when more remains and `matchMode: "partial"` when no tool matched every term. Top-level `search_tools` is different: it returns `{ connectors: [{ id, tools }], total, offset, limit, hasMore }`. Complete matches normally precede partial matches, but a partial candidate whose complete normalized tool name occurs in the normalized raw query competes by score; conversational cleanup applies only to scoring terms. Other candidates covering at least two terms fill the page after every complete match; when no complete match exists, the existing any-term fallback remains. Each entry in `tools` carries `address`, `name`, the configured `connectorTitle` when present (normalized whitespace, at most 120 UTF-8 bytes), and — when requested — `description`, `inputSchema`, `outputSchema`, `annotations`, and the connector's `guide`. An output shape learned under `S9` also carries `outputSchemaSource: "observed"`; provider declarations carry no source marker. Tool rows expose neither lexical scores nor per-result coverage. An empty or whitespace-only query browses. Non-empty input with no ASCII lexical terms returns no tools and bounded no-match analysis; mixed input searches with its ASCII terms. Compact shapes omit property prose, put required fields first, and cap each shape at 1,024 UTF-8 bytes. Each enum node gets 256 of those bytes. About three near-cap enum nodes can therefore coexist while leaving the final quarter for surrounding syntax; the unchanged global fallback still applies above 1,024 bytes. A capped enum preserves whole values before `unknown` and an exact omitted-value count, while an empty enum renders as `never`. Either cap carries `inputSchemaTruncated` or `outputSchemaTruncated`; a shape-wide cap remains structurally valid with `unknown` types plus `/* truncated */`. Small enums remain complete. Use `connecta.describe` (or JSON search) for omitted exact constraints.

**S1a.** `connector` loads only the named catalog; omit it only when the integration is ambiguous, because an unscoped search fans out across every configured connector. `safety: "readOnly"` returns exactly the tools available through `connecta.call`; `"approvalRequired"` returns the complementary fail-closed class, including false, missing, and contradictory annotations. Omitted or `"all"` preserves the complete catalog. These filters grant no authority and change no admission decision.

**S2.** A requested object schema carries `inputKeys`, `requiredInputKeys`, and `outputKeys`: the same names the rendered schema shows, ready to check before building arguments. Match inputs, truncation, safety, and outputs, not lexical
rank; search distinct operations separately and use `outputKeys`, not guessed roots. A non-object schema — a union, an array, an
unresolvable `$ref` — carries no lists rather than empty ones, because absent
means "read the schema" where `[]` would claim the tool takes no fields. The
lists come from the same walk that renders the compact schema, so a top-level
`$ref` resolves and an `allOf` composes rather than reporting an empty list
beside a schema that plainly shows fields. A zero-input object keeps `inputKeys:
[]` and `requiredInputKeys: []`; an output object with no declared properties
omits `outputKeys` because it declares no useful inventory. A
truncated schema omits the corresponding key list rather than repeating a
large partial inventory. `search_tools`
carries the same metadata whenever schemas are requested. Code-mode callers
can set `includeSchemaKeys: false` to buy the bytes back.

**S3.** Discovery is bounded and the bounds throw rather than silently shrink: a
`limit` outside 1–100 is `invalid_args`, and a page whose serialized form
exceeds 256,000 bytes is `result_too_large`, each with a hint naming the ways to
ask for less. The thrown error carries the stable `code`, `retryable`, and
`details` fields (`E1`).

### connecta.describe

```js
const one = await connecta.describe({ address: "ci.get_run" });

const { tools } = await connecta.describe({
  addresses: ["ci.get_run", "ci.get_job_logs"],  // ≤ 100
  format: "compact",                             // or "json"
  fullDescriptions: false,
});
```

**S4.** Returns `{ tools }` in order, one entry per address. An unknown address
or failed catalog returns `error` plus typed `errorDetails`: `code`, `message`, and `retryable`. Misses
carry a route-aware `nextAction`; a close miss may add three canonical `suggestions`.
Catalog failures add only `retryAfterMs` when known. One bad address never fails the whole call. Each failed entry clamps its
caller-authored `address` to 512 UTF-8 bytes with an `…` marker. Entry order
correlates a clipped address with its request; successes keep canonical addresses. More than 100
addresses is `invalid_args`; the same 256,000-byte ceiling applies. A success whose output shape came from `S9` carries `outputSchemaSource: "observed"` beside the rendered schema.

### connecta.call

```js
const run = await connecta.call("ci.get_run", { runId: 42 });
```

**S5.** Takes a canonical address and one arguments object; returns the tool's
value already unwrapped. For an MCP connector that means `structuredContent`
when present, otherwise text content JSON-parsed when it parses and the raw text
when it does not; a downstream result flagged `isError` throws. Omitted `args`
is treated as `{}`.

**S6.** Every call goes through the same catalog,
fail-closed read-only predicate, admission, credential containment, timeout
classification, health accounting, and activity recording as an ordinary
meta-tool call. The sandbox is an additional containment layer, not a second
implementation of the boundary, and nothing a program does widens what it can
reach.

### Parallel calls

**S7.** Use `Promise.all` for independent calls when any failure should fail the
program, or `Promise.allSettled` to retain every outcome in input order. Both
use the same per-call admission, host-call budget, deadlines, and activity path
as sequential calls. There is no separate batch size or result contract.

```js
const outcomes = await Promise.allSettled([
  connecta.call("ci.get_run", { runId: 42 }),
  connecta.call("ci.list_jobs", { runId: 42 }),
]);
return outcomes.map((outcome) => outcome.status === "fulfilled"
  ? { ok: true, data: outcome.value }
  : { ok: false, code: outcome.reason.code, message: outcome.reason.message });
```

**S8.** A rejected promise retains the caught error's `code`, `retryable`, and
`details`. Project those fields before returning; an Error object itself is
not a JSON result contract.

**S9.** A successful explicitly read-only call whose provider declared no `outputSchema` passively learns one from the unwrapped result. The observation retains field names and broad JSON types only: no arguments, scalar values, raw results, code, credentials, or errors. Property names may be user-authored. Objects stay open, every field stays optional, and search or describe labels the shape `outputSchemaSource: "observed"` so a model cannot mistake runtime evidence for a provider contract. Later observations merge fields and types in a process-local 256-entry LRU; a provider declaration always wins. Inference stops at depth 6, 128 schema nodes, 48 properties per object, 32 inspected array items, and 128 UTF-8 bytes per property name; `__proto__`, `constructor`, and `prototype` names are discarded. A tool definition over 64 KiB or an observed schema over 16 KiB is ignored. An entry expires after 24 hours and carries the exact serialized tool definition, so a changed catalog entry, process restart, or Worker isolate eviction starts cold. A failed call or failed result-processing step learns nothing, and any observation failure is discarded without changing a successful call. No discovery read, timer, refresh, background job, or storage adapter executes or persists work for this cache: the result-sampling refusal in [#282](https://github.com/zackbart/connecta/issues/282) stands.

### connecta.emit

```js
await connecta.emit({ type: "image", data: shot.data, mimeType: "image/png" });
```

The rich-output channel, delivered after the JSON envelope on success. Its
clauses are [Emitted output](#emitted-output) (`M1`–`M10`).

## Errors

**E1.** There are three error channels. Connecta failures are typed whether caught or uncaught.

| Channel | Shape | Typed? |
| --- | --- | --- |
| A caught Connecta host failure | `Error` with `message`, `code`, `retryable`, and `details` | yes |
| An uncaught **tool or discovery** failure, as the model sees it | `{ error: { code, message, retryable, … } }` with `isError` | yes |
| Program or execution failure (`E5`, `E6`, a bridge bound in `L6`) | error text | no |

Both executor bridges reduce a rejected host call to `new Error(message)`. Connecta restores the typed failure in a trusted prelude with a per-execution authenticated frame (`X11`), without turning the rejection into a returned value.
`message` remains the human text. `code` and `retryable` are the stable branch fields; `details` is the complete host classification. This covers `call`, `search`, `describe`, `emit`, and the host-call budget.
Program-authored errors stay untyped, and code must never parse error prose.

**E2.** The taxonomy: `retryable` is what connecta reports, `Y3` what a program may do.

| Code | Raised when | `retryable` |
| --- | --- | --- |
| `unknown_address` | no connector owns the address | false |
| `unknown_tool` | the connector has no such tool | false |
| `destructive_tool_requires_approval` | the tool is not explicitly read-only | false |
| `auth_required` | the credential is missing, expired, or rejected | false |
| `invalid_args` | arguments or discovery bounds were rejected | false |
| `not_found` | the downstream answered and the resource is not there — the one code that says skip this id rather than stop, raised only where the provider tells absence from a permission gap ([H11](./provider-conventions.md#h11--errors-are-mapped-to-what-the-caller-does-next)) | false |
| `input_required_unsupported` | a downstream asked for mid-call input | false |
| `rate_limited` | the downstream reported a rate limit | true |
| `unavailable` | the downstream is down or unreachable | true |
| `timeout` | the per-call 15-second deadline expired | true |
| `cancelled` | the run ended while this call was in flight (`E5`) | false |
| `connector_call_failed` | anything else the connector threw | per message |
| `catalog_lookup_failed` | the connector's catalog could not be loaded | per cause |
| `result_processing_failed` | the result could not be prepared | per message |
| `result_too_large` | a discovery response exceeded its byte bound | false |
| `budget_exceeded` | the run exhausted a host-call or emitted-output budget | false |

**E3.** `auth_required` carries the same recovery envelope as `call_tool`:
`connector`, `operation`, `recovery` (`oauth`, `operator_config`, or
`unavailable`), `nextAction` naming `authorize_connector`, and a `retry`
sentence. A program cannot recover credentials — only an operator can — so the
right move is to stop and let the failure reach the model.

**E4.** An unannotated, write-capable, or destructive tool stays refused with
`destructive_tool_requires_approval`; `nextAction` carries its canonical address
to `call_destructive_tool`, plus the original arguments when they fit the
512-byte echo budget — whole or not at all, since a clipped copy is a different
call. The model's short `reason` for the human reviewer grants no authority,
never goes downstream, and generated code cannot mint the capability.

**E5.** Failures of the *execution*, not of a call, never appear inside the
guest: admission rejection (`executor_overloaded`, retryable, with
`retryAfterMs`), cancellation (`executor_cancelled`), shutdown
(`executor_closed`), deadline expiry, and sandbox crashes end the run and are
reported to the model as an error result. One seam: a host call still in flight
when the run is cancelled fails with `cancelled`, catchable on the way out but
never worth acting on (`Y3`). When shutdown tears down a program that had
already started, accepted blocks are reported as discarded under `M4`; a failure before execution started carries no discard fields.

**E6.** An error the program raises itself — a `TypeError`, a call to a
`connecta` member that is not a provider function (including an inherited one
like `toString`), a `throw` of its own — ends the run with an error result
carrying that message. It is not typed, because it is not a connector failure.
One precedence rule: connecta recognizes an escaped tool failure by its message —
exactly first, by containment second — so a program that *wraps* a failure's
message in its own text still reports the underlying typed failure. Keeping the
type beats keeping the prose.

**E7.** `retryable` for `unknown_address`, `unknown_tool`, and `destructive_tool_requires_approval` is pinned false, never inferred from an address containing `503`, `429`, or `temporar`. The first two carry `nextAction: { function: "connecta.search", arguments: { query, connector?, includeSchemas: "compact" } }` — the same scoped discovery the top-level record names, keyed to the surface the caller actually has. A program cannot call `search_tools`, so it is never told to. The message, the derived `query`, and a failed describe entry's `address` clamp caller-authored text to 512 UTF-8 bytes with an `…` marker. Those values land in the text content and `structuredContent`, so an invented 50 KB address would otherwise produce a refusal orders of magnitude past the deployment's result cap. A clipped address still identifies the mistake by its position; a short one — the common case — is exact and untagged.

**E8.** A remote MCP tool whose advertised schema rejects the call fails before provider dispatch with `invalid_args`, carrying bounded, value-free `{ path, code, expected }` findings and scoped search recovery keyed `function: "connecta.search"` like every other in-program miss. A declared property reports the schema keyword that failed, never the validator's duplicate `additionalProperties` branch; a truly undeclared property still reports `additionalProperties`. Unsupported schemas pass through; unrecognized provider prose remains `connector_call_failed`.

## Results and projection

**R1 (verdict: projection stays explicit).** A program's return value reaches
the model unchanged except for the size guard in `R2`. Connecta does not
summarize, reshape, or field-select it, and there is no automatic projection
mode. The 93%-byte win the exploration measured came from *program-authored*
projection; a host heuristic would silently drop fields a program deliberately
returned and would be invisible in the transcript. Host-side projection helpers
earn their way in only if [#222](https://github.com/zackbart/connecta/issues/222)
shows programs failing to project on their own.

**R2.** The boundary is 24,000 serialized characters (~6k tokens). A value over
it is replaced by exactly one envelope:

```json
{
  "truncated": true,
  "preview": "…",
  "totalChars": 5242880,
  "hint": "filter/map/slice data inside execute_code and return only what you need"
}
```

The envelope is itself bounded as serialized, so `totalChars` is always the true
size of what the program returned and truncation happens exactly once no matter
how many hops the value takes.

**R3.** Truncation is a *successful* result, not an error: the program ran, and
what came back is the honest report that its answer was too large. The fix is a
program that returns less, which is why the envelope says so.

**R4 (verdict: no result paging for programs).** A truncated program result
carries no `get_result` handle, unlike `call_tool`. `get_result` exists so a model
can page a *downstream payload* it could not shrink; a program can shrink
anything, so paging its result would reward the one behavior code mode exists to
remove — and stashing every unprojected return value would spend the result store
on data nobody asked for.

**R5.** `console.log`, `console.warn`, and `console.error` are captured in call order and returned as a single `logs` string, capped at 4,000 characters with a truncation marker. Logs survive failure — they ride along with the error result, which is what makes them worth writing. How a non-string argument renders is not contract (`X4`).

**R6.** Nothing else is added to a normal program result. Passing `diagnostics: true` adds one request-local, payload-free `diagnostics` block; a program that emitted adds `emitted: N` and its blocks (`M2`). Omitted, `false`, and emit-free are byte-for-byte the ordinary response path. Diagnostics exist so catalog, connector, and executor costs are distinguishable without persisting payloads or charging normal responses ([#247](https://github.com/zackbart/connecta/issues/247)).

**R7.** Timing separates admission, provider setup, total executor wall time, catalog work, and connector work. Catalog and connector values are cumulative, so parallel work can exceed executor wall time. Each used operation kind (`search`, `describe`, `call`) gets one aggregate with count, failures, duration, returned serialized bytes, and catalog/connector time.

**R8.** Diagnostics contain measurements and fixed operation names only: no addresses, arguments, results, code, credentials, logs, or raw errors. Result sizes are numbers, never previews. The collector exists only for the opted-in request; it is not activity, a session, or a stream.

## Emitted output

MCP-native output a return value cannot carry: base64 is not projectable, so a
block that survives intake uncapped (`S5`) must not die at the `R2` exit
guard. The argument and the refused alternatives live in the
[design record](https://github.com/zackbart/connecta/blob/main/records/rich-output-design.md) and `ethos.md`
([#267](https://github.com/zackbart/connecta/issues/267),
[#270](https://github.com/zackbart/connecta/issues/270)).

**M1.** `connecta.emit(block)` accepts exactly one block: `{ type: "text",
text }` or `{ type: "image" | "audio", data /* base64 */, mimeType }`, every
field a string, no extra fields, no `annotations`, no `_meta`, no sugar forms.
An invalid block throws catchably and nothing is accepted — rejected, not
stripped. The refused types are pointers: a guest-minted `resource_link` URI
is a lure a client may dereference.

**M2.** Blocks collect on the host in emission order and are delivered only
with a successful result, appended to `content` after the JSON envelope, which
gains `emitted: N`. A program that never emits produces the byte-for-byte
ordinary response (`R6`). `structuredContent` stays the envelope alone —
emission is presentation, not a second data channel.

**M3.** Return value and emission are independent: `R2` never measures emitted
bytes, a truncated return does not suppress delivered blocks, and blocks do
not shrink the return budget.

**M4.** A failed program delivers no blocks. The error result reports
`emittedDiscarded: N` when N > 0 — a field on the structured envelope, a
trailing line on the plain-text paths — never silently.

**M5.** Two budgets (`ConnectaConfig.execute.maxEmittedBytes` /
`.maxEmittedBlocks`, defaults 4,000,000 serialized bytes and 32 blocks) fail
loudly at the `emit` call, naming the budget and the room remaining; nothing
is partially accepted and prior blocks stand. No `get_result` stash: the
program learns while it can still choose differently. The byte default is a
transport bound, not a context bound — emitted media reaches the model as
media, not base64 text.

**M6.** No provenance is claimed: every emitted block is program output,
trusted exactly as much as the return value. Preservation is re-emission of
the raw downstream block, so `S5`'s uncapped fallthrough is contract.

**M7.** `emit` spends no host-call budget (`L4`); `M5`'s bounds are its only
bounds.

**M8.** Emission asks nothing of an executor: `emit` is a provider function,
blocks cross the guest boundary once as an argument, and `ExecuteResult` is
unchanged — `Executor` stays assignable from `@cloudflare/codemode`'s
`DynamicWorkerExecutor`, and any executor that bridges provider calls gets
emission for free.

**M9.** Request-local and unstreamed: blocks exist only in the finished
response, and `emit` resolving means "accepted," never "delivered."

**M10.** Activity stays payload-free. `diagnostics: true` adds one `emitted`
aggregate — count and serialized bytes, numbers only (`R8`), present only
when something was emitted.

## Retry semantics

**Y1.** Connecta makes one downstream attempt per admitted call, both inside a
program and through either direct-call tool. It never waits and retries on the
caller's behalf. An admission refusal may prevent even that attempt.

**Y2.** A program may retry a caught failure whose `retryable` is true, or a rejected promise whose `reason.retryable` is true (`S8`). Every attempt spends host-call budget, so an unchecked loop converts a transient failure into `budget_exceeded`.

**Y3.** What must never be retried automatically:

- anything with `retryable: false` — a policy refusal, a missing credential, a
  bad address, or malformed arguments will fail identically forever;
- `rate_limited`, immediately. A portable program has no timer, and a
  Dynamic-Worker-only wait would spend the run's wall-clock budget on code that
  fails on QuickJS. Return the failure and let the model, which can wait,
  re-issue with `retryAfterMs` in hand.
- a cancelled or timed-out *execution*: it is already over (`L1`).

**Y4.** A provider's `retryAfterMs` is returned unchanged. The caller decides
whether and when to reissue. A later call receives its own deadline and
admission decision.

## Cancellation and limits

**L1.** Cancellation is not observable inside a program. There is no signal to
poll, no cancellation exception to catch, and no guarantee that a `finally`
block runs — a cancelled QuickJS child is terminated outright. Write programs
that need no cleanup.

**L2.** What cancellation guarantees: in-flight host calls abort, no further host
call is admitted, the admission lease is released, and nothing request-bound
survives the request.

**L3.** Every execution runs under a wall-clock deadline that includes time spent
waiting on host calls. Expiry ends the run with an execution error and no
partial result; the deadline's length is executor configuration (`X1`).

**L4.** Per-execution bounds that are contract, identical in both executors
because connecta enforces them above the sandbox:

| Bound | Value |
| --- | --- |
| Host calls per execution | 20 |
| Deadline per host call | 15 s |
| Discovery page | ≤ 100 tools, ≤ 256,000 serialized bytes |
| `describe` addresses | ≤ 100 |
| `describe` nearby suggestions | ≤ 3 canonical addresses per failed entry |
| Caller text echoed by `describe` recovery | ≤ 512 UTF-8 bytes per field, plus `…` |
| Result | 24,000 serialized characters |
| Logs presented to the model | 4,000 characters |

Exhausting the host-call budget fails that call with non-retryable `budget_exceeded` (`E2`) and a message naming the budget. No connector is reached, and the budget does not refill inside one execution.

**L5.** The guest is memory-, stack-, and CPU-bounded, and a program that
exhausts a bound ends the run with an error instead of degrading the host. The
mechanism is the executor's: QuickJS enforces an explicit heap (64 MiB default),
stack (1 MiB), and guest-CPU budget (250 ms, which host waits do not consume);
the Dynamic Worker inherits the platform isolate's limits (`X2`). A third
executor must bound all three somehow — this is the clause that makes untrusted
code safe to run at all.

**L6.** A host call's serialized arguments and its serialized result are each
bounded — QuickJS caps both at 256 KiB (`X10`) — and exceeding either fails that
call, not the execution, so a program can catch it and ask for less. The failure
is executor-owned untyped text, not a Connecta host failure (`E1`). An over-bound *result* names the address the program
called, rather than only the generic bridge function; an over-bound
*argument* payload is refused before it is parsed, so it names no address at
all — parsing it to write a better message would spend exactly the work the bound
exists to refuse.

**L7.** Executions are admitted, not queued indefinitely: bounded concurrency plus
a bounded queue with a wait timeout. Overload is a retryable `executor_overloaded`
carrying `retryAfterMs`; cancellation and shutdown are terminal. Admission happens
*before* any catalog or provider is built, so a queued request holds no state.

**L8.** Bounds are deployment configuration, not program inputs: a program cannot
raise one by asking. `execute_code`'s description states the host-call budget and the per-call deadline — the ones a program must plan around
before it runs. The result and log caps live here and in the truncation notice
itself (`R2`, `R5`).

## Activity

**V1.** One payload-free activity event per attempted call, with
`source: "execute_code"` — every dispatched call plus every local refusal: a
read-only refusal, an unknown tool, an unloadable
catalog, a missing credential, an exhausted host-call budget, an address no
connector owns. Ten tools called is ten events, as legible as ten `call_tool`
calls — which makes moving work into the sandbox an optimization, not a blindfold.

**V2.** Each event carries `connectorId`, `toolName`, `address`, `source`,
`outcome` (`success`, `error`, `timeout`, `cancelled`), `durationMs`,
`attempts`, and `errorCode` when the call *failed* — plus request, actor, and
server identity. Typed codes derive an optional `friction`: `tool_not_found`,
`schema_retry`, `destructive_reroute`, or `auth_required`. The fifth class,
`result_too_large`, cannot reach an `execute_code` event: it belongs to a
`call_tool` result too large to return inline, and a program's own
return is refused paging by design rather than truncated into friction. There is
nowhere to put arguments, results, program source, or
raw error text; a caught failure is still recorded. `address` is
canonical (`A1`) where a tool resolved, otherwise the name the program used —
the honest record of what was attempted.

**V3.** A call whose connector does not exist is recorded at the address as
written, *provided* it split into the two fields activity keeps — one with no
interior dot records nothing. An invented id is the address mistake an operator
most needs to see. But recording it as written puts caller-authored text in
fields that are otherwise operator- and connector-authored, so `connectorId`
and `toolName` clamp at 128 UTF-8 bytes (`address` at 257) with a `…` marker:
payload-free *by construction* means the event has nowhere to put a payload,
not merely that connecta declines to.

**V4.** The execution itself emits no event. It has no address, and its one
distinctive artifact is the program source, which is exactly what a payload-free
history must never keep.

## Executor exceptions

Documented divergences, with reasons. Everything else must match.

**X1. Deadline default.** QuickJS defaults to 30 s wall clock and terminates the
child; the Dynamic Worker defaults to 60 s and races the program against an
in-isolate timer. Both satisfy `L3`; the numbers are each executor's
configuration and the error text differs.

**X2. Memory, stack, and CPU mechanism.** QuickJS exposes explicit heap, stack,
and guest-CPU limits (`L5`); the Dynamic Worker has no such knobs, so workerd's
isolate limits apply untuned. A specific heap ceiling is a Node-only option.

**X3. Mid-flight cancellation.** The QuickJS pool receives the request's
`AbortSignal` and kills the child. The Dynamic Worker executor's `execute()` takes
no signal, so a cancelled request's program runs on until its host calls fail or
the deadline expires. `L2` holds either way — the calls abort, the response does
not wait — but "the run ends" is best-effort on Workers.

**X4. Log rendering and capture.** QuickJS JSON-stringifies non-string
arguments and captures `log`, `info`, `warn`, `error`, and `debug`; the Dynamic
Worker renders arguments with `String()` (so an object logs as
`[object Object]`) and captures only `log`, `warn`, and `error`, prefixing the
latter two. Only the three captured everywhere are contract (`R5`); rendering is
not.

**X5. Leftover authority.** QuickJS blocks imports and has no `fetch`, `process`, timers, `crypto`, or `WebSocket`. Its Node child starts with an explicitly empty process environment rather than inheriting deployment variables or `NODE_OPTIONS`. A Dynamic Worker has those globals plus a non-contract set of runtime builtins through `import()` and `process.getBuiltinModule()`, including `node:path`, `node:crypto`, `node:net`, `node:tls`, `node:dns`, `node:module`, and `cloudflare:workers`. The upstream set can drift; this list is not an allowlist.
The supported Worker construction is exactly `new DynamicWorkerExecutor({ loader })`. Do not pass `bindings`, `modules`, or `globalOutbound`: each can grant ambient configuration, code, or egress. Under it, `process.env`, lexical `this.env`, and `cloudflare:workers.env` are empty; `node:fs`, `node:http`, and `node:https` are unavailable through either access route; external `fetch`, `WebSocket`, `node:net`, and `node:tls` fail with workerd's outbound-denial error; DNS lookup ends unresolved; and `fetch("data:...")` resolves locally.
`P2` is the portable contract. Programs use none of this runtime-only authority, including timers and `crypto`, because the same code fails on QuickJS. The `execute_code` description and served `usage` skill say so before an agent writes code.

**X6. Stall detection.** QuickJS notices a program awaiting something that can
never settle and fails fast; the Dynamic Worker waits for its deadline. The fast
failure is better, but requiring it would require a host-driven job loop — not a
reasonable demand on a platform sandbox.

**X7. Value codec.** QuickJS is JSON-only; `@cloudflare/codemode` tunnels binary
values through a tagged envelope, so a `Uint8Array` may survive there. `P3` is the
contract: JSON-serializable values, or the program is Workers-only.

**X8. Unknown-property message.** An unknown `connecta` property throws
`Unknown function connecta.x` on QuickJS and `Tool "x" not found` on the Dynamic
Worker. Both satisfy `E6`; the text is not contract.

**X9. Refusing a value outside JSON.** The Dynamic Worker ends the run with an
error when a program returns something its codec cannot carry. QuickJS converts
lossily instead — a cyclic object comes back as the string `"[object Object]"`,
because the guest-to-host dump happens before any serializer can object.
Normalizing this would mean walking every returned value in the child for
JSON-representability, spending real CPU on every program to improve the error
message of a program that is already wrong. `P3` is the contract: neither
behavior returns the value.

**X10. Per-host-call payload bound.** `L6`'s 256 KiB ceiling on a host call's
arguments and result is QuickJS's, enforced at its IPC boundary. The Dynamic
Worker has no documented equivalent; Workers RPC limits apply and connecta does
not add one, because the boundary there is an isolate-to-isolate call rather than
a `process.send` with a hard ceiling. A program that returns a quarter-megabyte
from one tool call therefore fails on Node and may succeed on Workers — reduce
inside the program either way (`R1`).

**X11. Typed host rejection.** Both executors rebuild Connecta's authenticated host-failure frame as a thrown guest `Error` (`E1`). The per-run secret stays in the trusted prelude closure, and the prelude locks `globalThis.Error`, so guest code and connector prose cannot forge the host transport frame.
The human message is unchanged; a mismatched frame is ordinary untyped prose.

## Changes from earlier code mode

MCP Apps rendering, connector shortcut globals, and `connecta.batch` are
removed. Direct calls also lose automatic retries. The seven top-level tools,
read-only boundary, JSON projection, and emitted media remain. See the
[migration guide](./upgrading.md#0230-program-api-pruning).

## Verification

Every clause has a test. `test/guest-contract-cases.ts` holds the case table,
written once and run twice: `test/guest-api-contract-quickjs.test.ts` runs it on
the Node QuickJS executor, and `test/guest-api-contract.test.ts` runs it on a real
`DynamicWorkerExecutor` in workerd — a Miniflare Worker Loader binding makes that
arm real rather than simulated — alongside the clauses connecta enforces above any
executor. Rows naming `test/guest-api-contract.test.ts` are covered by both arms,
and each case's title carries its clauses. Two arms passing one table is also the
check on the executor duties above, with `test/codemode-compat.test.ts` holding
the upstream `Executor` shape assignable.

| Clauses | Test |
| --- | --- |
| `P1`, `P5` | `test/guest-api-contract.test.ts` (TypeScript syntax), `test/quickjs-executor.test.ts` (`normalizeCode`) |
| `P2`, `X5` | `test/guest-api-contract.test.ts` (Dynamic globals plus loader-only filesystem, HTTP, environment, egress, DNS, and local `data:` boundaries), `test/guest-api-contract-quickjs.test.ts` (exact absent globals and blocked imports), `test/quickjs-child-stderr.test.ts` (empty child-process environment), `test/deployment-shapes.test.ts` (loader-only Worker construction) |
| `P3`, `X9` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` |
| `P4` | `test/guest-api-contract.test.ts` (no cross-run leakage), `test/execute.test.ts` (one catalog load per connector per execution) |
| `A1`, `A2` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (canonical addressing), `test/server.test.ts` (bounded live connector inventory) |
| `S1`, `S2` | `test/guest-api-contract.test.ts` (flat page, connector guides, schema keys, and the unfiltered browse that replaces `list_connectors`), `test/execute.test.ts` (guide pagination/partial/no-match behavior and `$ref`/`allOf`), `test/meta-tools.test.ts` (mixed complete/partial ranking and stable pagination) |
| `S3` | `test/guest-api-contract.test.ts` (typed uncaught bound), `test/execute.test.ts` (count limits, fan-out bound) |
| `S4` | both guest-contract executors (ordered mixed describe results with unknown-address, unknown-tool suggestion, and catalog-failure details), `test/meta-tools.test.ts` (top-level routing, no-suggestion, catalog-failure, and hostile-input bounds) |
| `S5` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`unwrapMcpResult`) |
| `S6` | `test/execute.test.ts` (fail-closed annotations, activity parity) |
| `S7` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (parallel calls and shared admission) |
| `S8`, `E1`, `X11` | both guest-contract executors (caught call, discovery, utility, budget, removed-function, and forgery cases; typed promise rejections) |
| `S9` | `test/result-shapes.test.ts` (value exclusion, bounds, merging, LRU and time expiry, runtime isolation, read-only admission, declared precedence, definition invalidation, unwrapped MCP results, discovery provenance, copy isolation, and failure isolation) |
| `E2`, `E8` | `test/guest-api-contract.test.ts` (code → `retryable`, caught, parallel, and uncaught validation recovery), `test/meta-tools.test.ts` (direct, destructive, provider fallback), `test/validate.test.ts` (bounded payload-free findings), `test/errors.test.ts` |
| `E3` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`auth_required`) |
| `E4` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (destructive) |
| `E5` | `test/guest-api-contract.test.ts` (execution-failure channel, in-flight `cancelled`), `test/execute.test.ts` (admission), `test/executor-admission.test.ts`, `test/quickjs-executor.test.ts` (mid-run shutdown) |
| `E6`, `X8` | `test/guest-api-contract.test.ts` (unknown and inherited members, wrapped-message precedence), `test/quickjs-executor.test.ts` |
| `E7` | `test/guest-api-contract.test.ts` (refusals about a `503`-named connector), `test/errors.test.ts` |
| `R1`, `R3` | `test/guest-api-contract.test.ts` (pass-through, truncation is success) |
| `R2` | `test/guest-api-contract.test.ts` (envelope fits the cap, idempotent) |
| `R4` | verdict; `R2` is its enforcement |
| `R5` | `test/guest-api-contract.test.ts`, `test/quickjs-log-limits.test.ts` |
| `R6`–`R8` | `test/guest-api-contract.test.ts` (normal result keys), `test/execute.test.ts` (opt-in operation aggregates, failure paths, payload exclusion) |
| `Y1` | `test/guest-api-contract.test.ts` (one attempt per call) |
| `Y2`, `Y3` | `test/guest-api-contract.test.ts` (retryable flags by code) |
| `Y4` | `test/meta-tools-call.test.ts`, `test/call-admission.test.ts` (one attempt, retry hints, caller reissue) |
| `L1`, `L2` | `test/guest-api-contract.test.ts` (in-flight call fails `cancelled`), `test/execute.test.ts` (cancels outstanding host calls) |
| `L3`, `X1` | `test/guest-api-contract.test.ts` (short-deadline executors) |
| `L4`, `L8` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (budgets) |
| `L5`, `X2` | `test/quickjs-executor.test.ts` (CPU, heap) |
| `L6`, `X10` | `test/quickjs-executor.test.ts` (bridge and IPC bounds for arguments and result; the address in the over-bound message) |
| `L7` | `test/execute.test.ts`, `test/executor-admission.test.ts` |
| `V1`–`V4` | `test/guest-api-contract.test.ts` (dispatched calls, every refusal class including an address no connector owns, the friction each derives, no event for the execution itself), `test/activity.test.ts` (the shared code → friction table, and the identity clamp) |
| `M1` | `test/guest-api-contract.test.ts` (invalid emits throw catchably, accept nothing), `test/execute-emit.test.ts` (every rejected shape) |
| `M2`, `M3` | `test/guest-api-contract.test.ts` (delivery order, truncated return plus delivered blocks), `test/execute-emit.test.ts` (envelope, `structuredContent`, byte-for-byte no-emit path) |
| `M4` | `test/guest-api-contract.test.ts` (discard is visible), `test/execute-emit.test.ts` (structured and plain paths), `test/quickjs-executor.test.ts` (mid-run shutdown) |
| `M5`, `M7` | `test/execute-emit.test.ts` (both budgets fail the crossing block; host-call budget untouched) |
| `M6`, `M9` | verdicts; `M1`'s strict typing and `M2`'s collect-then-deliver are their enforcement |
| `M8` | two arms passing one case table, `test/codemode-compat.test.ts` |
| `M10` | `test/execute-emit.test.ts` (aggregate present, numbers only, absent when nothing emitted) |
| `X3` | `test/quickjs-executor.test.ts` (cancels a running child) |
| `X4` | `test/guest-api-contract.test.ts` (string logs only) |
| `X6` | `test/quickjs-executor.test.ts` (never-settling await) |
| `X7` | `P3`'s tests; the Workers superset is deliberately unused |

The surface itself is checked by `test/server.test.ts` (the exact seven-tool list)
and `test/code-first-surface.test.ts` (the fold's construction rules, the
required executor, the refusals a removed top-level tool now gets, copy, and
measured size). The small whole-agent benchmark checks both read routes, provider semantics, and private pagination:

```sh
npm --prefix eval/current-version run benchmark
```
