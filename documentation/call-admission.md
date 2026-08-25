# Downstream call admission

One admitted MCP request can fan out into many downstream calls. A program
calls tools from loops, from `connecta.batch`, and from branches the caller
never saw. The deployment-wide request pool
([request admission](./request-admission.md)) bounds the envelope; it cannot
see anything inside it. A provider that publishes "60 requests per minute"
needs a bound that counts calls, not requests.

So a connector may declare `callAdmission`: an optional per-runtime policy
around its own `Connector.callTool` attempts.

```ts
const projects = api("projects", {
  description: "Projects — issues and reports",
  callAdmission: {
    // Plural-ready public shape; this release requires exactly one rule.
    rules: [{
      maxConcurrency: 5,
      maxQueueSize: 10,       // default 32
      queueTimeoutMs: 2_000,  // default 5_000
      retryAfterMs: 1_000,    // concurrency-overload hint
      budget: { kind: "rolling-window", maxCalls: 60, windowMs: 60 * 60_000 },
      partitionKey({ toolName, args }) {
        return projectIdFor(toolName, args);
      },
    }],
    maxPartitions: 1_024,     // default
  },
  tools: [/* … */],
});
```

`api()`, `remoteMcp()`, and a hand-written `Connector` all accept it. Maintained
prebuilt connections set it themselves — but only when the provider documents a
number, which is convention
[P12](./provider-conventions.md#p12--declare-an-admission-budget-only-when-the-provider-documents-a-number).
An invented budget is a throttle with no source.

## Policy contract

`maxConcurrency` and `budget` are independently optional, but a rule must
declare at least one — a rule that bounds nothing is a typo, not a policy.
Queue settings require `maxConcurrency`, because there is nothing to queue
behind without it, and `maxQueueSize: 0` is the fail-fast shape. Numeric bounds
are finite whole numbers: concurrency, timeouts, budget values, and
`maxPartitions` are positive; queue size and `retryAfterMs` may be zero.
`budget.kind` must be `"rolling-window"`. Everything invalid throws during
registry construction.

The container is an array so a later release can add atomic rules over
different partition dimensions, but **exactly one rule** is accepted today.
Zero or several throw rather than imply semantics the runtime does not have.
Multiple rules cannot be faked as sequential leases: consuming one rolling
token before a later rule refuses would charge a call that never reached the
provider — the exact accounting error a budget exists to prevent.

Omitting `partitionKey` gives one connector-wide partition. A callback runs
synchronously on model-supplied arguments and must return a non-secret string
of at most 128 UTF-8 bytes. A throw or an invalid return is a typed local
`connector_call_failed`; neither the callback text nor the arguments are
surfaced. The callback is operator code and may abort the caller synchronously,
so cancellation is rechecked after it returns — otherwise a cancelled call
could still consume a budget entry.

State retains the returned key, bounded timestamps, counters, signals, and
promise continuations. Nothing copies arguments into the limiter; the queued
waiter closure deliberately captures the `AbortSignal` rather than the input
object, because closing over the input would retain its `args`. At most
`maxPartitions` states are live, and an idle state is evicted only once its
active calls, queue, and rolling-window history are all empty — eviction must
not be a way to reset a live budget. Exhausted partition capacity is
`rate_limited` with the configured retry hint, not a silent unbounded map.

## Attempt semantics

The registry owns the limiter, and `InvocationService.invoke` acquires a permit
immediately before `Connector.callTool` and releases it in `finally`. Both call
paths — top-level `call_tool` and a program's `connecta.call` or
`connecta.batch` — reach that same seam, so a program cannot buy itself a
second limit by taking the other route.

- **A retry is another attempt.** It reacquires and can consume another budget
  entry, because the provider counts it that way. Backoff never holds a
  concurrency permit.
- **A proactive short-window `rate_limited` refusal** participates in the
  ordinary retry policy and counts as an attempt. Activity records the final
  outcome and the attempt count.
- **A queued cancellation consumes nothing.** It is removed from the queue with
  no rolling-window entry charged.
- **Caller cancellation is terminal.** It is non-retryable, releases its
  permit, records a `cancelled` activity outcome, and is not connector-health
  evidence.
- **Budget exhaustion fails immediately** as `rate_limited`, `retryable: true`,
  with the exact `retryAfterMs` to the next free slot. Concurrency overflow
  uses the configured hint instead, because there is no exact answer.
- **Local refusals are not connector health failures.** They are activity
  errors, but no provider call happened, so poisoning the connector's health
  with them would report the limiter's success as the downstream's failure.
  `isCallAdmissionError` is what keeps `recordFailure` out of that path.

Only tool execution is covered. Catalog `listTools`, status probes, credential
checks, and authorization operations stay outside the budget: they are not the
calls a provider is rate-limiting, and charging discovery for them would make
a program's first search cost it capacity to act.

Queue admission and connector execution have separate clocks. `queueTimeoutMs`
bounds only the wait for a permit; a per-attempt `timeoutMs` starts after
admission. A saturated call can therefore take up to their sum. With
`diagnostics: true`, `admissionMs` reports the permit wait and `connectorMs`
the admitted attempt — which is the only way to tell "the provider is slow"
from "we are throttling ourselves".

## Enforcement scope

This is deliberately **per-runtime**. It completely contains fan-out inside one
request, including a wide `connecta.batch` in one Worker isolate. A rolling
budget is exact inside one Node process or Worker isolate, and best-effort
across isolates, replicas, and restarts.

KV cannot coordinate the invariant without atomic operations, and this release
adds no Durable Object or other distributed coordinator. The async typed permit
is the seam a coordinator would slot into later; until then the guide says what
the bound actually is rather than implying a global one.

## Observations

`/health` exposes payload-free aggregates at
`admission.downstreamCalls.connectors.<id>`: retained partition count, current
active and queued gauges, cumulative admitted/queued/rejected/rate-limited/
cancelled counts, and queue-wait count, total, and maximum. The open endpoint
never exposes partition keys, tool arguments, or results — a partition key can
be a customer identifier, which is precisely why it stays out of an unauthenticated
payload. Ordinary payload-free activity records the final call outcome and its
typed error code.

## Tests that enforce this

| Invariant | Suite |
| --- | --- |
| Independent partitions, exact rolling-window reset and retry, queued cancellation charging no budget, synchronous cancel during partition derivation, validated values snapshotted rather than read from mutable config, bounded partition state and contained `partitionKey` failures, empty and multi-rule policies refused | `test/call-admission.test.ts` (controller) |
| One base-registry limiter shared by direct and program calls, batch bounds with input order preserved, cancellation threading, no dispatch or retry or health poisoning after cancellation, short proactive windows retried without poisoning health, payload-free `/health` aggregates | `test/call-admission.test.ts` (integration, Node + Workers) |
| Where provider budgets are allowed to come from at all | [provider conventions P12](./provider-conventions.md#p12--declare-an-admission-budget-only-when-the-provider-documents-a-number), [provider audit](https://github.com/zackbart/connecta/blob/main/records/provider-audit.md) |
