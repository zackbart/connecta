# Request admission and backpressure

Connecta bounds work at the Web-standard request boundary, before inbound auth,
toolkit resolution, MCP server construction, or catalog access. Bursts therefore
have an explicit active count and queue instead of asking traffic shape and the
runtime allocator to choose the process high-water mark.

## Policy and configuration

Every non-preflight `/mcp` request consumes one permit from a deployment-wide
FIFO pool. That includes initialization, discovery, ordinary calls, and
`execute_code`. Code mode then consumes a second permit from its deliberately
smaller executor pool: one request cannot trade ordinary capacity for an
unbounded number of sandboxes.

```ts
const connecta = createConnecta({
  admission: {
    requests: {
      concurrency: 16,
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
    code: {
      concurrency: 2,
      maxQueueSize: 8,
      queueTimeoutMs: 5_000,
      retryAfterMs: 1_000,
    },
  },
  // …
});
```

Those values are the defaults. `maxQueueSize: 0` is the fail-fast shape. Every
other value is a finite whole number; concurrency and timeout must be positive,
while queue size and the retry hint may be zero. Invalid bounds throw at
construction rather than silently removing the deployment's memory boundary.

`admission.code` is the fallback for a one-method `Executor`. An executor that
implements `acquire()` already owns a bounded pool, so its own settings win and
Connecta warns if `admission.code` was also supplied. The built-in
`quickJsExecutor()` defaults to one active execution and 32 queued callers; its
options are documented in [code mode](./code-mode.md#executors).

The request pool is global FIFO across identities and toolkits. It is a capacity
boundary, not tenant fairness: one busy identity can occupy it. Deployments that
need per-tenant fairness require a policy above Connecta; this release does not
pretend a global queue supplies it.

## Overload, cancellation, and shutdown

When the request queue is full or its deadline expires, `/mcp` returns HTTP 503,
`Retry-After`, CORS headers, and a stable JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": {
    "code": -32001,
    "message": "Server capacity is exhausted. Retry later.",
    "data": {
      "code": "server_overloaded",
      "retryable": true,
      "retryAfterMs": 1000
    }
  }
}
```

`Retry-After` is the same hint rounded up to at least one whole second. It is
advice, not a reservation. Code-pool overload remains an MCP tool error with
`executor_overloaded`, `retryable: true`, and the executor's `retryAfterMs`.

A cancelled queued request is removed immediately and never receives a later
permit. An admitted request keeps its permit until its response body completes,
errors, or is cancelled; releases are idempotent. This deliberately counts a
slow or broken response stream as active work instead of declaring capacity free
while its bytes and socket still exist.

`connecta.close()` closes both queues before releasing executor resources:
queued and future MCP work receives `server_shutting_down`, while admitted
ordinary work may drain. The Node `listen()` adapter calls it as soon as
SIGTERM/SIGINT arrives, stops accepting connections, drains active requests and
deferred work, and enforces `shutdownTimeoutMs`.

## Responsiveness and observations

All non-MCP routes bypass the request pool. In particular, `/health` and the
operator shell/data routes retain capacity while MCP is saturated; an operator
can see and diagnose overload instead of joining its queue.

`/health` exposes payload-free snapshots under `admission.requests` and
`admission.code`: configured bounds, current active/queued counts, cumulative
admitted/queued/rejected/cancelled/closed totals, and queue-wait
count/total/max. It labels the policy `global-fifo` and names the reserved
operator routes. Queue waits are logged at debug level; rejection warnings are
rate-limited and report how many were suppressed while the health total counts
every one. Neither path records request bodies, tool arguments, identities, or
results.

## Node capacity measurement

`npm run load:admission` builds the package, starts the server and generator in
separate processes over real loopback TCP, warms a 10,000-tool catalog, verifies
every returned value, and records throughput, p50/p95/p99, server-only peak RSS,
RSS after forced GC, and live heap after GC. Each matrix cell gets a fresh
server so an earlier allocator high-water mark cannot contaminate its baseline;
the three-round soak intentionally reuses one.

The following run used Node 26.5.0 on an arm64 Apple M4 with 16 GiB RAM and
macOS 26.5.2. Server admission was 16 active with a 256-entry benchmark queue;
client in-flight was varied independently. These numbers are an example
capacity profile, not a portable SLO.

| Calls | Client in flight | Calls/s | p50 ms | p95 ms | p99 ms | RSS before | Peak RSS | RSS after GC | Live heap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 10 | 745 | 10.2 | 30.4 | 54.6 | 97 MB | 189 MB | 189 MB | 25 MB |
| 100 | 50 | 896 | 11.2 | 106.3 | 109.3 | 97 MB | 188 MB | 188 MB | 25 MB |
| 100 | 100 | 886 | 63.4 | 105.2 | 110.3 | 97 MB | 182 MB | 182 MB | 25 MB |
| 500 | 10 | 1,169 | 7.7 | 14.5 | 23.4 | 97 MB | 310 MB | 310 MB | 26 MB |
| 500 | 50 | 1,099 | 18.5 | 309.1 | 451.4 | 97 MB | 343 MB | 343 MB | 26 MB |
| 500 | 100 | 1,150 | 17.9 | 414.6 | 430.5 | 97 MB | 343 MB | 343 MB | 26 MB |
| 1,000 | 10 | 1,223 | 7.5 | 13.5 | 18.6 | 97 MB | 333 MB | 333 MB | 25 MB |
| 1,000 | 50 | 1,129 | 26.2 | 55.1 | 737.6 | 97 MB | 412 MB | 412 MB | 26 MB |
| 1,000 | 100 | 1,234 | 24.1 | 773.2 | 802.3 | 97 MB | 414 MB | 414 MB | 25 MB |
| 5,000 | 10 | 1,494 | 6.4 | 10.9 | 13.8 | 97 MB | 337 MB | 337 MB | 25 MB |
| 5,000 | 50 | 1,359 | 33.2 | 44.4 | 70.8 | 97 MB | 500 MB | 500 MB | 25 MB |
| 5,000 | 100 | 1,402 | 48.8 | 73.5 | 974.6 | 97 MB | 534 MB | 534 MB | 25 MB |

The repeated 5,000-call/50-in-flight soak completed 15,000/15,000 calls at
1,438, 1,405, and 1,426 calls/s. Peak/RSS-after-GC plateaued at 531 MB in all
three rounds while live heap returned to 25 MB. That is allocator high-water
retention, not a continuing live-object climb.

Practical reading for this catalog and host:

- **256 MB:** not a safe profile for the sustained runs above.
- **512 MB:** 50 client requests in flight is on the edge; use a smaller active
  limit and a short/fail-fast queue, then measure the actual connector mix.
- **1,024 MB:** contains the tested matrix with useful headroom, but downstream
  payloads can move the number and still need measurement.

Pin a runner before enforcing regression ratios. Change catalog size,
concurrency, or queue with `CONNECTA_LOAD_CATALOG_SIZE`,
`CONNECTA_LOAD_CONCURRENCY`, and `CONNECTA_LOAD_MAX_QUEUE_SIZE`; never promote
this laptop's absolute numbers into a platform-wide SLO.
