# Code mode — the guest API contract

The `execute_code` contract: capabilities, results, failures, retries, limits,
and activity. Specified in prose first, implemented second.

Two executors implement it: QuickJS in a Node child process and `workerExecutor()`
from `@zackbart/connecta/worker` around upstream `DynamicWorkerExecutor` on Workers.
Divergence is a bug unless explained in [Executor exceptions](#executor-exceptions);
a third executor is implementable from this document alone.
[`PRINCIPLES.md`](https://github.com/zackbart/connecta/blob/main/PRINCIPLES.md) states the invariants,
[`meta-tools.md`](./meta-tools.md) owns the top-level tool contract, and clause
identifiers (`A1`, `E3`, …) are stable and cited by [Verification](#verification).

## Deploy-time capability

The `executor` passed to `createConnecta()` is required. `tools/list` is exactly
six — `execute_code`, `search_tools`, `call_tool`, `call_destructive_tool`,
`authorize_connector` and `skills`. Construction fails when the
executor is missing, and the removed `surface` option is rejected rather than
ignored ([#273](https://github.com/zackbart/connecta/issues/273)), as are the
pause-only `execute.resumableWrites` and `execute.pausedRunTtlSeconds`
([#672](https://github.com/zackbart/connecta/issues/672)).

On Node, install the optional `quickjs-emscripten` peer and use the package's
QuickJS subpath:

```ts
import { createConnecta } from "@zackbart/connecta";
import { quickJsExecutor } from "@zackbart/connecta/quickjs";

createConnecta({ executor: quickJsExecutor() /* connectors, auth, storage… */ });
```

`quickJsExecutor()` runs each program in a disposable child process, with CPU,
wall-time, memory, stack, queue, result, log, and IPC bounds on the executor.
Keep `@zackbart/connecta/quickjs` external in server bundles so the child entry
stays on disk. The [Node template](../templates/node/README.md) has the full setup.

On Workers the Worker Loader is the sandbox; Dynamic Workers require the Paid plan:

```ts
import { workerExecutor } from "@zackbart/connecta/worker";

createConnecta({ executor: workerExecutor({ loader: env.LOADER }) });
```

The adapter uses only `loader` and an optional `timeout`. Its admission defaults
are two active runs, eight queued runs, and a five-second queue deadline, settable
through `admission`. Lease release disposes RPC and loader handles independently
of guest settlement. `bindings`, `modules`, or `globalOutbound` violate `P2`.
The [Worker example](../examples/worker/README.md#code-mode) has the full setup.

Replace `import { DynamicWorkerExecutor } from "@cloudflare/codemode";` with
`import { workerExecutor } from "@zackbart/connecta/worker";` and use the wiring above.
Keep the peer. Unbranded executors throw, including bundled upstream copies.
Shipped executors carry a non-enumerable `Symbol.for("connecta.executor")` version/lifecycle brand.
Custom sandboxes import `customExecutor` from `@zackbart/connecta`, then configure
`executor: customExecutor(myExecutor, { lifecycle: "self-managed" })`. They own guest termination
and cleanup at budget exhaustion, cancellation, and deadlines; the wrapper only delegates methods.

## What an executor must implement

The Promise provider/result seam lives in `src/types.ts`. Custom implementations
also need the lifecycle wrapper above; structural compatibility alone is insufficient.

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
  failure?: { name: string; line?: number; call?: CallErrorDetails;
    timeout?: { elapsedMs: number; deadlineMs: number } };
  logs?: string[];      // captured console output, in call order
}
```

Connecta passes exactly one provider, named `connecta`. An executor must:

1. **Expose each provider as a guest global** whose properties are its `fns`,
   called with the program's arguments and awaited. Connecta supplies `search`,
   `describe`, `call`, `result`, `skill`, and `emit`.
2. **Evaluate `prelude` after the provider globals exist and before the
   program.** It is trusted host code that installs the immutable namespace
   and waits for emission acknowledgements. Capture runner intrinsics first;
   privileged initialization must be single-use.
3. **Marshal values as JSON** both directions (`P3`), and reject a host call
   whose function is not an own property of `fns` — the guest can ask for
   inherited members too.
4. **Return, never throw, for a failed program.** Set `error` and leave
   `result` undefined. Rebuild a rejected host `InvocationFailure` as a guest
   Error with `code`, `retryable`, and `details`, and retain its identity in
   executor-owned state. If that same Error escapes the program, return its
   typed details in `failure.call`. A wrapped or copied Error is `program_error`.
   Construct outcomes through the host-owned RPC return or QuickJS host bridge,
   never by parsing guest stdout, prints, returned values, or thrown look-alikes.
   No secret held in the guest realm authenticates anything. Guest module
   specifiers must not resolve runner internals, including dynamic imports.
   For compilation failures, return `failure: { name, line? }`. For a sandbox
   timeout, add `failure.timeout: { elapsedMs, deadlineMs }`.
5. **Capture `console.log`, `console.warn`, and `console.error`** into `logs` in
   call order (`R5`), bounding what it retains.
6. **Bound the guest**: wall clock, memory, stack, and CPU (`L3`, `L5`), within
   `P2`/`X5`. Settle `execute()` on your own deadline; connecta stops waiting
   at `execute.watchdogMs` and reports the sandbox unresponsive (`L3`).
7. **Grant no ambient authority.** Never use `eval` or `node:vm`: sandboxing
   supplements connecta's boundary; every capability arrives through `fns`.

Optional `AdmittingExecutor.acquire()` returns a once-executed lease for bounded
admission (`L7`); otherwise connecta uses `withExecutorAdmission`. `close()` handles
shutdown. `/health` and `connecta doctor` report `name`, falling back to the
constructor name, which minifiers may rewrite. [Emission](#emitted-output) is
another provider function (`M8`).

## The program

**P1.** A program is one JavaScript `async` arrow expression, evaluated once;
its resolved value is the result. Before either executor sees it, `execute_code`
removes trailing semicolons (and retains comments) so parenthesized evaluation
works on both. `async () => 1; 2` is still more than one expression. The host
also recovers one JavaScript fence, even when prose surrounds it, `export default`
around an async arrow, or one named `async function` declaration with simple
parameters. The result remains one async arrow. Multiple fences, extra
statements, and bare statement bodies are outside host recovery. QuickJS may
wrap a bare body when driven directly; that is outside the portable contract.

**P2.** The only capabilities in the contract are `connecta.search`,
`connecta.describe`, `connecta.call`, `connecta.result`, `connecta.skill`, `connecta.emit`, and `console.log` /
`console.warn` / `console.error`, captured and returned. Anything else a runtime
exposes is outside the portable contract and must not be used. QuickJS grants
none of it. A loader-only Dynamic Worker denies external egress and filesystem
access and keeps its environment maps empty, but exposes the globals and runtime
builtins in `X5`.

**P3.** Values cross the host bridge as JSON: arguments must be
JSON-serializable and results arrive as plain JSON. A value outside JSON — a
cycle, a `BigInt`, a function, a class instance — never round-trips; it either
ends the run with an error or is converted lossily, executor's choice (`X9`).

**P4.** Nothing survives an execution: no module scope, cache, or scratch
storage carried to the next program, and no request-bound object outliving its
request. Within one execution, host calls share one downstream request scope.
`S9`'s output observation is host-owned catalog metadata, not guest memory — a
later program receives a labeled field/type schema through discovery, never a
prior value or object.

**P5.** Plain JavaScript only; TypeScript syntax is a syntax error. Portable
code does not import: QuickJS blocks imports, Dynamic Workers expose the `X5`
runtime modules, and neither exposes `require`.

**P6** pinned a run's clock and randomness so a paused program could replay;
it left with replay ([#672](https://github.com/zackbart/connecta/issues/672)).
`Date.now()` and `Math.random()` are the runtime's own again, and the id stays
retired. QuickJS still runs with `TZ=UTC`, so local time matches a Dynamic
Worker's (`X5`).

## Addressing

**A1.** A tool has one canonical address, `<connectorId>.<toolName>`, exactly as
discovery returns it. Call it with `connecta.call(address, args)`. Punctuation
is preserved; no JavaScript identifier conversion takes place.

**A2.** Connectors create no guest globals, so an id resembling a JavaScript
builtin, or one that would collide after sanitization, stays usable through its
canonical address. The bounded connector inventory in the tool description shows
canonical ids with bounded configured titles when present. Clauses A3–A5
belonged to shortcut dispatch and stay retired; nothing reuses those ids.

## The surface

Six functions: `search`, `describe`, `call`, `result`, `skill`, and `emit`.
All return awaitable values; emission also works without `await`. The namespace
has no inherited members. Unknown properties are undefined, and calling them
fails as a guest `TypeError`. The host also dispatches only own members of `fns`.

### connecta.search

```js
const page = await connecta.search({
  query: "pipeline run job logs",   // 2–4 distinctive action/object terms
  connector: "ci",                  // load one obvious connector, not every catalog
  safety: "readOnly",               // or "approvalRequired" / "all"
  limit: 8,                         // 1–100, default 8
  offset: 0,
  fullDescriptions: false,
  includeSchemas: "json",           // default; or "compact" / "typescript"
  includeSchemaKeys: true,          // default true in code mode
});
```

**S1.** Returns the same flat page as top-level `search_tools`:
`{ catalogErrors, tools, total, offset, limit, hasMore }`, plus `nextOffset`
when more remains and `matchMode: "partial"` when no tool matched every term.
Read `catalogErrors` and any `absence` before selecting a tool. Catalog failures
carry recovery actions at the top of the page; an absent service returns no
lookalikes. Both paths use only the caller's endpoint/pool and grants. Ranking is
[lexical discovery](./meta-tools.md#lexical-discovery)'s, and rows expose
neither lexical scores nor per-result coverage. An empty or whitespace-only
query browses; non-empty input with no ASCII lexical terms returns no tools plus
bounded no-match analysis in `queryAnalysis`; mixed input searches with its
ASCII terms.

Each entry carries `address`, `name`, the configured `connectorTitle` when
present (normalized whitespace, at most 120 UTF-8 bytes), and — when requested —
`description`, `inputSchema`, `outputSchema`, and `annotations`. An entry whose
connector carries a usage guide also carries `guide` (the skill name) and a
bounded `guideSummary`, requested or not. An output shape learned under `S9`
also carries `outputSchemaSource: "observed"`; provider declarations carry no
source marker.

Programs default to `includeSchemas: "json"`: `inputSchema` and available
`outputSchema` are JSON Schema values, labeled `schemaFormat: "json"`.
Explicit `includeSchemas: "compact"` returns strings labeled
`schemaFormat: "text"`; TypeScript signatures carry the same text label.
Compact shapes omit property prose and put required fields first, under these
bounds:

| Bound | Value |
| --- | --- |
| `execute_code` source | ≤ 65,536 UTF-8 bytes, checked before executor admission; over-limit source returns `invalid_args` |
| Rendered shape | 1,024 UTF-8 bytes each |
| Work per shape | 2,000 visits across schema nodes, property and required names, literal values, any constraint-free retry, and its key-only fallback |
| Each enum node | 256 of those bytes |
| Resolved `$ref` text | reused within one walk |

About three near-cap enum nodes therefore coexist while the final quarter stays
for surrounding syntax, and above 1,024 bytes the global fallback applies.
Exhausted work yields `unknown /* truncated */`; a capped enum preserves whole
values before `unknown` plus an exact omitted-value count; an empty enum renders
as `never` and small enums stay complete. Either cap sets `inputSchemaTruncated`
or `outputSchemaTruncated`, and a shape-wide cap stays structurally valid with
`unknown` types plus `/* truncated */`. Compound forms share those bounds:
`prefixItems` renders as a tuple with the declared `items` rest, an `unknown[]`
rest when open, or no rest when `items` is false; `dependentSchemas` and
`if`/`then`/`else` keep the base shape plus `/* conditional */` and set the
truncation flag; `$dynamicRef` resolves a same-named definition like `$ref`, and
an unresolved one becomes `unknown` with the flag. For omitted exact constraints
use `format: "json"` or JSON search.

`includeSchemas: "typescript"` spends those same bounds on a different
rendering: one `signature` string in place of `inputSchema` and
`outputSchema`, reading `(args: { runId: number }) => Promise<Run>` for the
`data` value `connecta.call` returns. It is documentation for the program's author —
the program itself is still JavaScript, and a type annotation copied into it
is a syntax error (`P5`). Truncation keeps compact's flags and
turns what compact would print as a name or raw JSON into a marked `unknown`;
an observed output opens with `/* observed, not declared */`. The dialect and
its degradation rules are specified once, under
[TypeScript signatures](./meta-tools.md#typescript-signatures), and the
signature is byte-identical to the one `search_tools` returns.

**S1a.** `connector` loads only the named catalog; omit it only when the
integration is ambiguous. `safety: "readOnly"` selects stored read verdicts;
`"approvalRequired"` selects stored write verdicts; omitted or `"all"` selects
both. Search and describe rows carry `classification`. These filters grant no
authority and change no pool trust or call admission decision.

**S2.** A requested object schema carries `inputKeys`, `requiredInputKeys`
(declared properties only), and `outputKeys`: the names the rendered schema
shows, ready to check before building arguments. Select on inputs, truncation,
safety, and outputs rather than lexical rank, and use `outputKeys` instead of
guessed roots. A non-object schema — a union, an array, an unresolvable `$ref` —
carries no lists rather than empty ones, because absent means "read the schema"
where `[]` would claim the tool takes no fields. The lists come from the walk
that renders the compact schema, so a top-level `$ref` resolves and an `allOf`
composes. A zero-input object keeps `inputKeys: []` and `requiredInputKeys: []`;
an output object with no declared properties omits `outputKeys`; a truncated
schema omits the corresponding list. `search_tools` carries the same metadata
whenever schemas are requested, and `includeSchemaKeys: false` buys the bytes
back.

**S3.** Discovery bounds throw rather than silently shrink. `invalid_args`
covers a `limit` outside 1–100, an `offset` that is not a non-negative integer,
a supplied `query` that is not a string, and a `connector` over 512 UTF-8 bytes
— refused whole, since a clipped scope names a different connector. Omitted
`offset` starts at 0; omitted `query` browses. A page whose serialized form
exceeds 256,000 bytes is `result_too_large`; a program's page is measured as its
serialized value, while top-level `search_tools` measures the complete tool
result including both copies and JSON escaping. Each error carries a correction
hint and the stable `code`, `retryable`, and `details` fields (`E1`).

### connecta.describe

```js
const one = await connecta.describe({ address: "ci.get_run" });
const many = await connecta.describe({
  addresses: ["ci.get_run", "ci.get_job_logs"],  // ≤ 100
  format: "json",                                // default; or "compact" / "typescript"
  fullDescriptions: false,
});
```

**S4.** Defaults to JSON Schema values with `schemaFormat: "json"`.
Explicit compact schemas and TypeScript signatures have `schemaFormat: "text"`.
Returns `{ tools }` in order, one entry per address; one bad address
never fails the whole call. An unknown address or failed catalog returns `error`
plus typed `errorDetails` (`code`, `message`, `retryable`). Misses carry a
route-aware `nextAction`, a close miss may add three canonical `suggestions`,
and catalog failures add only `retryAfterMs` when known. Each failed entry
clamps its caller-authored `address` to 512 UTF-8 bytes with an `…` marker, and
entry order correlates a clipped address with its request; successes keep
canonical addresses. More than 100 addresses is `invalid_args`, and the same
256,000-byte ceiling applies. Compact describe keeps property prose within a
separate 8,192-byte UTF-8 shape cap and shares search's 2,000-visit budget; a
capped shape sets `inputSchemaTruncated` or `outputSchemaTruncated`, and
`format: "json"` gives the exact schema. `format: "typescript"` returns a
`signature` instead of both schema fields, under the same 8,192-byte cap per
half with property prose as JSDoc. A success whose output shape came from
`S9` carries `outputSchemaSource: "observed"`, and a TypeScript signature also
says so inside its `Promise<…>`.

### connecta.call

```js
const { data: run, format } = await connecta.call("ci.get_run", { runId: 42 });
// Equivalent: connecta.call({ address: "ci.get_run", args: { runId: 42 }, timeoutMs: 30_000 })
```

**S5.** Takes a canonical address, optional arguments, and optional
`{ timeoutMs }`; the object form is `{ address, args?, timeoutMs? }`. A malformed
signature fails with `invalid_args` and both exact signatures, before discovery.
Returns `{ data, format: "json" | "text" }`. MCP `toolResult` or
`structuredContent` is JSON; all-text content is JSON when it parses, otherwise
text. API string values are text, other API values are JSON. Check `format`
before treating `data` as an object. A downstream `isError` throws.

**S6.** Every call goes through the same catalog, fail-closed read-only
predicate, admission, credential containment, timeout classification, health
accounting, and activity recording as an ordinary meta-tool call. The predicate
and config decide whether a call runs or is refused (`E4`, `W12`); nothing a
program does decides it. The sandbox is an additional containment layer, not a
second implementation of the boundary, and nothing a program does widens what
it can reach.

### connecta.result and connecta.skill

`await connecta.result(id, { offset?, maxBytes? })` reads a stashed direct-call
result bound to the admitted subject, principal, endpoint/pool, request origin,
connector, and tool. It returns
`{ resultId, offset, bytes, totalBytes, hasMore, nextOffset?, format: "text", text }`.
Offsets and sizes are UTF-8 bytes; the page cap is the original call's inline cap.
Follow `nextOffset`, reassemble inside the program, and return a reduced value.
Before returning a page, the host rechecks current authentication, connector/tool
grants, pool membership, and endpoint trust against both the original and current
tool classification. A read-only endpoint cannot page a write result, so a
direct write there returns an inline truncation notice without stashing the
result or advertising a paging action. Binding
mismatches, revoked access, and old entries without bindings are `not_found`, as
are unknown or expired ids; a storage failure is `unavailable`. IDs are random UUIDs.
The `get_result` meta-tool is removed.

`await connecta.skill(name)` resolves the same exact built-in or `connector:id`
name as top-level `skills`, within the admitted connector view. It returns
`{ name, format: "text", text }`; an unknown name is `not_found`.

### Parallel calls

**S7.** Use `Promise.all` for independent calls when any failure should fail the
program, or `Promise.allSettled` to retain every outcome in input order. Both
use the same per-call admission, host-call budget, deadlines, and activity path
as sequential calls. There is no separate batch size or result contract.

**S8.** A rejected promise retains the caught error's `code`, `retryable`, and
`details`. Project those fields before returning — an `Error` object is not a
JSON result contract.

**S9.** A successful call classified as a read whose provider declared no
`outputSchema` passively learns one from the unwrapped result. The observation
keeps field names and broad JSON types only — no arguments, scalar values, raw
results, code, credentials, or errors — and property names may be user-authored.
Objects stay open, every field stays optional, and discovery labels the shape
`outputSchemaSource: "observed"` so a model cannot mistake runtime evidence for
a provider contract. Later observations merge fields and types in a
process-local 256-entry LRU; a provider declaration always wins. Inference stops
at depth 6, 128 schema nodes, 48 properties per object, 32 inspected array
items, and 128 UTF-8 bytes per property name; `__proto__`, `constructor`, and
`prototype` names are discarded. A tool definition over 64 KiB or an observed
schema over 16 KiB is ignored. An entry expires after 24 hours and carries the
exact serialized tool definition, so a changed catalog entry, process restart,
or isolate eviction starts cold. A failed call or failed result-processing step
learns nothing, and any observation failure is discarded without changing a
successful call. No discovery read, timer, refresh, background job, or storage
adapter executes or persists work for this cache: the result-sampling refusal in
[#282](https://github.com/zackbart/connecta/issues/282) stands.

### connecta.emit

```js
await connecta.emit({ type: "image", data: shot.data, mimeType: "image/png" });
```

The rich-output channel, delivered after the JSON envelope on success. Its
clauses are [Emitted output](#emitted-output) (`M1`–`M10`).

## Errors

**E1.** There are three error channels. Connecta failures are typed whether
caught or uncaught. Host-call budget exhaustion ends the host run and blocks host
access (`L4`); Workers guest computation may continue briefly until teardown (`X3`).

| Channel | Shape | Typed? |
| --- | --- | --- |
| A caught Connecta host failure | `Error` with `message`, `code`, `retryable`, and `details` | yes |
| An uncaught **tool or discovery** failure, as the model sees it | `{ error: { code, message, retryable, … } }` with `isError` | yes |
| Program or execution failure (`E5`, `E6`, a bridge bound in `L6`) | `{ error: { code, message, retryable, details? } }` | yes |

Both executor bridges rebuild typed host rejections as guest Errors and retain
their identity in executor-owned state (`X11`). `message` stays human text, capped at 2,000
JSON-serialized characters including quotes and an `…` marker when clipped.
`code` and `retryable` are the stable branch fields; `details` carries the host
classification and fits 3,700 serialized characters. Optional recovery metadata
that would exceed that bound is omitted whole, preserving `code`, `message`,
`retryable`, and `retryAfterMs`, because a clipped recovery address or argument
describes a different call. This covers `call`, `search`, `describe`, `result`, `skill`, `emit`, and
write and emitted-output budgets. Program-authored errors use `program_error`; code must never
parse error prose. An `unavailable` classification may add `details.host`, an
HTTP(S) origin of at most 253 UTF-8 bytes, and `details.code`, a validated
network errno, undici transport code, or `timeout` of at most 32 bytes; neither
enters activity.

**E2.** The taxonomy: `retryable` is what connecta reports, `Y3` what a program
may do. A provider maps each downstream failure to the code that tells the
caller what to do next, and never invents a cause it was not told.

| Code | Raised when | `retryable` |
| --- | --- | --- |
| `unknown_address` | no connector owns the address | false |
| `unknown_tool` | the connector has no such tool | false |
| `destructive_tool_requires_approval` | a program in a read-only pool attempted a write (`E4`) | false |
| `auth_required` | the credential is missing, expired, or rejected | false |
| `invalid_args` | arguments or discovery bounds were rejected | false |
| `not_found` | the downstream answered and the resource is not there — the one code that says skip this id rather than stop, raised only where the provider tells absence from a permission gap | false |
| `conflict` | the write named a base version someone else already moved past; nothing changed. `details.current` says where things stand (at most 20 whole-number entries) — re-read, reapply, retry with that base | false |
| `input_required_unsupported` | a downstream asked for mid-call input | false |
| `rate_limited` | the downstream reported a rate limit | true |
| `unavailable` | the downstream is down or unreachable; optional sanitized `details.host` and `details.code` describe the transport failure without paths, queries, credentials, or provider prose | true |
| `timeout` | a call or sandbox deadline expired; details name operation, stage, elapsedMs, and deadlineMs | per operation |
| `program_error` | guest JavaScript failed; `details.name`, `line`, and a fixed repair hint describe it | false |
| `cancelled` | the run ended while this call was in flight (`E5`) | false |
| `connector_call_failed` | anything else the connector threw | per message |
| `catalog_lookup_failed` | the connector's catalog could not be loaded | per cause |
| `result_processing_failed` | the result could not be prepared | per message |
| `result_too_large` | a discovery response exceeded its byte bound | false |
| `budget_exceeded` | the run exhausted a host-call, write, or emitted-output budget | false |
| `write_outcome_unknown` | a trusted-pool write was sent and no answer came back; it is never sent again (`W9`) | false |

**E3.** `auth_required` carries the same recovery envelope as `call_tool`:
`connector`, `operation`, `recovery` (`oauth`, `operator_config`, or
`unavailable`), `nextAction` naming `authorize_connector`, and a `retry`
sentence. A program cannot recover credentials — only an operator can — so stop
and let the failure reach the model.

**E4.** A tool classified as a write never runs in a
program unless the pool is trusted (`W12`). It is refused with
`destructive_tool_requires_approval` before validation and before anything is
sent, `nextAction` carrying its canonical address to `call_destructive_tool`
plus the original arguments when they fit the 512-byte echo budget — whole or
not at all, since a clipped copy is a different call. The host's prompt on that
call is the approval, and the only one: generated code can neither mint the
capability nor approve its own write, and the model's short `reason` grants no
authority and never goes downstream.

**E5.** Failures of the *execution*, not of a call, never appear inside the
guest: admission rejection (`executor_overloaded`, retryable, with
`retryAfterMs`), cancellation (`executor_cancelled`), shutdown
(`executor_closed`), deadline expiry, an executor that never settles (`L3`),
and sandbox crashes end the run and reach
the model as an error result. One seam: a host call still in flight when the run
is cancelled fails with `cancelled`, catchable on the way out but never worth
acting on (`Y3`). When shutdown tears down a program that had already started,
accepted blocks are reported as discarded under `M4`; a failure before execution
started carries no discard fields. A returned `error` field is a failure even
when empty. An empty string reports `program_error` with
`Program Error: Execution failed without an error message.`

**E6.** A guest `TypeError`, `ReferenceError`, syntax error, invented API, or
program-authored throw is `program_error`. `details.name` is a bounded engine
error name; `details.line` is the source line when the runtime supplies one,
otherwise null. Fixed hints repair imports/require/filesystem access, shadowed
`connecta`, and invented globals such as `callTool` and `mixpanel`.

An unchanged uncaught host error retains its classification through Error
identity. A new error containing its message is a new program error. Copied
public `code`/`details`, printed text, and returned outcome-shaped objects carry
no authority. Host-call counts stay in host state. The guest JSON codec, Object
prototype, and Promise prototype are immutable. Promise race and species are
protected too. Host completion uses captured intrinsics so guest edits cannot
change bridge decoding or async return adoption. Worker guest modules contain
only the user callback and an import helper limited to runtime builtins.
Relative and other guest module imports cannot reach runner code. Trusted
wrappers and preludes remain outside the guest's lexical scope, and privileged
initialization is single-use. A separate private runner module captures and
freezes its references before the guest module evaluates, including the guest
namespace initializer. The entrypoint imports that runner before its guest
dependency. Before loading, the adapter parses the assembled guest export and
requires exactly one expression with no additional statements. Normalized
multi-statement bodies remain one async arrow expression.
Program diagnostic fields are bounded before transport, including escaped text;
a large custom error name cannot turn a failure into a truncated success.

**E7.** `retryable` for `unknown_address`, `unknown_tool`, and
`destructive_tool_requires_approval` is pinned false, never inferred from an
address containing `503`, `429`, or `temporar`. The first two carry
`nextAction: { function: "connecta.search", arguments: { query, connector?, includeSchemas: "compact" } }`
— scoped discovery keyed to the surface the caller has, since a program cannot
call `search_tools`. The message, the derived `query`, and a failed describe
entry's `address` clamp caller-authored text to 512 UTF-8 bytes with an `…`
marker, because those values land in both the text content and
`structuredContent`, where an invented 50 KB address would produce a refusal far
past the deployment's result cap. A clipped address still identifies the mistake
by its position; a short one is exact and untagged.

**E8.** A remote MCP tool whose advertised schema rejects the call fails before
provider dispatch with `invalid_args`, carrying bounded, value-free
`{ path, code, expected }` findings and the same scoped
`function: "connecta.search"` recovery every other in-program miss gets. A
declared property reports the schema keyword that failed, never the validator's
duplicate `additionalProperties` branch; a truly undeclared property still
reports `additionalProperties`. Unsupported schemas pass through; unrecognized
provider prose remains `connector_call_failed`.

## Results and projection

**R1 (verdict: projection stays explicit).** A program's return reaches the model
unchanged except for `R2`'s size guard. Connecta does not summarize or select
fields. Program-authored projection saved bytes; host heuristics could drop
deliberately returned fields. Helpers need [#222](https://github.com/zackbart/connecta/issues/222)
evidence that programs fail to project.

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

**R3.** Truncation is a *successful* result: the program ran but returned too
much. Run a program that returns less; that is why the envelope says so.

**R4 (verdict: no result paging for programs).** Program results have no
`connecta.result` handle. A program can shrink its return; paging would reward
unprojected data.

For non-repeatable writes, inspect and reduce the full result before return,
or page a direct `call_destructive_tool` result on a trusted endpoint with
`connecta.result`. Sampling a
program result may discard the only copy.

**R5.** `console.log`, `console.warn`, and `console.error` are captured in call
order and returned as one `logs` string, capped at 4,000 characters with a
truncation marker. Logs survive program failure through either a returned error
result or a thrown error carrying `logs: string[]`. QuickJS streams captured
entries to its parent and preserves the received prefix on cancellation,
shutdown, deadline termination, child crashes, and IPC failures (`X4`). How a
non-string argument renders is not contract (`X4`). At terminal host-call
budget exhaustion, QuickJS returns its streamed prefix; a Dynamic Worker
has no host log stream and cannot supply logs from its suspended guest (`L4`).

**R6.** Every run returns `hostCalls: { attempted, admitted, succeeded, failed }`,
including admission failure, cancellation, budget refusal, and code-size refusal.
Calls include search, describe, call, result, and skill. `emit` has separate budgets.
An abandoned host call counts as failed when the run ends; guest catches do not
change the counts. These numbers are outside the program's returned `result`.
`diagnostics: true` adds the existing payload-free timing block. Emitting adds
`emitted: N` and its content blocks.

**R7.** Diagnostic timing separates admission, provider setup, total executor
wall time, catalog work, and connector work. Catalog and connector values are
cumulative, so parallel work can exceed executor wall time. Each used operation
kind (`search`, `describe`, `call`) gets one aggregate with count, failures,
duration, returned serialized bytes, and catalog/connector time.

**R8.** Diagnostics contain measurements and fixed operation names only: no
addresses, arguments, results, code, credentials, logs, or raw errors. Result
sizes are numbers, never previews. The collector exists only for the opted-in
request; it is not activity, a session, or a stream.

## Emitted output

Images accept only `image/png`, `image/jpeg`, `image/gif`, or `image/webp`
and nonempty canonical base64. Whitespace, URL-safe alphabets, bad padding,
and nonzero pad bits are rejected before collection. Size budgets still apply.

MCP-native output a return value cannot carry: base64 is not projectable, so a
block that survives intake uncapped (`S5`) must not die at the `R2` exit guard.
The earlier alternatives are in [decision history](https://github.com/zackbart/connecta/blob/main/decisions/0001-ethos-verdict-table.md)
([#267](https://github.com/zackbart/connecta/issues/267),
[#270](https://github.com/zackbart/connecta/issues/270)).

**M1.** `connecta.emit(block)` accepts exactly one block: `{ type: "text",
text }` or `{ type: "image" | "audio", data /* base64 */, mimeType }`, every
field a string, no extra fields, no `annotations`, no `_meta`, no sugar forms.
An invalid block throws catchably and nothing is accepted — rejected, not
stripped. The refused types are pointers: a guest-minted `resource_link` URI is
a lure a client may dereference.

**M2.** Blocks collect on the host in emission order and are delivered only with
a successful result, appended to `content` after the JSON envelope, which gains
`emitted: N`. A program that never emits produces the byte-for-byte ordinary
response (`R6`). `structuredContent` stays the envelope alone — emission is
presentation, not a second data channel.

**M3.** Text emission shares `R2`'s 24,000 serialized-character cap. Its
serialized block size reduces the return budget, and oversized text fails with
`result_too_large`. Image/audio blocks use the separate transport budget and
reach the model as real MCP media content, including when `emit` is not awaited.
The trusted runner waits for emission acknowledgments before returning success.
An unobserved emission failure fails the run; an awaited failure remains catchable.
Rejections propagated through `then` or `finally` can be caught later in that
chain. A separate unhandled branch still fails the run.

**M4.** A failed program delivers no blocks. The error result reports
`emittedDiscarded: N` when N > 0 as a field on the structured envelope.

**M5.** Two budgets (`ConnectaConfig.execute.maxEmittedBytes` /
`.maxEmittedBlocks`, defaults 4,000,000 serialized bytes and 32 blocks) fail
loudly at the `emit` call, naming the budget and the room remaining; nothing is
partially accepted and prior blocks stand. Accepted and rejected emission attempts
also have a terminal limit of four times the configured block cap (at least 128),
which bounds retained host failures and guest acknowledgement state without
discarding an older error identity. No result stash for emitted blocks: the program
learns while it can still choose differently. The byte default is a transport
bound, not a context bound — emitted media reaches the model as media, not
base64 text.

**M6.** No provenance is claimed: every emitted block is program output, trusted
exactly as much as the return value. Preservation is re-emission of the raw
downstream block, so `S5`'s uncapped fallthrough is contract.

**M7.** `emit` alone spends no host-call budget (`L4`); `search`, `describe`,
`call`, `result`, and `skill` share it. Text also observes `R2`.

**M8.** `emit` is a provider function; blocks cross the guest boundary once as
an argument. `ExecuteResult` remains compatible with upstream codemode's types;
construction requires the Worker adapter or explicit custom opt-in. Any executor
that bridges provider calls gets emission for free.

**M9.** Request-local and unstreamed: blocks exist only in the finished
response, and `emit` resolving means "accepted," never "delivered."

**M10.** Activity stays payload-free. `diagnostics: true` adds one `emitted`
aggregate — count and serialized bytes, numbers only (`R8`), present only when
something was emitted.

## Retry semantics

**Y1.** Connecta makes one downstream attempt per admitted call, both inside a
program and through either direct-call tool. It never waits and retries on the
caller's behalf, and an admission refusal may prevent even that attempt.

**Y2.** A program may retry a caught failure whose `retryable` is true, or a
rejected promise whose `reason.retryable` is true (`S8`). Every attempt spends
host-call budget, so an unchecked loop converts a transient failure into
`budget_exceeded`.

**Y3.** What must never be retried automatically:

- anything with `retryable: false` — a policy refusal, a missing credential, a
  bad address, or malformed arguments will fail identically forever;
- `rate_limited`, immediately. A portable program has no timer, and a
  Dynamic-Worker-only wait would spend the run's wall clock on code that fails
  on QuickJS. Return the failure and let the model, which can wait, re-issue
  with `retryAfterMs` in hand.
- a cancelled or timed-out *execution*: it is already over (`L1`).

**Y4.** A provider's `retryAfterMs` is returned unchanged; the caller decides
whether and when to reissue, and a later call gets its own deadline and
admission decision.

## Cancellation and limits

**L1.** Cancellation is not observable inside a program. There is no signal to
poll, no cancellation exception to catch, and no guarantee that a `finally`
block runs — a cancelled QuickJS child is terminated outright. Write programs
that need no cleanup.

**L2.** Cancellation aborts in-flight host calls and admits no further calls,
including discovery. The response returns `executor_cancelled` without awaiting
a wedged executor or `acquire()` that ignores its signal. It releases the lease;
a late-granted lease releases on arrival. Nothing request-bound survives the
request. Whether guest computation stops is the executor's (`X3`).

Programs and direct calls use the same invocation deadline and stages. A call's
`timeoutMs` wins, then `calls.defaultTimeoutMs`, then `execute.hostCallTimeoutMs`
(default 15,000). A guest may request a longer individual call, but the sandbox
and request ceilings still bound the whole run. Timeout details are agent-facing;
INV-6 operator records retain only checked classifications and numeric facts.
A dispatched write timeout becomes `write_outcome_unknown` and retains its
deadline details even when the program catches the failure. The final program
error includes the first timeout in `details`; multiple write timeouts also
appear in `timeouts`, bounded to ten entries.

**L3.** Every execution runs under a wall-clock deadline that includes time
spent waiting on host calls. Expiry ends the run with an execution error and no
partial result; the deadline's length is executor configuration (`X1`). Above
it sits a ceiling connecta enforces outside the sandbox, `execute.watchdogMs`
(120 s by default, above both executors' own deadlines), because an executor's
deadline may live inside the sandbox it is meant to stop: a wedged Dynamic
Worker never fires its in-isolate timer. A run whose executor has not settled
by the ceiling ends as a non-retryable `timeout` whose message calls
the sandbox unresponsive, with no partial result, and its admission lease is
released, so wedged runs cannot fill the code pool. Raising an executor's
deadline past the ceiling means raising the ceiling too.

**L4.** Per-execution bounds that are contract, identical in both executors
because connecta enforces them above the sandbox:

| Bound | Value |
| --- | --- |
| Host calls per execution, shared by `search`, `describe`, and `call` | 20 by default, `execute.maxHostCalls` |
| Trusted-pool writes per run, on top of the host calls they also spend (`W10`) | 10 by default, `execute.maxWrites` |
| Deadline per host call | 15 s, `execute.hostCallTimeoutMs`; one deadline covers catalog resolution, admission, and the connector call |
| Discovery page | ≤ 100 tools, ≤ 256,000 serialized bytes |
| `describe` addresses | ≤ 100 |
| `describe` nearby suggestions | ≤ 3 canonical addresses per failed entry |
| Caller text echoed by `describe` recovery | ≤ 512 UTF-8 bytes per field, plus `…` |
| Result | 24,000 serialized characters |
| Logs presented to the model | 4,000 characters |

Every `call`, `search`, and `describe` spends one host call on entry, before
resolution, validation, or dispatch. Catching a local refusal refunds nothing.
The first call beyond the budget ends the host run with one non-retryable
`budget_exceeded` (`E2`). Its bridge stays pending until lease disposal so guest
`try/catch` cannot swallow it. Later host access, including `emit`, stops; pending
replies are withheld. The refusal reaches no connector, returns no partial result,
and discards accepted emits (`M4`). Calls still resolving or awaiting admission
are cancelled, including trusted-pool writes past their gate. Dispatched trusted-pool writes
drain under `W9`; unknown outcomes retain precedence. The lease then releases:
QuickJS terminates its child, and the Worker adapter disposes RPC and loader
handles independently of the guest deadline. Workers guest computation may
continue briefly, including a timer escaping the bridge (`X3`), with no host
access. The Promise executor contract carries typed failures separately from guest values.

The failure adds payload-free `hostCalls: { attempted, admitted, succeeded, failed }`
without diagnostics. `attempted` includes the first refusal, normally 21; `admitted`
counts the 20 calls past the gate, local refusals included. `succeeded` and `failed`
count outcomes at response time, the budget refusal and abandoned pending calls
as failed, so `succeeded + failed === attempted`. `emit` and later attempts are
excluded; no budget refills.

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
is executor-owned untyped text, not a Connecta host failure (`E1`). An
over-bound *result* names the address the program called rather than only the
generic bridge function; an over-bound *argument* payload is refused before it
is parsed, so it names no address at all.

**L7.** Executions are admitted, not queued indefinitely: bounded concurrency
plus a bounded queue with a wait timeout. Overload is a retryable
`executor_overloaded` carrying `retryAfterMs`; cancellation and shutdown are
terminal. Admission happens *before* any catalog or provider is built, so a
queued request holds no state.

**L8.** Result, log, host-call, and emission budgets are deployment configuration.
A call may request `timeoutMs` just as a direct call does; the guest deadline is
capped by the time remaining before the program watchdog. `execute_code`'s description states the host-call
budget and the per-call deadline — the ones a program must plan around before it
runs. The result and log caps live here and in the truncation notice itself
(`R2`, `R5`).

## Activity

**V1.** One payload-free activity event per attempted call, with
`source: "execute_code"` — every dispatched call plus every local refusal: a
read-only refusal, an unknown tool, an unloadable catalog, a missing credential,
an address no connector owns. Ten tools called is ten events, as legible as ten
`call_tool` calls, which makes moving work into the sandbox an optimization
rather than a blindfold. An exhausted host-call budget is the exception: `L4`
refuses that attempt above the invocation path, so it is charged but records no
event.

**V2.** Each event carries `connectorId`, `toolName`, `address`, `source`,
`outcome` (`success`, `error`, `timeout`, `cancelled`), `durationMs`,
`attempts`, and `errorCode` when the call *failed* — plus request, actor, and
server identity. Rows written before
[#672](https://github.com/zackbart/connecta/issues/672) may also carry the
`paused` and `approved` outcomes, `source: "resume_execution"`, and an
`approval` scope; readers still render them, and nothing emits them. Typed codes derive an optional `friction`: `tool_not_found`,
`schema_retry`, `destructive_reroute`, or `auth_required`. The fifth class,
`result_too_large`, cannot reach an `execute_code` event: it belongs to a
`call_tool` result too large to return inline, and a program's own return is
refused paging by design rather than truncated into friction. There is nowhere
to put arguments, results, program source, or raw error text; a caught failure
is still recorded. `address` is canonical (`A1`) where a tool resolved,
otherwise the name the program used — the honest record of what was attempted.

**V3.** A call whose connector does not exist is recorded at the address as
written, *provided* it split into the two fields activity keeps — one with no
interior dot records nothing. An invented id is the address mistake an operator
most needs to see, but recording it as written puts caller-authored text in
fields that are otherwise operator- and connector-authored, so `connectorId`
and `toolName` clamp at 128 UTF-8 bytes (`address` at 257) with a `…` marker:
payload-free *by construction* means the event has nowhere to put a payload.

**V4.** The execution itself emits no event. It has no address, and its one
distinctive artifact is the program source — exactly what a payload-free history
must never keep.

**V5.** A trusted-pool write a program issues after it has already returned is not
sent and records nothing: it was never an attempt (`W9`).

## Writes

Pool trust belongs to deployment code. The default `/mcp` endpoint uses
`trust: "read-only"`; each named pool has its own `trust`, also defaulting to
`"read-only"`. A trusted default endpoint does not make named pools trusted.
The default preserves refusal of ordinary program writes and removes the old
artifact exemption. A deployment must opt into program writes explicitly.

```ts
createConnecta({
  connectors, executor,
  trust: "read-only",
  pools: {
    automation: { tools: ["posthog", "artifacts"], trust: "trusted", grant },
  },
  classification: {
    posthog: { exec: "read" }, // only for a deployment with a read-only exec contract
    vendor: { mislabeled_update: "write" },
  },
});
```

The registry computes one `classifyTool` verdict on each request-scoped
published catalog entry. It caches and persists only raw downstream facts.
Every caller consumes that stored verdict. Config cannot classify an individual
invocation's arguments: marking a mixed entry point read is an assertion about
all calls this deployment can make through it.

| Precedence | Evidence | Result |
| --- | --- | --- |
| 1 | Exact deployment `classification[connectorId][toolName]` | `read` or `write`, even over a stale provider review |
| 2 | `Connector.classification` provider review | Reviewed writes remain writes; a stale schema digest makes a read a write; an explicit downstream contradiction also invalidates a reviewed read |
| 3 | Downstream annotations | Read only when `readOnlyHint === true && destructiveHint !== true`; otherwise write |

Unknown connector override keys fail construction. Unknown static tool keys
fail construction; unknown remote tool keys fail publication of the whole
catalog. Overrides are exact tool names, including names containing dots.
They are never inferred from descriptions or arguments.

**W9.** Programs in trusted pools may write. A dispatched write is awaited even
if the program does not await it, bounded by its host-call deadline. A write
that reaches accounting after the program settles is not sent. An unanswered
write makes the run fail `write_outcome_unknown` with
`writes: { succeeded, failed, unknown }`, regardless of its return value.
A failed program that already wrote carries those counts on its error. No
write is automatically retried, including an ambiguous timeout. A downstream
refusal or a tool's `isError` can establish failure; a timeout or an unanswered
transport failure leaves the outcome unknown.

**W10.** `execute.maxWrites`, default 10, bounds writes in trusted programs in
addition to the host-call budget. It is checked after argument validation and
before admission, so an over-budget write spends no permit.

**W12.** `trusted` endpoints annotate `execute_code` as a write and permit
program writes. `read-only` endpoints annotate it as read-only and refuse
program writes before validation, with `call_destructive_tool` as the recovery.
`call_tool` accepts only reads in either tier; `call_destructive_tool` may send
writes in either tier. Approval belongs to the host. Trust grants no tool or
connector access and cannot be set by guest code, request arguments, or a
downstream catalog. `execute.approval`, `Connector.approval`, and per-tool
approval exemptions are removed. `W1`–`W8` and `W11` remain retired.

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
`AbortSignal` and kills the child — SIGTERM, then SIGKILL if it has not exited
within a second — and releasing a lease whose child is still running recycles
that child, so a run the watchdog abandons (`L3`) ends too.
Upstream `execute()` takes no signal; its guest timeout may never settle after
the parent response ends. `workerExecutor()` owns each lease's RPC and loader
handles: release disposes them, detaches host functions, and settles the adapter's
promise independently of upstream evaluation. Guest computation may continue
briefly until platform teardown, but no late return, callback, `finally`, call,
or emit changes the finished host result. Disposal releases request resources;
it does not guarantee a synchronous guest-CPU kill.

**X4. Log rendering and capture.** QuickJS JSON-stringifies non-string arguments
and captures `log`, `info`, `warn`, `error`, and `debug`; the Dynamic Worker
renders arguments with `String()` (so an object logs as `[object Object]`) and
captures only `log`, `warn`, and `error`, prefixing the latter two. Only the
three captured everywhere are contract (`R5`); rendering is not. QuickJS streams
each accepted entry within the existing IPC envelope bound while retaining its
per-entry and cumulative child caps, and the parent keeps at most 4,001 joined
characters for failure recovery — one beyond the presentation cap, so truncation
stays visible. On a normal reply the child's complete log array wins and the two
copies are never joined; on termination or IPC failure the parent attaches its
retained prefix to the thrown error. Admission rejection before the program
starts has no guest logs to recover.

**X5. Leftover authority.** QuickJS blocks imports and has no `fetch`,
`process`, timers, `crypto`, or `WebSocket`, and its Node child starts with an
explicit environment holding only `TZ=UTC`, so local time matches a Dynamic
Worker's, rather than inheriting
deployment variables or `NODE_OPTIONS`. A Dynamic Worker exposes runtime-only
builtins through `import()` and `process.getBuiltinModule()`, including `node:path`,
`node:crypto`, `node:net`, `node:tls`, `node:dns`, and
`cloudflare:workers`; the upstream set drifts, so that is not an allowlist.
The adapter refuses `node:module` and `node:process` imports and removes their
builtin lookup routes, so `createRequire` cannot resolve runner modules.
The supported adapter uses `new DynamicWorkerExecutor({ loader, timeout })`.
`bindings`, `modules`, and `globalOutbound` each grant ambient configuration,
code, or egress. Under it, `process.env` and `cloudflare:workers.env` are empty,
and lexical `this.env` is undefined; `node:fs`, `node:http`, and `node:https` are
unavailable through either access route; external `fetch`, `WebSocket`,
`node:net`, and `node:tls` fail with workerd's outbound-denial error; DNS lookup
ends unresolved; and `fetch("data:...")` resolves locally. `P2` is the portable
contract: programs use none of this runtime-only authority, timers and `crypto`
included, because the same code fails on QuickJS, and the `execute_code`
description and served `usage` skill say so before an agent writes code.

**X6. Stall detection.** QuickJS notices a program awaiting something that can
never settle and fails fast; the Dynamic Worker waits for its deadline.
Requiring the fast failure would require a host-driven job loop — not a
reasonable demand on a platform sandbox.

**X7. Value codec.** QuickJS is JSON-only; `@cloudflare/codemode` tunnels binary
values through a tagged envelope, so a `Uint8Array` may survive there. `P3` is
the contract: JSON-serializable values, or the program is Workers-only.

**X8. Unknown properties.** The guest namespace exposes only the six documented
functions. Unknown and inherited members are absent on both executors; calling
one is a guest `TypeError` under `E6`. Engine message text is not contract.

**X9. Refusing a value outside JSON.** The Dynamic Worker ends the run with an
error when a program returns something its codec cannot carry. QuickJS converts
lossily instead — a cyclic object comes back as the string `"[object Object]"`,
because the guest-to-host dump happens before any serializer can object.
Normalizing that would spend real CPU on every program to improve the error
message of a program that is already wrong. `P3` is the contract: neither
behavior returns the value.

**X10. Per-host-call payload bound.** `L6`'s 256 KiB ceiling on a host call's
arguments and result is QuickJS's, enforced at its IPC boundary. The Dynamic
Worker has no documented equivalent; Workers RPC limits apply and connecta adds
none, because that boundary is an isolate-to-isolate call rather than a
`process.send` with a hard ceiling. A program returning a quarter-megabyte from
one tool call therefore fails on Node and may succeed on Workers — reduce inside
the program either way (`R1`).

**X12** described a paused sandbox and left with pausing
([#672](https://github.com/zackbart/connecta/issues/672)); the id stays retired.

**X11. Typed host rejection.** QuickJS creates and retains guest Error handles
in its host bridge and compares handles when the program rejects. The Worker
adapter stores each typed failure in a per-run host map under a random UUID.
Its private entrypoint associates that ID with the guest Error and returns only
the ID through Worker Loader RPC. The host resolves it to its own record before
upstream result shaping; unknown or forged IDs attach no typed details, and IDs
from previous runs cannot resolve. Rethrowing an earlier call's Error retains
that call's record. The guest receives a separate copy for catching errors.
Both construct `failure.call` from host-retained values, never from a guest
result, parsed guest-realm object, or printed text. The Worker codec checks own
binary-envelope properties, and completion uses captured array iteration even
when the executor runs without the Connecta guest prelude. Host failure details are
bounded before bridging (`E1`), including JSON escapes. No frame parser or
prose matching participates in classification. The guest cannot import runner
modules or repeat privileged initialization. QuickJS checks host interrupt and
deadline facts before describing a rejection. It retains a private native Error
brand check and reads only own string data descriptors for diagnostics; guest
accessors, serialization hooks, and Proxy traps do not run. Other thrown objects
receive a fixed description.

## Verification

`test/guest-contract-cases.ts` runs on QuickJS in `test/guest-api-contract-quickjs.node.test.ts`
and on the Worker adapter with a real Miniflare Loader in `test/guest-api-contract.test.ts`.
Titles name clauses; executor-independent clauses run in both arms.
`test/codemode-compat.test.ts` pins upstream shape compatibility, minified upstream
rejection, and branded adapter acceptance across module copies.

| Clauses | Test |
| --- | --- |
| `P1`, `P5` | both guest-contract executors (TypeScript syntax, trailing terminators, wrapper recovery), `test/program-source.test.ts` (which semicolons and wrappers are recovered), `test/quickjs-executor.node.test.ts` (`normalizeCode`) |
| `P2`, `X5` | `test/guest-api-contract.test.ts` (Dynamic globals plus loader-only filesystem, HTTP, environment, egress, DNS, and local `data:` boundaries), `test/guest-api-contract-quickjs.node.test.ts` (exact absent globals and blocked imports), `test/quickjs-child-stderr.node.test.ts` (a child-process environment holding only `TZ=UTC`), `test/deployment-shapes.node.test.ts` (loader-only Worker construction) |
| `P3`, `X9` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` |
| `P4` | `test/guest-api-contract.test.ts` (no cross-run leakage), `test/execute.test.ts` (one catalog load per connector per execution) |
| `A1`, `A2` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (canonical addressing), `test/server.test.ts` (bounded live connector inventory) |
| `S1`, `S1a`, `S2` | `test/guest-api-contract.test.ts` (flat page, connector guides, schema keys, unfiltered browse), `test/execute.test.ts` (guide pagination/partial/no-match behavior and `$ref`/`allOf`), `test/meta-tools-search.test.ts` (mixed complete/partial ranking, stable pagination, the two safety classes), `test/typescript-signatures.test.ts` (the TypeScript format over provider and pathological schemas, search/describe parity, observed labeling), `test/typescript-signatures-parse.node.test.ts` (every rendering parses) |
| `S3` | `test/guest-api-contract.test.ts` (typed uncaught bound), `test/execute.test.ts` (count limits, fan-out bound) |
| `S4` | both guest-contract executors (ordered mixed describe results with unknown-address, unknown-tool suggestion, and catalog-failure details), `test/meta-tools-search.test.ts` (top-level routing, no-suggestion, catalog-failure, and hostile-input bounds) |
| `S5`, `S6` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`unwrapMcpResult`, fail-closed annotations, activity parity) |
| `S7` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (parallel calls and shared admission) |
| `S8`, `E1`, `X11` | both guest-contract executors (caught call, discovery, utility, removed-function, and forgery cases; typed promise rejections), `test/quickjs-executor.node.test.ts` (oversized messages, private transport, forged outcomes) |
| `S9` | `test/result-shapes.test.ts` (value exclusion, bounds, merging, LRU and time expiry, runtime isolation, read-only admission, declared precedence, definition invalidation, unwrapped MCP results, discovery provenance, copy isolation, failure isolation) |
| `E2`, `E8` | `test/guest-api-contract.test.ts` (code → `retryable`, caught, parallel, and uncaught validation recovery, a conflict's bounded `current`), `test/meta-tools-call.test.ts` (direct, destructive, provider fallback), `test/validate.test.ts` (bounded payload-free findings), `test/errors.test.ts` |
| `E3`, `E4` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`auth_required`, destructive reroute), `test/program-writes.test.ts` (the refusal's `nextAction`, nothing sent, a caught refusal) |
| `E5` | `test/guest-api-contract.test.ts` (execution-failure channel, in-flight `cancelled`), `test/execute.test.ts` (admission), `test/executor-admission.test.ts`, `test/quickjs-executor.node.test.ts` (mid-run shutdown) |
| `E6`, `X8` | `test/guest-api-contract.test.ts` (unknown and inherited members, retained error identities), `test/quickjs-executor.node.test.ts` |
| `E7` | `test/guest-api-contract.test.ts` (refusals about a `503`-named connector), `test/errors.test.ts` |
| `R1`, `R2`, `R3` | `test/guest-api-contract.test.ts` (pass-through, truncation is success, envelope fits the cap and is idempotent) |
| `R4`, `M6`, `M9` | verdicts; `R2`'s guard, `M1`'s strict typing, and `M2`'s collect-then-deliver are their enforcement |
| `R5` | `test/guest-api-contract.test.ts`, `test/quickjs-log-limits.node.test.ts` |
| `R6`–`R8` | `test/guest-api-contract.test.ts` (normal result keys), `test/execute.test.ts` (opt-in operation aggregates, failure paths, payload exclusion) |
| `Y1`, `Y2`, `Y3` | `test/guest-api-contract.test.ts` (one attempt per call, retryable flags by code) |
| `Y4` | `test/meta-tools-call.test.ts`, `test/call-admission.test.ts` (one attempt, retry hints, caller reissue) |
| `L1`, `L2` | `test/guest-api-contract.test.ts` (in-flight call fails `cancelled`), `test/execute.test.ts` (cancels outstanding host calls, discovery included, and refuses discovery after the run; a cancelled wedged executor, or one whose `acquire()` ignores the signal, returns promptly and releases its lease) |
| `L3`, `X1` | `test/guest-api-contract.test.ts` (short-deadline executors), `test/execute.test.ts` (the watchdog ends a never-settling executor, frees the default pool, spares a slow run, and falls back from an unusable value) |
| `L4`, `L8` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (shared discovery/call budgets and terminal catch-and-continue loops and queued-write cancellation on both executors), `test/worker-budget-response.node.test.ts` (native handle disposal and admission recovery across completed HTTP responses) |
| `L5`, `L7`, `X2` | `test/quickjs-executor.node.test.ts` (CPU, heap), `test/execute.test.ts` and `test/executor-admission.test.ts` (bounded admission and queue) |
| `L6`, `X10` | `test/quickjs-executor.node.test.ts` (bridge and IPC bounds for arguments and result; the address in the over-bound message), `test/quickjs-child-stderr.node.test.ts` (outer reply serialization failure settles the call) |
| `V1`–`V4` | `test/guest-api-contract.test.ts` (dispatched calls, every refusal class including an address no connector owns, the friction each derives, no event for the execution itself), `test/activity.test.ts` (the shared code → friction table, the identity clamp, the one-attempt floor), `test/operator-view.test.ts`, `test/sql-storage-contract.ts`, run by `test/d1-storage.node.test.ts` and `test/sqlite-storage.node.test.ts` (historical pause and approval rows still render and round-trip) |
| `V5`, `W9` | `test/program-writes.test.ts` (an unawaited trusted-pool write finished and recorded, its unknown outcome reported, counts on a failed program, the classification table), `test/invocation-pipeline.test.ts` (the gate after validation, an unrecorded refusal) |
| `W10`, `W12` | `test/program-writes.test.ts` (a trusted-pool write runs and every other write keeps `E4`, the write budget, pool trust and override precedence, `call_tool` still refusing, search and describe verdicts, construction refusals), `test/artifacts-connector.test.ts` (trusted-pool artifact writes and read-only refusal), `test/operator-ui-model.test.ts`, `test/browser/operator-ui.spec.ts` (the badge) |
| `M1` | `test/guest-api-contract.test.ts` (invalid emits throw catchably, accept nothing), `test/execute-emit.test.ts` (every rejected shape) |
| `M2`, `M3` | `test/guest-api-contract.test.ts` (delivery order, truncated return plus delivered blocks), `test/execute-emit.test.ts` (envelope, `structuredContent`, byte-for-byte no-emit path) |
| `M4` | `test/guest-api-contract.test.ts` (discard is visible), `test/execute-emit.test.ts` (structured and plain paths), `test/quickjs-executor.node.test.ts` (mid-run shutdown) |
| `M5`, `M7` | `test/execute-emit.test.ts` (both budgets fail the crossing block; host-call budget untouched) |
| `M8` | two arms passing one case table, `test/codemode-compat.test.ts` |
| `M10` | `test/execute-emit.test.ts` (aggregate present, numbers only, absent when nothing emitted) |
| `X4` | `test/guest-api-contract.test.ts` (string logs only), `test/quickjs-executor.node.test.ts` (logs before cancellation), `test/quickjs-child-stderr.node.test.ts` (crash, shutdown, deadline, IPC failure, bounded parent retention), `test/quickjs-log-limits.node.test.ts` (unchanged successful logs) |
| `X3`, `X6` | `test/quickjs-executor.node.test.ts` (cancels a running child, never-settling await), `test/execute.test.ts` (a wedged executor stops being awaited) |
| `X7` | `P3`'s tests; the Workers superset is deliberately unused |

The surface itself is checked by `test/server.test.ts` (the exact six-tool list),
`test/code-first-surface.test.ts` (construction, executor, removed tools, copy, and size),
and `test/program-writes.test.ts` (the retired pause options refused at construction).
