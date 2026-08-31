# Request admission

Connecta bounds work at the Web-standard request boundary — before inbound
auth, before the MCP server exists, before any catalog is touched. A burst
therefore meets an explicit active count and an explicit queue instead of
asking traffic shape and the runtime allocator to pick the process high-water
mark.

There are two pools here and a third elsewhere. This guide covers the first
two: the deployment-wide `/mcp` pool and the fallback code pool. Per-connector
downstream bounds are [call admission](./call-admission.md), which is a
different question — request admission bounds the whole MCP envelope, call
admission bounds the individual `Connector.callTool` attempts fanned out inside
it.

## The pools

Every non-preflight `/mcp` request takes one permit from a deployment-wide FIFO
pool. Initialization, discovery, ordinary calls, and `execute_code` all pay it.
A program then takes a *second* permit from the deliberately smaller code pool,
so one request cannot trade ordinary capacity for an unbounded number of
sandboxes.

```ts
const connecta = createConnecta({
  admission: {
    requests: { concurrency: 16, maxQueueSize: 32, queueTimeoutMs: 5_000, retryAfterMs: 1_000 },
    code:     { concurrency: 2,  maxQueueSize: 8,  queueTimeoutMs: 5_000, retryAfterMs: 1_000 },
  },
  // …
});
```

Those values are the defaults, and both pools are the same
`AdmissionController` (`src/executor-admission.ts`) with different numbers.
`maxQueueSize: 0` is the fail-fast shape. Every value is a finite whole number;
concurrency and the queue timeout must be positive, while queue size and the
retry hint may be zero. Invalid bounds throw at construction rather than
silently removing the deployment's memory boundary — a pool that quietly became
unbounded is worse than a deployment that refuses to boot.

`admission.code` is a *fallback*. An executor that implements `acquire()` is an
`AdmittingExecutor` and already owns a bounded pool, so its own settings win and
connecta warns that `admission.code` was ignored. `quickJsExecutor()` is one of
those: it defaults to one active execution and 32 queued callers, configured on
the executor rather than here. Cloudflare's `DynamicWorkerExecutor` is not, so
a Worker deployment gets the fallback pool wrapped around it at construction —
which is also why `/health` always has a code-admission shape to report.

The request pool is global FIFO across identities. It is a capacity boundary,
not tenant fairness: one busy caller can occupy it. Per-tenant fairness needs a
policy above connecta, and one deployment still serves one tenant even when
identity rules give its principals different connector views
([`ethos.md`](../ethos.md)), so a global queue is not pretending to supply
something it does not.

## Admission before auth

`/mcp` acquires its permit *before* running the auth gate. This looks backwards
until you price it: authenticating first means an unauthenticated flood buys a
Clerk network lookup per request, so the cheapest possible attack becomes the
most expensive request the server can serve. Admitting first means it buys a
queue slot and a 503.

The permit is released with the response *body*, not when the handler returns.
A slow client draining a large result still counts as active work, because its
bytes and its socket still exist. `releaseAdmissionWithResponse` re-wraps the
response stream to do this, absorbs a rejecting `cancel()` rather than leaking
an unhandled rejection, and releases exactly once — release is idempotent, and
`test/request-admission.test.ts` pins both the stream-cancel path and the
double-release case.

Every other route bypasses the pool entirely. `/health` and the operator
surface stay responsive while MCP is saturated, which is the whole point: an
operator diagnosing an overload must not have to queue behind it. `/health`
names the exempt routes in `admission.reservedRoutes` so the claim is checkable
from outside.

## Overload, cancellation, shutdown

A full queue or an expired queue deadline answers HTTP 503 with `Retry-After`,
CORS headers, and a stable JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32001,
    "message": "Server capacity is exhausted. Retry later.",
    "data": { "code": "server_overloaded", "retryable": true, "retryAfterMs": 1000 }
  }
}
```

`Retry-After` is that hint rounded up to at least one whole second. It is
advice, not a reservation. Shutdown uses `-32002` / `server_shutting_down` and
is not retryable. Code-pool overload never reaches this layer: it surfaces as
an ordinary MCP tool error with `executor_overloaded`, `retryable: true`, and
the executor's own `retryAfterMs`.

A cancelled queued request is removed immediately and never receives a later
permit — cancelling and then being admitted would hold capacity for a caller
that is gone. An admitted request keeps its permit until its body completes,
errors, or is cancelled.

`connecta.close()` closes both queues before releasing executor resources:
queued and future MCP work is rejected with `server_shutting_down` while
admitted work drains. Node's `listen()` calls it on SIGTERM or SIGINT, stops
accepting connections, drains, and enforces `shutdownTimeoutMs` (10 s default)
— SIGTERM arrives on every `docker compose up` recreate, and Node's default
response to it is to die mid-request.

## What admission is not

The Node adapter's `maxBodyBytes` (10 MiB default) is a separate ingress guard.
It caps the HTTP body while constructing the Web `Request`, which happens
*before* the portable `/mcp` boundary can run. Admission bounds MCP, auth,
catalog, and response work; it is not a byte budget for many simultaneous slow
or near-limit uploads. Hostile public traffic wants an ingress proxy with a
body-rate limit in front, and `maxBodyBytes` set to the smallest value the
deployment actually needs.

The rejection warning is rate-limited to one per second, and each line reports
how many were suppressed since the last one. The `/health` totals count every
rejection, so the log is a sample and the counters are the record. Queue waits
log at debug level. Nothing on this path records or exposes request bodies,
tool arguments, identities, or results.

## Observations

`/health` exposes payload-free snapshots under `admission.requests`,
`admission.code`, and `admission.downstreamCalls`. The first two carry
configured bounds, current active and queued counts, cumulative
admitted/queued/rejected/cancelled/closed totals, and queue-wait count, total,
and maximum. The request policy is labelled `global-fifo`; downstream policy is
labelled `connector-partitioned-per-runtime`. An executor that owns its own
pool and exposes no snapshot reports `{ managedByExecutor: true }`.

With `execute_code({ diagnostics: true })`, a caller sees the same split from
the inside: `admissionMs` is time spent waiting for a permit and `connectorMs`
is the admitted attempt.

## Measuring capacity

`npm run load:admission` builds the package, then starts server and generator
in separate processes over real loopback TCP, warms a 10,000-tool catalog,
verifies every returned value, and records throughput, p50/p95/p99, server-only
peak RSS, RSS after forced GC, and live heap after GC. Each matrix cell gets a
fresh server so an earlier allocator high-water mark cannot contaminate the
next baseline; the three-round soak deliberately reuses one, because allocator
high-water retention and a live-object climb look identical in a single run and
different across three.

`CONNECTA_LOAD_CATALOG_SIZE`, `CONNECTA_LOAD_CONCURRENCY`, and
`CONNECTA_LOAD_MAX_QUEUE_SIZE` change catalog size, server concurrency, and
queue depth. The script prints its own numbers; no baseline is checked in,
deliberately. A laptop matrix is an example capacity profile, not a portable
SLO, and downstream payload size moves it more than any setting here does — pin
a runner before enforcing a regression ratio, and measure the connector mix the
deployment actually runs.

## Tests that enforce this

| Invariant | Suite |
| --- | --- |
| FIFO bounds, active and queue ceilings, stable retryable overload, queue timeout, cancellation removal, idempotent release, shutdown | `test/executor-admission.test.ts` (Node + Workers) |
| `/mcp` bounded before auth, stable 503 and `Retry-After`, health and operator responsiveness under saturation, payload-free counters, queued cancellation, shutdown rejection while active work drains, the separate fallback code pool | `test/request-admission.test.ts` |
| A client disconnect propagating through the Web `Request` into a program's connector call, releasing both permits | `test/node.test.ts` |
| The `/health` admission payload alongside the drift counts | `test/catalog-drift.test.ts`, `test/server.test.ts` |
