# Downstream call admission

One admitted MCP request can fan out into many downstream calls. `batch_call`
starts its children concurrently, while `execute_code` may call tools from
loops or `connecta.batch`. The deployment-wide request pool cannot see limits
hidden inside that envelope.

A connector may therefore declare `callAdmission`, an optional per-runtime
policy around its `Connector.callTool` attempts:

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
      budget: {
        kind: "rolling-window",
        maxCalls: 60,
        windowMs: 60 * 60_000,
      },
      partitionKey({ toolName, args }) {
        return projectIdFor(toolName, args);
      },
    }],
    maxPartitions: 1_024,     // default
  },
  tools: [/* … */],
});
```

The same option is accepted by `api()`, `remoteMcp()`, and a hand-written
`Connector`.

## Policy contract

`maxConcurrency` and `budget` are independently optional, but a rule must
declare at least one. Queue settings require `maxConcurrency`;
`maxQueueSize: 0` is fail-fast. Numeric bounds are finite whole numbers:
concurrency, timeouts, budget values, and `maxPartitions` are positive; queue
size and `retryAfterMs` may be zero. Invalid policies throw during registry
construction.

The public container is an array so a future release can add atomic rules with
different partition dimensions, but **exactly one rule** is accepted today.
Zero or multiple rules throw rather than imply semantics the runtime does not
provide. Multiple rules cannot be implemented as sequential leases: consuming
one rolling token before a later rule refuses would charge a call that never
reached the provider.

Omitting `partitionKey` creates one connector-wide partition. A callback runs
synchronously on model-supplied arguments and must return a non-secret string
of at most 128 UTF-8 bytes. Connecta catches throws and invalid returns as a
typed local `connector_call_failed`; callback text and arguments are not
surfaced.

Limiter state retains only the returned key, bounded timestamps, counters,
signals, and promise continuations. At most `maxPartitions` live states are
retained. An idle state is evicted only after its active calls, queue, and
rolling-window history are empty, so eviction cannot reset a live budget.

## Attempt semantics

The base `Registry` owns the policy. Toolkit views delegate to it, so calls to a
shared connector contend on the same partitions instead of gaining one limit
per view. Both call paths acquire an async permit immediately before their
existing `Connector.callTool` and release in `finally`; their retry, timeout,
sandbox-unwrapping, and result-shaping machinery otherwise stays separate.

- `call_tool`, each `batch_call` child, and every `execute_code` host call share
  the limiter. Batch settlement still preserves input order and isolates
  refused children.
- A retry is another downstream attempt, so it reacquires and can consume
  another budget entry. Backoff never holds a concurrency permit.
- A proactive short-window `rate_limited` refusal participates in `runCall`'s
  existing safe retry policy and counts as an attempt. The final activity event
  reports the resulting success or refusal and attempt count.
- Concurrency may queue within the configured bounds. A queued cancellation is
  removed without consuming a rolling-window entry.
- Caller cancellation before or during an active attempt is non-retryable,
  releases its permit, records a `cancelled` Activity outcome, and does not
  count as connector-health failure.
- Budget exhaustion fails immediately as `rate_limited`, `retryable: true`,
  with exact `retryAfterMs`; concurrency overflow uses the configured retry
  hint.
- Local admission refusals are activity errors but are not connector-health
  failures: no provider call occurred.

Only tool execution is covered. Catalog `getTools`/`listTools`, status probes,
credential checks, and authorization operations remain outside the call budget.

Queue admission and connector execution have separate clocks. `queueTimeoutMs`
bounds only the wait for a permit; the per-attempt `call_tool.timeoutMs` starts
after admission. A saturated call can therefore take up to their sum before
result processing and other small overheads. With diagnostics enabled,
`admissionMs` reports the permit wait and `connectorMs` reports the admitted
attempt.

## Enforcement scope

This is deliberately a **per-runtime** policy. It completely contains fan-out
inside one request, including a large batch in one Worker isolate. A rolling
budget is exact inside one Node process or Worker isolate but is only
best-effort across multiple isolates, replicas, or restarts.

KV cannot safely coordinate the invariant without atomic operations. This
release does not add a Durable-Object or other distributed coordinator; the
async typed permit seam leaves room for a separately designed coordinator
later. See [decisions](./decisions.md).

## Observations

`/health` exposes payload-free aggregates at
`admission.downstreamCalls.connectors.<id>`:

- retained partition count and current active/queued gauges;
- cumulative admitted, queued, rejected, rate-limited, and cancelled counts;
- queue-wait count, total, and maximum.

The open endpoint never exposes partition keys, tool arguments, or results.
Ordinary payload-free Activity records the final call outcome and typed error
code.
