# Code mode — the guest API contract

This is the normative description of what a program written for `execute_code`
is promised: what it can reach, what it gets back, how failures look, what it
may retry, what bounds it runs under, and what its execution leaves behind in
the activity surface. It is the interface a model actually programs against, so
it is specified in prose first and implemented second — the same discipline the
[MCP spec bump](./mcp-2026-07-28.md) followed.

Two executors implement this document: QuickJS in a child process on Node, and
`DynamicWorkerExecutor` from `@cloudflare/codemode` on Workers. Divergence
between them is a bug unless it appears in
[Executor exceptions](#executor-exceptions), which names the reason. Anyone can
implement a third executor from this document without reading either.

The [code-first exploration](./code-first-exploration.md) is the evidence behind
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
[Node example](../examples/node/README.md) carries the complete setup.

On Cloudflare Workers, the Worker Loader binding provides the required sandbox:

```ts
createConnecta({
  executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
  // connectors, auth, storage…
});
```

Dynamic Workers require the Workers Paid plan. The
[Worker example](../examples/worker/README.md#code-mode) carries the complete
required binding and package setup.

## What an executor must implement

The host side of the seam is two types in `src/types.ts` and nothing else.

```ts
interface Executor {
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
   called with the program's arguments and awaited. Connecta's provider carries
   `search`, `describe`, `call`, `batch`, `emit`, and `__callNamespace` — see
   point 3.
2. **Evaluate `prelude` after the provider globals exist and before the
   program**, in a scope where those globals are reachable. It is host-authored
   trusted code, never model input, and skipping it is not an option: connecta's
   prelude is what installs the lazy connector shortcuts.
3. **Let the prelude reach the provider.** That prelude
   (`lazyNamespacePrelude` in `src/execute.ts`) assigns one
   `globalThis[<connectorId>]` Proxy per connector, each forwarding to
   `connecta.__callNamespace(connectorId, toolName, args)`. An executor exposing
   only the four documented functions leaves every shortcut dead and breaks `A2`.
4. **Marshal values as JSON** in both directions (`P3`), and reject a host call
   whose function is not an own property of `fns` — the guest can ask for
   anything, including inherited members.
5. **Return, never throw, for a failed program**: set `error` to the guest's
   message, leave `result` undefined. `createExecuteTool` reads `error` first and
   matches it back to the failures recorded during the run, which is how an
   uncaught tool failure keeps its type (`E1`).
6. **Capture `console.log`, `console.warn`, and `console.error`** into `logs` in
   call order (`R5`), bounding what it retains.
7. **Bound the guest**: wall clock, memory, stack, and CPU (`L3`, `L5`), with no
   network, filesystem, environment, or import capability (`P2`).
8. **Grant no ambient authority of its own.** Never back this with `eval` or
   `node:vm`: the sandbox is a containment layer on top of connecta's boundary,
   not a replacement for it, and every capability arrives through `fns`.

Optionally implement `AdmittingExecutor` (`acquire()` returning a lease whose
`execute` runs once) for bounded admission (`L7`) and `close()` for shutdown;
connecta wraps a plain `Executor` with `withExecutorAdmission` otherwise.

Note what is *not* on this list: [emitted output](#emitted-output) asks
nothing of an executor — `connecta.emit` is just another provider function
(`M8`).

## The program

**P1.** A program is one JavaScript `async` arrow-function expression. It is
evaluated once and its resolved value is the program's result. Both executors
also accept markdown-fenced code and a bare statement body, and each normalizes
those differently; that leniency is a courtesy to model output, not contract. A
program that is not an async arrow expression may be accepted, rejected, or
reinterpreted, so do not rely on it.

**P2.** The only capabilities in the contract are:

- one lazy global per connector (see [Addressing](#addressing));
- `connecta.search`, `connecta.describe`, `connecta.call`, `connecta.batch`;
- `console.log`, `console.warn`, `console.error`, captured and returned.

`connecta` also carries the `__`-prefixed dispatcher the shortcut prelude uses.
It is host plumbing, callable but not contract: it takes a connector id and an
unsanitized-or-sanitized tool name and can change shape without notice.

Anything else a runtime happens to expose is outside the contract and must not
be used, even where it exists. Neither executor grants network egress,
filesystem access, credentials, or deployment configuration; what they leave
lying around otherwise differs (`X5`).

**P3.** Values cross the host bridge as JSON. Arguments must be
JSON-serializable and results arrive as plain JSON values. A value outside JSON —
a cycle, a `BigInt`, a function, a class instance — never round-trips: it either
ends the run with an error or is converted lossily, executor's choice (`X9`).
Return JSON-shaped data and the question does not arise.

**P4.** Nothing survives an execution. There is no module scope, cache, or
scratch storage carried to the next program, and no request-bound object outlives
the request that created it. Within one execution, host calls share one
downstream request scope.

**P5.** Plain JavaScript only. TypeScript syntax is a syntax error, and there is
no `import` or `require` to reach for.

## Addressing

**A1.** The canonical address `<connectorId>.<toolName>` — byte-for-byte what
`search_tools` and `connecta.search` print — is always callable through
`connecta.call` and `connecta.batch`. This is never optional and never
sanitized. It is what prevents sanitized-name collisions and what gives a
generated program a stable escape hatch when a shortcut is ambiguous, absent, or
wrong. A program that can only reach a tool through a convenience name is one
rename away from broken.

**A2.** Shortcut namespaces are sugar over `A1`: every connector gets one lazy
global whose properties are its tools, so `<connectorId>.<toolName>(args)` works
with both parts sanitized into JavaScript identifiers — characters outside
`[A-Za-z0-9_$]` become `_`, a leading digit gets `_` prefixed, and a reserved
word gets `_` appended (`my-service.get.thing` → `my_service.get_thing`). The
globals are lazy: no catalog is fetched until a program touches one.

**A3.** A shortcut that resolves to more than one tool fails closed with
`ambiguous_tool_alias`, naming the colliding tool names and pointing at
`connecta.call`. It never picks one. The canonical addresses of both tools
remain callable.

**A4.** A deployment whose connector ids collide with each other after
sanitization, or that sanitize onto a name the sandbox reserves, fails *every*
`execute_code` request with an error naming the offending ids. Failing loudly on
the deployment's mistake beats silently answering from whichever connector
sorted first.

**A5 (verdict: shortcut namespaces are kept, and frozen).** They cost nothing to
keep, a working ergonomic surface should not be removed mid-arc, and the
exploration's cold-start sample used them naturally. Frozen means no typed method
lists, no per-tool closures, no generated `.d.ts`, no second sanitization rule —
every expansion invents a collision class the addressing in `A1` already solves.
The default has since flipped without revisiting them
([#224](https://github.com/zackbart/connecta/issues/224)), so evidence rather
than a gate would take them away: if programs reach for `connecta.call` anyway,
or shortcut ambiguity shows up in failures, they lose.

## The surface

Four functions, all `async`, plus the host-internal `__`-prefixed dispatcher
(`P2`) that is callable but not contract. Nothing else works: reading any other
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

**S1.** Returns one flat page: `{ tools, total, offset, limit, hasMore }`, plus `nextOffset` when more remains and `matchMode: "partial"` when no tool matched every term. Top-level `search_tools` is different: it returns `{ connectors: [{ id, tools }], total, offset, limit, hasMore }`. Complete matches normally precede partial matches, but a partial candidate whose complete normalized tool name occurs in the normalized raw query competes by score; conversational cleanup applies only to scoring terms. Other candidates covering at least two terms fill the remaining page after every complete match; when no complete match exists, the existing any-term fallback remains. Each entry in `tools` carries `address`, `name`, and — when requested — `description`, `inputSchema`, `outputSchema`, `annotations`, and the connector's `guide`. A non-empty search page ends with `queryCoverage` after the complete rows and pagination metadata. Its ordered `terms` table appears once; `entries` has one item per returned row in the same order, carrying its canonical `address` and optional `name`, description-only `description`, and `unmatched` term indexes. Empty arrays are omitted, and duplicate addresses remain separate entries. The table covers at most eight terms of at most 64 Unicode code points, and `truncated: true` marks clipped coverage; no score is exposed. The table and indexes stay stable across pages. Tool rows remain identical to coverage-off. An empty or whitespace-only query browses and omits the whole block. Non-empty input with no ASCII lexical terms returns no tools, empty coverage arrays, and bounded no-match analysis; mixed input searches with its ASCII terms. Compact shapes omit property prose, put required fields first, and cap each shape at 1,024 UTF-8 bytes. Each enum node gets 256 of those bytes. About three near-cap enum nodes can therefore coexist while leaving the final quarter for surrounding syntax; the unchanged global fallback still applies above 1,024 bytes. A large enum keeps whole values before `unknown` and an exact omitted-value count, while an empty enum renders as `never`. Either cap carries `inputSchemaTruncated` or `outputSchemaTruncated`; a shape-wide cap remains structurally valid with `unknown` types plus `/* truncated */`. Small enums remain complete. Use `connecta.describe` (or JSON search) for omitted exact constraints.

**S1a.** `connector` loads only the named catalog; omit it only when the integration is ambiguous, because an unscoped search fans out across every configured connector. `safety: "readOnly"` returns exactly the tools available through `connecta.call`, connector shortcuts, and `connecta.batch`; `"approvalRequired"` returns the complementary fail-closed class, including false, missing, and contradictory annotations. Omitted or `"all"` preserves the complete catalog. These filters grant no authority and change no admission decision.

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
ask for less. As with every failure, the *thrown* error carries only the message
(`E1`); the code appears when the failure escapes the program uncaught.

### connecta.describe

```js
const one = await connecta.describe({ address: "ci.get_run" });

const { tools } = await connecta.describe({
  addresses: ["ci.get_run", "ci.get_job_logs"],  // ≤ 100
  format: "compact",                             // or "json"
  fullDescriptions: false,
});
```

**S4.** Returns `{ tools }` in the order asked, one entry per address. An
address that is unknown, or whose connector's catalog could not be loaded,
returns an entry carrying `error` — one bad address never fails the whole call.
More than 100 addresses is `invalid_args`; the same 256,000-byte ceiling applies.

### connecta.call

```js
const run = await connecta.call("ci.get_run", { runId: 42 });
```

**S5.** Takes a canonical address and one arguments object; returns the tool's
value already unwrapped. For an MCP connector that means `structuredContent`
when present, otherwise text content JSON-parsed when it parses and the raw text
when it does not; a downstream result flagged `isError` throws. Omitted `args`
is treated as `{}`.

**S6.** Every call — canonical or shortcut — goes through the same catalog,
fail-closed read-only predicate, admission, credential containment, timeout
classification, health accounting, and activity recording as an ordinary
meta-tool call. The sandbox is an additional containment layer, not a second
implementation of the boundary, and nothing a program does widens what it can
reach.

### connecta.batch

```js
const outcomes = await connecta.batch([
  { address: "ci.get_run", args: { runId: 42 } },
  { address: "ci.list_jobs", args: { runId: 42 } },
]);
```

**S7.** Runs 1–10 independent calls in parallel and returns their outcomes in
order. A success is `{ address, ok: true, data }`. A failure is
`{ address, ok: false, error, errorDetails }`, where `error` is the message and
`errorDetails` is the typed object described in [Errors](#errors) — the same two
field names the host's internal batch path uses. One failing call never rejects
the batch, and more than ten calls throws.

**S8.** `connecta.batch` is the classification channel: because a thrown host
error crosses the bridge as a bare message (`E1`), a batch of one is the supported
way for a program to *decide* something about a failure rather than report it.

### connecta.emit

```js
await connecta.emit({ type: "image", data: shot.data, mimeType: "image/png" });
```

The rich-output channel, delivered after the JSON envelope on success. Its
clauses are [Emitted output](#emitted-output) (`M1`–`M10`).

## Errors

**E1.** There are four error channels, and only two of them are typed.

| Channel | Shape | Typed? |
| --- | --- | --- |
| A throw inside the program | `Error` with `message` only | no |
| `connecta.batch` outcome | `{ ok: false, error, errorDetails }` | yes |
| An uncaught **tool or discovery** failure, as the model sees it | `{ error: { code, message, retryable, … } }` with `isError` | yes |
| Anything else that ends the run (`E5`, `E6`, a bridge bound in `L6`) | error text | no |

The message-only throw is a hard limit of the guest bridge: both executors reduce a rejected
host call to `new Error(message)`, dropping every own property. A program must
therefore never branch on an error's fields and never parse its message. To
classify, use `errorDetails`; to hand a failure to the model with its type
intact, let it escape uncaught — connecta re-attaches the typed details on the
way out. The model-facing version of this lives in `execute_code`'s description,
not in the always-loaded usage skill, which `test/meta-tools.test.ts` caps at
2,500 bytes — a budget the guide already spends nearly all of, so new text there
displaces old rather than adding to what every request pays for.

**E2.** The taxonomy. `retryable` is what connecta reports; `Y3` says what a
program may do about it.

| Code | Raised when | `retryable` |
| --- | --- | --- |
| `unknown_address` | no connector owns the address | false |
| `unknown_tool` | the connector has no such tool | false |
| `ambiguous_tool_alias` | a shortcut matches two tools (`A3`) | false |
| `destructive_tool_requires_approval` | the tool is not explicitly read-only | false |
| `auth_required` | the credential is missing, expired, or rejected | false |
| `invalid_args` | arguments or discovery bounds were rejected | false |
| `input_required_unsupported` | a downstream asked for mid-call input | false |
| `rate_limited` | the downstream reported a rate limit | true |
| `unavailable` | the downstream is down or unreachable | true |
| `timeout` | the per-call 15-second deadline expired | true |
| `cancelled` | the run ended while this call was in flight (`E5`) | false |
| `connector_call_failed` | anything else the connector threw, and the host-call budget (`L4`) | per message |
| `batch_call_failed` | a `connecta.batch` entry connecta could not even attempt | per message |
| `catalog_lookup_failed` | the connector's catalog could not be loaded | per cause |
| `result_processing_failed` | the result could not be prepared | per message |

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
already started, accepted blocks and UI are reported as discarded under `M4`
and `U3`; a failure before execution started carries no discard fields.

**E6.** An error the program raises itself — a `TypeError`, a call to a
`connecta` member that is not a provider function (including an inherited one
like `toString`), a `throw` of its own — ends the run with an error result
carrying that message. It is not typed, because it is not a connector failure.
One precedence rule: connecta recognizes an escaped tool failure by its message —
exactly first, by containment second — so a program that *wraps* a failure's
message in its own text still reports the underlying typed failure. Keeping the
type beats keeping the prose.

**E7.** `retryable` for `unknown_address`, `unknown_tool`, `ambiguous_tool_alias`, and `destructive_tool_requires_approval` is pinned false, never inferred from an address containing `503`, `429`, or `temporar`. The first two carry `nextAction: { function: "connecta.search", arguments: { query, connector?, includeSchemas: "compact" } }` — the same scoped discovery the top-level record names, keyed to the surface the caller actually has. A program cannot call `search_tools`, so it is never told to. Both the message and the derived `query` clamp the address to 512 UTF-8 bytes with a `…` marker: the address is caller-authored and lands in the message, the query, the text content, and `structuredContent`, so an invented 50 KB one would otherwise produce a refusal orders of magnitude past the deployment's result cap. A clipped address still identifies the mistake; a short one — the common case — is exact and untagged.

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

**R6.** Nothing else is added to a normal program result. Passing `diagnostics: true` adds one request-local, payload-free `diagnostics` block; a program that emitted adds `emitted: N` and its blocks (`M2`). Omitted, `false`, and emit-free are byte-for-byte the ordinary response path.

**R7.** Timing separates admission, provider setup, total executor wall time, catalog work, and connector work. Catalog and connector values are cumulative, so parallel work can exceed executor wall time. Each used operation kind (`search`, `describe`, `call`, `batch`) gets one aggregate with count, failures, duration, returned serialized bytes, and catalog/connector time; batch adds only its total child count.

**R8.** Diagnostics contain measurements and fixed operation names only: no addresses, arguments, results, code, credentials, logs, or raw errors. Result sizes are numbers, never previews. The collector exists only for the opted-in request; it is not activity, a session, or a stream.

## Emitted output

MCP-native output a return value cannot carry: base64 is not projectable, so a
block that survives intake uncapped (`S5`) must not die at the `R2` exit
guard. The argument and the refused alternatives live in the
[design record](./rich-output-design.md) and `ethos.md`
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

## Rendered output

`connecta.emit` gave programs pixels; it did not give them a *view*. This is the
one the human looks at directly while the model keeps its cheap textual summary:
one MCP Apps view per successful run, assembled where composition already
happens. Programs supply HTML content and nothing else — the only `ui://` URI in
the system is connecta's build-time shell, so nothing a client could dereference
is derived from anything a program said. The argument, the refused shapes, and
the security posture live in the [design record](./mcp-ui-design.md)
([#266](https://github.com/zackbart/connecta/issues/266),
[#277](https://github.com/zackbart/connecta/issues/277)); this section is the
contract, and it wins where the two disagree.

**U1.** `connecta.ui(html, options?)` accepts one non-empty HTML string and at
most the bounded read manifest `V1` defines. The one-argument call stays
display-only; every other shape throws catchably and accepts nothing.

**U2.** At most one payload per run. A second call throws catchably, naming the
constraint; the first accepted payload stands. One tool result renders one view,
and last-wins would silently discard a payload the program deliberately
supplied.

**U3.** Delivered on success only, and out of model context: the tool result
gains `_meta["connecta/ui"] = { html, reads? }` and the JSON envelope gains `ui: true`,
so the model learns a view rendered without seeing its bytes. `structuredContent`
stays the envelope alone. The single-label `connecta/ui` prefix is deliberate —
connecta has no domain to reverse, and fabricating one to satisfy MCP's
reverse-DNS SHOULD would be a worse answer than the shape the key format's MUST
already permits. A program that never calls `connecta.ui` produces the
byte-for-byte ordinary response (`R6`). A failed program delivers nothing and
reports `uiDiscarded: true` *only* when a payload had been accepted — a field on
the structured envelope, a trailing line on the plain-text paths — coexisting
with `emittedDiscarded: N` when one failure discards both.

**U4.** The payload spends the aggregate emit byte budget
(`ConnectaConfig.execute.maxEmittedBytes`), measured at the call as the
serialized bytes of `{ html, reads? }` — `M5`'s measurement. Over budget throws
catchably, naming the budget and the room remaining, with nothing partially
accepted. It spends no block count (`maxEmittedBlocks`: it is not a block) and no
host-call budget (`L4`). One transport bound covers everything rich a program
delivers.

**U5.** One static shell: a connecta-authored HTML5 document at
`ui://connecta/program-ui/v2`, mimeType `text/html;profile=mcp-app`, declared on
`execute_code` via `_meta.ui.resourceUri` together with an explicit
`_meta.ui.visibility: ["model"]`. Only `call_tool` declares app visibility; all
other tools say model-only. A `resources/read` handler answers exactly that
URI and fails on any other; `resources/list` is served and returns an empty list.
The version segment bumps whenever the shell's bytes change, because hosts cache
templates by URI.

**U6.** The shell renders the payload in a nested iframe
(`srcdoc`, `sandbox="allow-scripts"`, no `allow-same-origin`) and declares no CSP
domains, so the host applies its restrictive default and the `about:srcdoc` frame
inherits `default-src 'none'; connect-src 'none'`. One argument stays display-only;
a `V1` manifest installs only named `connecta.read`, with no direct network, raw
tool calls, discovery, conversation, writes, or links. The shell participates in the Apps lifecycle —
initialize, tool-result, size-changed, resource-teardown — and forwards no
channel whatsoever from the inner frame to the host. That isolation makes
program views fixed-height by construction: with no bridge there is no
content-height signal, the shell reports only its own box, and content taller
than that scrolls inside the inner frame rather than growing the view.

**U7.** Structural executor parity, per `M8`: `connecta.ui` is a provider
function, `ExecuteResult` and the `Executor` interface are unchanged, and both
executors get it through the bridge they already have.

**U8.** Request-local and unstreamed, per `M9`. The payload exists only in the
finished response, and `connecta.ui` resolving means "accepted," never
"rendered."

**U9.** `diagnostics: true` adds a distinct `ui` aggregate — the payload's byte
size, a number and nothing else (`R8`), present only when a payload was accepted.
UI bytes are not folded into `emitted`: that aggregate pairs a block count with
the bytes those blocks cost, and bytes without a block would desync the pair.

**U10.** `_meta.ui.resourceUri` is declared unconditionally. A host without the
extension ignores unknown `_meta` and sees the ordinary envelope, which *is* the
text fallback the Apps spec mandates; `connecta.ui` never fails because a client
cannot render. A stateless aggregator cannot reliably know, and connecta is not a
nanny.

**U11.** connecta declares `io.modelcontextprotocol/ui` in its server capability
declaration, and that is the one extension it advertises. The Apps extension must
be explicitly negotiated and a conforming client acts on one only when both sides
declare it, so without this declaration no host reads `_meta.ui.resourceUri`, no
host fetches the shell, and the whole design is inert. Reading the *client's*
declaration in order to register tool metadata conditionally stays refused
(`U10`), knowingly against a spec SHOULD.

**U12.** The return value, not the view, is what the model reads. `U3` puts the
view out of model context, so a program that renders one also returns the summary
the model should reason over, built from the same variables the initial view renders — a
view the return value does not mirror is a view nobody in the loop can check.
This binds program authors and nothing else: connecta never reads the HTML, diffs
it against the return, or enforces the correspondence. A heuristic there would be
the same mistake as automatic host-side projection, refused in `ethos.md`
([#282](https://github.com/zackbart/connecta/issues/282)).

**U13.** The always-loaded MCP instructions locate `connecta.ui(html)` before an
agent chooses a route: it is a guest function inside `execute_code`, never a
connector address or catalog result, takes one HTML string, and carries `U12`'s
mirrored-return duty. The detailed tool description proved too late to stop cold
agents from searching downstream catalogs for UI; the location distinction
therefore rides `initialize`, under a 1,000-character ceiling for the complete
instructions string. This promotes existing contract, not capability: the
seven-tool surface, guest API, catalog, Apps delivery, and runtime do not change
([#286](https://github.com/zackbart/connecta/issues/286)).

Bounded view reads follow normative [`V1`–`V8`](./program-ui-read-calls.md) ([#287](https://github.com/zackbart/connecta/issues/287), [#289](https://github.com/zackbart/connecta/issues/289)).

## Retry semantics

**Y1.** Connecta retries nothing beneath a program. `call_tool` accepts an
annotation-gated `maxRetries`; code mode fixes it at zero, so one
`connecta.call` is exactly one downstream attempt. The program is the retry
loop, and its budget is visible to it (`L4`).

**Y2.** A program may retry a failure whose `errorDetails.retryable` is true,
learned through `connecta.batch` (`S8`). Every attempt spends host-call budget,
so a retry loop that ignores the budget converts a transient failure into a
budget failure.

**Y3.** What must never be retried automatically:

- anything with `retryable: false` — a policy refusal, a missing credential, a
  bad address, or malformed arguments will fail identically forever;
- `rate_limited`, immediately. The sandbox has no timers, so a program cannot
  wait out a window; retrying inside it is the harm the signal exists to
  prevent. Return the failure and let the model, which can wait, re-issue with
  `retryAfterMs` in hand.
- a cancelled or timed-out *execution*: it is already over (`L1`).

**Y4.** Connecta's own retry machinery beneath the meta-tools honours a
connector-reported `Retry-After` exactly or not at all, and declines windows
longer than 10 seconds rather than shortening them. A program sees the window
verbatim as `errorDetails.retryAfterMs`.

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
| Calls per `connecta.batch` | 10 |
| Deadline per host call | 15 s |
| Discovery page | ≤ 100 tools, ≤ 256,000 serialized bytes |
| `describe` addresses | ≤ 100 |
| Result | 24,000 serialized characters |
| Logs presented to the model | 4,000 characters |

Exhausting the host-call budget fails that call like any other, with code
`connector_call_failed` (`E2`) and a message naming the budget — no connector was
reached, so nothing more specific is true. Retrying it is pointless: the budget
does not refill inside one execution.

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
is untyped text (`E1`). An over-bound *result* names the address the program
called, not the internal dispatcher behind the shortcut namespaces; an over-bound
*argument* payload is refused before it is parsed, so it names no address at
all — parsing it to write a better message would spend exactly the work the bound
exists to refuse.

**L7.** Executions are admitted, not queued indefinitely: bounded concurrency plus
a bounded queue with a wait timeout. Overload is a retryable `executor_overloaded`
carrying `retryAfterMs`; cancellation and shutdown are terminal. Admission happens
*before* any catalog or provider is built, so a queued request holds no state.

**L8.** Bounds are deployment configuration, not program inputs: a program cannot
raise one by asking. `execute_code`'s description states the host-call budget, the
batch maximum, and the per-call deadline — the ones a program must plan around
before it runs. The result and log caps live here and in the truncation notice
itself (`R2`, `R5`).

## Activity

**V1.** One payload-free activity event per attempted call, with
`source: "execute_code"` — every dispatched call plus every local refusal: a
read-only refusal, an unknown tool, an ambiguous shortcut, an unloadable
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
for a shortcut its sanitized alias, the honest record of what was attempted.

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

**X5. Leftover globals.** The QuickJS guest has no `fetch`, `process`, timers,
`crypto`, or `WebSocket` at all. The Dynamic Worker guest has all of them:
`fetch` exists but throws on use because outbound access is disabled,
`process.env` is empty, and timers work. `P2` is the contract — a program that
uses `setTimeout` is writing Workers-only code, and it will fail on Node.

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

## Changes from earlier code mode

Five behaviors changed with this contract, matching the changelog's Unreleased
entry. Programs that ran before still run.

- **`connecta.batch` failures gained `errorDetails`** (`S7`). They carried only a
  message, which left a program unable to tell a policy refusal from a transient
  failure. Additive, and it reuses the host's internal batch field names, so a
  program and the host describe a failed call the same way.
- **A policy refusal can no longer look retryable** (`E7`). Pinned in code rather
  than read out of message text, so a connector named `svc-503` stops flipping a
  permanent refusal to `retryable: true`. This reaches the call tools too.
- **An uncaught discovery-bound failure is typed** (`S3`): `invalid_args` or
  `result_too_large` rather than prose, the same envelope a failed call gets.
- **A bridge-bound failure names the address** (`L6`), not the internal
  dispatcher every shortcut namespace shares.
- **An oversized result is truncated once** (`R2`). The envelope is sized so its
  *serialized* form fits the cap; the QuickJS path previously truncated in the
  child and again in the parent, reporting the inner envelope's length as
  `totalChars`. Previews are shorter now; `totalChars` is the real size.

The middle three were places where the contract described behavior the code did
not quite have. The code moved, because the described behavior is the one worth
having.

Two surfaces were added since, both additive by construction and each with its
byte-for-byte no-call promise pinned by test:
[emitted output](#emitted-output) (`M1`–`M10`,
[#270](https://github.com/zackbart/connecta/issues/270)) and
[rendered output](#rendered-output) (`U1`–`U12`,
[#277](https://github.com/zackbart/connecta/issues/277)).

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
| `P2`, `X5` | `test/guest-api-contract.test.ts` (no usable network, no config) |
| `P3`, `X9` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` |
| `P4` | `test/guest-api-contract.test.ts` (no cross-run leakage), `test/execute.test.ts` (one catalog load per connector per execution) |
| `A1`, `A2` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (sanitizing) |
| `A3` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (colliding alias) |
| `A4` | `test/execute.test.ts` (namespace collisions, reserved namespace) |
| `A5` | verdict; `A1`–`A3` are its enforcement |
| `S1`, `S2` | `test/guest-api-contract.test.ts` (flat page, connector guides, schema keys, and the unfiltered browse that replaces `list_connectors`), `test/execute.test.ts` (guide pagination/partial/no-match behavior and `$ref`/`allOf`), `test/meta-tools.test.ts` (mixed complete/partial ranking and stable pagination) |
| `S3` | `test/guest-api-contract.test.ts` (typed uncaught bound), `test/execute.test.ts` (count limits, fan-out bound) |
| `S4` | `test/guest-api-contract.test.ts` (unknown address in `describe`) |
| `S5` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`unwrapMcpResult`) |
| `S6` | `test/execute.test.ts` (fail-closed annotations, activity parity) |
| `S7` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (batch cap) |
| `S8`, `E1` | `test/guest-api-contract.test.ts` (typed batch outcomes) |
| `E2`, `E8` | `test/guest-api-contract.test.ts` (code → `retryable`, batch and uncaught validation recovery), `test/meta-tools.test.ts` (direct, destructive, batch, provider fallback), `test/validate.test.ts` (bounded payload-free findings), `test/errors.test.ts` |
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
| `Y4` | `test/meta-tools.test.ts` (`retryBackoffMs`, `MAX_RETRY_BACKOFF_MS`) |
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
| `U1`, `U2` | `test/guest-api-contract.test.ts` (invalid and repeated calls throw catchably, first payload stands), `test/execute-ui.test.ts` (every rejected shape) |
| `U3` | `test/guest-api-contract.test.ts` (`_meta` payload and `ui: true`, identical on both executors), `test/execute-ui.test.ts` (`structuredContent`, byte-for-byte no-call path, discard structured and plain, coexistence with `emittedDiscarded`), `test/quickjs-executor.test.ts` (mid-run shutdown) |
| `U4` | `test/execute-ui.test.ts` (one shared byte aggregate crossed in either order; block count and host-call budget untouched) |
| `U5`, `U10`, `U11` | `test/server.test.ts` (the shell URI, mimeType, and body; every other URI fails; empty listing; `execute_code`'s `_meta.ui`; exactly one declared extension) |
| `U6` | `test/execute-ui.test.ts` (valid HTML5, `srcdoc` and sandbox attributes, no `allow-same-origin`, no path from the inner frame to the host) |
| `U7`, `U8` | two arms passing one case table, `test/codemode-compat.test.ts` |
| `U9` | `test/execute-ui.test.ts` (a `ui` byte aggregate distinct from `emitted`, absent when nothing was accepted) |
| `U12` | `test/server.test.ts` (the `connecta.ui` bullet carries the return-value clause); a duty on program authors, so the description is the only place it can be enforced |
| `U13` | `test/code-first-surface.test.ts`, `test/server.test.ts` (served `initialize.instructions` locate UI inside `execute_code`, exclude it from catalog search, state the one-string call and mirrored return, and stay within the complete 1,000-character budget) |
| `X3` | `test/quickjs-executor.test.ts` (cancels a running child) |
| `X4` | `test/guest-api-contract.test.ts` (string logs only) |
| `X6` | `test/quickjs-executor.test.ts` (never-settling await) |
| `X7` | `P3`'s tests; the Workers superset is deliberately unused |

The surface itself is checked by `test/server.test.ts` (the exact seven-tool
list) and `test/code-first-surface.test.ts` (the fold's construction rules, the
required executor, the refusals a removed top-level tool now gets, copy, and
measured size). There is one shape left to audit, so there is one audit:

```sh
npm --prefix eval/current-version run audit
```
