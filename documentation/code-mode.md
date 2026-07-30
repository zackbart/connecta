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

The `executor` passed to `createConnecta()` is the complete switch, and it selects
the whole surface rather than one tool
([#224](https://github.com/zackbart/connecta/issues/224)): with a live `Executor`,
`tools/list` is exactly seven — `execute_code`, `search_tools`, `call_tool`,
`call_destructive_tool`, `authorize_connector`, `get_result`, `skills`; without one
it is the nine base meta-tools, whose `list_connectors`, `describe_tools`, and
`batch_call` are what seven folds into `connecta.search`, `connecta.describe`, and
`connecta.batch`.

No feature flag, and no code tool advertised before it can be honored.
`surface: "classic"` beside an executor is the one override (ten tools, the eval
gate's incremental arm); `surface: "code-first"` without one throws at
construction rather than advertise an absent program surface.

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
[Node example](../examples/node/README.md) is enabled; remove its `executor` field
for the nine-tool compatibility deployment.

On Cloudflare Workers, the Worker Loader binding is both the paid capability and
the configuration switch:

```ts
createConnecta({
  ...(env.LOADER
    ? { executor: new DynamicWorkerExecutor({ loader: env.LOADER }) }
    : {}),
  // connectors, auth, storage…
});
```

Leave the binding absent on the Workers Free plan. Its absence must also be
represented as optional in the deployment's `Env` type. The
[Worker example](../examples/worker/README.md#code-mode) carries the complete
binding and package setup.

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
   `search`, `describe`, `call`, `batch`, and `__callNamespace` — see point 3.
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
  connector: "ci",                  // optional single-connector filter
  safety: "readOnly",               // or "approvalRequired" / "all"
  limit: 8,                         // 1–100, default 8
  offset: 0,
  fullDescriptions: false,
  includeSchemas: "compact",        // or "json"
  includeSchemaKeys: true,          // default true in code mode
});
```

**S1.** Returns one flat page: `{ tools, total, offset, limit, hasMore }`, plus `nextOffset` when more remains and `matchMode: "partial"` when no tool matched every term. Each entry in `tools` carries `address`, `name`, and — when requested — `description`, `inputSchema`, `outputSchema`, `annotations`, and the connector's `guide`. Compact shapes omit property prose, put required fields first, and cap each shape at 1,024 UTF-8 bytes; capped shapes remain structurally valid with `unknown` types plus `/* truncated */`, and carry `inputSchemaTruncated` or `outputSchemaTruncated`. Use `connecta.describe` (or JSON search) for omitted exact constraints.

**S1a.** `safety: "readOnly"` returns exactly the tools available through `connecta.call`, connector shortcuts, and `connecta.batch`; `"approvalRequired"` returns the complementary fail-closed class, including false, missing, and contradictory annotations. Omitted or `"all"` preserves the complete catalog. This filters rows only: it grants no authority and changes no admission decision.

**S2.** With schemas requested, a match whose input (or output) schema resolves
to an object shape also carries `inputKeys`, `requiredInputKeys`, and
`outputKeys`: the same names the rendered schema shows, ready to check before
building arguments. A schema that is not an object shape — a union, an array, an
unresolvable `$ref` — carries no lists rather than empty ones, because absent
means "read the schema" where `[]` would claim the tool takes no fields. The
lists come from the same walk that renders the compact schema, so a top-level
`$ref` resolves and an `allOf` composes rather than reporting an empty list
beside a schema that plainly shows fields; an object with no properties is the
one case where `[]` is the truth. This metadata is code-mode-only:
`search_tools` never carries it, and `includeSchemaKeys: false` buys the bytes
back.

**S3.** Discovery is bounded and the bounds throw rather than silently shrink: a
`limit` outside 1–100 is `invalid_args`, and a page whose serialized form
exceeds 256,000 bytes is `result_too_large`, each with a hint naming the ways to
ask for less. As with every failure, the *thrown* error carries only the message
(`E1`); the code appears when the failure escapes the program uncaught.

### connecta.describe

```js
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
field names `batch_call` uses. One failing call never rejects the batch, and more
than ten calls throws.

**S8.** `connecta.batch` is the classification channel: because a thrown host
error crosses the bridge as a bare message (`E1`), a batch of one is the supported
way for a program to *decide* something about a failure rather than report it.

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
1,800 bytes with three bytes spare.

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

**E4.** A read-only refusal is not a downstream failure. An unannotated,
write-capable, or destructive tool is refused in the sandbox with
`destructive_tool_requires_approval` and stays refused; the program returns and
the model crosses `call_destructive_tool`, where the host can ask a human.
Generated code cannot mint that capability.

**E5.** Failures of the *execution*, not of a call, never appear inside the
guest: admission rejection (`executor_overloaded`, retryable, with
`retryAfterMs`), cancellation (`executor_cancelled`), shutdown
(`executor_closed`), deadline expiry, and sandbox crashes end the run and are
reported to the model as an error result. One seam: a host call still in flight
when the run is cancelled fails with `cancelled`, catchable on the way out but
never worth acting on (`Y3`).

**E6.** An error the program raises itself — a `TypeError`, a call to a
`connecta` member that is not a provider function (including an inherited one
like `toString`), a `throw` of its own — ends the run with an error result
carrying that message. It is not typed, because it is not a connector failure.
One precedence rule: connecta recognizes an escaped tool failure by its message —
exactly first, by containment second — so a program that *wraps* a failure's
message in its own text still reports the underlying typed failure. Keeping the
type beats keeping the prose.

**E7.** `retryable` for the four codes connecta frames itself — `unknown_address`,
`unknown_tool`, `ambiguous_tool_alias`, `destructive_tool_requires_approval` — is
pinned false in code, never derived from the message. Those messages embed the
address asked for, and the heuristic that classifies *connector* errors matches
`503`, `429`, `temporar`; a connector named `svc-503` would otherwise turn a
policy refusal into `retryable: true`, the exact failure this contract prevents.

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

**R5.** `console.log`, `console.warn`, and `console.error` are captured in call
order and returned as a single `logs` string, capped at 4,000 characters with a
truncation marker. Logs survive failure — they ride along with the error result,
which is what makes them worth writing. How a non-string argument renders is not
contract (`X4`).

**R6.** Nothing else is added to a program's result. There is no timing or
diagnostics block; per-call durations live in activity (`V2`).

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

**V1.** One payload-free activity event per call that named a real connector,
with `source: "execute_code"` — every dispatched call, plus every refusal
connecta could attribute to a connector: a read-only refusal, an unknown tool on
a known connector, an ambiguous shortcut, a connector whose catalog could not be
loaded, a credential connecta could not supply, an exhausted host-call budget. A
program that calls ten tools is ten events — as legible as ten `call_tool` calls,
which is what makes moving work into the sandbox an optimization, not a
blindfold.

**V2.** Each event carries `connectorId`, `toolName`, `address`, `source`,
`outcome` (`success`, `error`, `timeout`, `cancelled`), `durationMs`,
`attempts`, and `errorCode` when there was one — plus the request's id, actor,
and server identity. It has nowhere to put arguments, results, program source,
or raw error text, by construction. A failure the program *caught* is still
recorded: the call happened. `address` is canonical (`A1`) for every call that
resolved to a tool; for the refusals that never resolved to one it is the name the
program used, which for a shortcut is the sanitized alias — the honest record of
what was attempted.

**V3.** A call whose connector does not exist — an unknown address — emits
nothing. There is no connector to attribute it to.

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
  failure. Additive, and it reuses `batch_call`'s field names so one shape covers
  both surfaces.
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
| `S1`, `S2` | `test/guest-api-contract.test.ts` (flat page, schema keys, and the unfiltered browse that replaces `list_connectors`), `test/execute.test.ts` (`$ref`/`allOf`) |
| `S3` | `test/guest-api-contract.test.ts` (typed uncaught bound), `test/execute.test.ts` (count limits, fan-out bound) |
| `S4` | `test/guest-api-contract.test.ts` (unknown address in `describe`) |
| `S5` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`unwrapMcpResult`) |
| `S6` | `test/execute.test.ts` (fail-closed annotations, activity parity) |
| `S7` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (batch cap) |
| `S8`, `E1` | `test/guest-api-contract.test.ts` (typed batch outcomes) |
| `E2` | `test/guest-api-contract.test.ts`, `test/errors.test.ts` (code → `retryable`) |
| `E3` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (`auth_required`) |
| `E4` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (destructive) |
| `E5` | `test/guest-api-contract.test.ts` (execution-failure channel, in-flight `cancelled`), `test/execute.test.ts` (admission), `test/executor-admission.test.ts` |
| `E6`, `X8` | `test/guest-api-contract.test.ts` (unknown and inherited members, wrapped-message precedence), `test/quickjs-executor.test.ts` |
| `E7` | `test/guest-api-contract.test.ts` (refusals about a `503`-named connector), `test/errors.test.ts` |
| `R1`, `R3` | `test/guest-api-contract.test.ts` (pass-through, truncation is success) |
| `R2` | `test/guest-api-contract.test.ts` (envelope fits the cap, idempotent) |
| `R4` | verdict; `R2` is its enforcement |
| `R5` | `test/guest-api-contract.test.ts`, `test/quickjs-log-limits.test.ts` |
| `R6` | `test/guest-api-contract.test.ts` (result keys) |
| `Y1` | `test/guest-api-contract.test.ts` (one attempt per call) |
| `Y2`, `Y3` | `test/guest-api-contract.test.ts` (retryable flags by code) |
| `Y4` | `test/meta-tools.test.ts` (`retryBackoffMs`, `MAX_RETRY_BACKOFF_MS`) |
| `L1`, `L2` | `test/guest-api-contract.test.ts` (in-flight call fails `cancelled`), `test/execute.test.ts` (cancels outstanding host calls) |
| `L3`, `X1` | `test/guest-api-contract.test.ts` (short-deadline executors) |
| `L4`, `L8` | `test/guest-api-contract.test.ts`, `test/execute.test.ts` (budgets) |
| `L5`, `X2` | `test/quickjs-executor.test.ts` (CPU, heap) |
| `L6`, `X10` | `test/quickjs-executor.test.ts` (bridge and IPC bounds for arguments and result; the address in the over-bound message) |
| `L7` | `test/execute.test.ts`, `test/executor-admission.test.ts` |
| `V1`, `V2` | `test/guest-api-contract.test.ts` (dispatched calls, and the four refusal classes that name a connector), `test/activity.test.ts` |
| `V3`, `V4` | `test/guest-api-contract.test.ts` (no event without a connector) |
| `X3` | `test/quickjs-executor.test.ts` (cancels a running child) |
| `X4` | `test/guest-api-contract.test.ts` (string logs only) |
| `X6` | `test/quickjs-executor.test.ts` (never-settling await) |
| `X7` | `P3`'s tests; the Workers superset is deliberately unused |

The surface itself is checked by `test/server.test.ts` (the exact seven, nine, and
ten tool lists) and `test/code-first-surface.test.ts` (the fold's construction
rules, refusals, copy, and measured size). The release audit compares the same
two shapes:

```sh
npm --prefix eval/current-version run audit
npm --prefix eval/current-version run audit -- --executor disabled
```
