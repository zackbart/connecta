# Code mode

## Code mode (`execute_code`)

Code mode lets the model **write JavaScript that orchestrates tool calls**
instead of making one `call_tool` round trip per step — loops, joins across
connectors, filtering a large downstream response down to three fields before
it ever reaches the model's context. The idea comes from Cloudflare's
[Code Mode](https://blog.cloudflare.com/code-mode/); connecta adopts the
sandbox, not the platform (no in-sandbox approvals, no durable execution log, no
saved snippets, and no Durable-Object runtime — see
[`decisions.md`](./decisions.md#from-executor-and-cloudflares-code-mode-runtime)
for why each was declined).

It is **off by default**. Configure an `executor` and connecta registers a
tenth meta-tool, `execute_code`; omit it and nothing changes.

### The sandbox contract

The model's code runs where the ONLY capabilities are:

- **One global per connector** — every `<connectorId>.<toolName>` address is
  callable as `<connectorId>.<toolName>(args)` with a single args object.
  Names are sanitized into JS identifiers: characters outside `[A-Za-z0-9_$]`
  become `_` (`my-service.get.thing` → `my_service.get_thing`), leading digits
  get a `_` prefix, reserved words a `_` suffix.
  Only tools explicitly annotated `readOnlyHint: true` without a contradictory
  `destructiveHint` are included in these globals.
- **`connecta.call(address, args)` / `connecta.batch(calls)`** — raw-address
  read-only calls, with batch failures isolated per entry. One execution may
  make at most **20** host calls, a batch accepts at most **10**, and each host
  call has a **15-second** deadline. Ending or timing out the sandbox aborts
  outstanding host waits and signals cooperative connectors to cancel.
- **`connecta.search(args)` / `connecta.describe(args)`** — inspect the
  already-loaded catalog inside the same inbound request, so discovery and
  execution can be orchestrated without extra MCP round trips. They use the
  ordinary discovery policy: search pages contain at most 100 tools, describe
  accepts at most 100 addresses, and either generated result is capped at
  256,000 UTF-8 bytes.
- **`console.*`** — captured and returned as `logs`.

No `fetch`, filesystem, env, timers, or imports. Tool calls return plain
values (MCP text content is JSON-parsed when possible, `structuredContent`
preferred, `isError` becomes a thrown exception the code can catch).
Downstream credentials stay host-side — sandboxed code can do nothing that a
sequence of explicitly read-only `call_tool` calls could not. Every other
operation must leave the sandbox and use `call_destructive_tool`.

Catalog discovery and downstream invocation are shared with the MCP
meta-tools, not reimplemented in the sandbox adapter. Consequently code mode
uses the same address resolution, unknown-tool wording, fail-closed safety
predicate, admission, cancellation, timeout classification, health recording,
and payload-free activity fields. The adapter deliberately keeps the parts
that are specific to code mode: results are unwrapped to plain values, there is
no automatic retry, paging and `fields` remain MCP-call features, every host
call uses the fixed 15-second deadline, the program owns a 20-call budget, and
activity uses `source: "execute_code"`. All catalog and call access still goes
through the request's `RegistryView`.

### Executors

The seam is deliberately tiny (`src/types.ts`):

```ts
interface Executor {
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
  close?(): void | Promise<void>;
}
```

A bounded executor may additionally implement `acquire({ signal })` and return
an `ExecutorLease`. The lease carries its own `execute()`; callers that already
hold a lease never call the executor's ordinary `execute()` and therefore
cannot double-acquire a pool of one. Executors without that capability,
including `DynamicWorkerExecutor`, keep the one-method path unchanged.

Two known implementations:

- **Cloudflare Workers** — `DynamicWorkerExecutor` from
  [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode)
  (structurally compatible; no adapter). Runs code in a Dynamic Worker isolate
  with `globalOutbound: null`. Dynamic Workers are
  [available only on the Workers Paid plan](https://developers.cloudflare.com/dynamic-workers/pricing/).
  The deployment can use Worker Loader binding presence as its complete
  configuration switch:

  ```ts
  import { DynamicWorkerExecutor } from "@cloudflare/codemode";
  createConnecta({
    ...(env.LOADER
      ? { executor: new DynamicWorkerExecutor({ loader: env.LOADER }) }
      : {}),
    /* … */
  });
  ```

  ```jsonc
  // Add on the Paid plan to enable execute_code; omit on the Free plan.
  "worker_loaders": [{ "binding": "LOADER" }]
  ```

  `env.LOADER` must be optional in the deployment's `Env` type. With the
  binding absent, the same source registers only the nine base meta-tools and
  remains Workers Free compatible. With it present, `execute_code` appears
  automatically; an extra boolean environment variable would not remove the
  paid binding and is therefore not a useful plan switch. The complete
  pattern is in the [Worker example](../examples/worker/README.md#code-mode).

- **Node** — `quickJsExecutor()` from `@zackbart/connecta/quickjs`:
  install the optional `quickjs-emscripten` peer, then use the QuickJS engine
  compiled to WebAssembly in a disposable child process. The guest has no
  ambient authority, and a WASM abort or interpreter OOM kills a replaceable
  child rather than the HTTP-serving process.

  This subpath depends on the published package layout: the executor forks the
  `quickjs-child.js` file beside itself. A server bundler must externalize
  `@zackbart/connecta` — or at least `@zackbart/connecta/quickjs` — so those
  files remain on disk. Folding the subpath into a single-file bundle leaves
  nothing for `fork()` to start; the first execution rejects with the expected
  child path and the same externalization instruction.

  If a child starts and then exits abnormally, the returned diagnostic includes
  only the most recent 8 KiB of its stderr. The parent waits for the stderr pipe
  to close before reporting the exit, so final runtime crash output is included
  without letting diagnostic capture grow without bound.

  Four separate controls bound different costs:

  | Option | Default | Bounds |
  | --- | ---: | --- |
  | `cpuTimeMs` | 250 ms | cumulative synchronous guest CPU; host waits do not count |
  | `timeoutMs` | 30 s | total execution wall time, including host waits |
  | `concurrency` | 1 | simultaneous executions/child processes |
  | `maxQueueSize` / `queueTimeoutMs` | 32 / 5 s | callers waiting before provider construction |

  `memoryLimitBytes` (64 MiB) and `maxStackSizeBytes` (1 MiB) remain per-guest
  QuickJS limits. Queue overflow and queue expiry return the stable,
  retryable `executor_overloaded` error with `retryAfterMs`; request
  cancellation removes a queued caller, aborts catalog construction and host
  calls, or terminates its running child. A cold child first loads trusted
  QuickJS WASM under a separate 10-second startup ceiling; the configurable
  execution wall budget starts only after that child reports ready, and
  cancellation can abandon the readiness wait without poisoning the warming
  slot.

  Guest `await` is driven from the host, not by suspending the interpreter: a
  tool call hands the guest a QuickJS deferred promise and the host pumps
  `executePendingJobs` to advance continuations as calls settle. The obvious
  alternative — asyncify, which suspends and resumes the WASM stack — was tried
  and abandoned as too flaky to trust with hostile code. The pending-jobs loop
  is why the executor can notice a promise that can never settle and fail fast
  with "execution stalled" instead of burning the whole timeout.

  Direct connector namespaces are lazy Proxies, so setup creates one object per
  connector rather than one generated closure per visible tool. Consequently
  `Object.keys(github)` is empty, and an unknown function crosses the bridge
  before failing with `Unknown function github.name`; neither behavior grants
  authority. Both executors still forward arguments positionally.

  One serialized host result or complete guest call payload (namespace,
  function name, and arguments together) may be at most 256 KiB of UTF-8.
  Larger values fail that host call before entering the other process.
  The child applies the final ~24k-character result policy before sending a
  result. Captured logs keep their 200-entry, 8k-character-per-entry, and
  256k-character memory caps, plus a 512 KiB budget measured after both JSON
  encodings; every complete parent/child IPC envelope has a 1 MiB hard ceiling.

  ```ts
  import { quickJsExecutor } from "@zackbart/connecta/quickjs";
  const connecta = createConnecta({
    executor: quickJsExecutor({
      cpuTimeMs: 250,
      timeoutMs: 30_000,
      concurrency: 1,
      maxQueueSize: 32,
      queueTimeoutMs: 5_000,
    }),
    /* … */
  });
  ```

  `connecta.close()` terminates/releases executor resources. The Node
  `listen()` adapter calls it as soon as graceful shutdown begins.

**Never** back the seam with an unsandboxed `eval`/`node:vm` — the code is
model-written and must be treated as hostile.

### Behavior details

- Providers are built per call from the live registry: broken connectors are
  skipped (same isolation as `search_tools`), and name collisions after
  sanitization are logged and skipped (first wins). `connecta` is a reserved
  namespace.
- Bounded executors acquire before those providers are built, so queued calls
  retain no catalogs or request-scoped connector closures.
- Results are JSON-serialized and truncated at ~24k chars with an explicit
  marker telling the model to reduce data in code; logs are capped too.
- A guest that awaits something that can never settle fails fast with an
  "execution stalled" error rather than burning the whole timeout
  (QuickJS executor).
- In the QuickJS executor, `Promise.all` over tool calls runs the host calls
  concurrently. A lease remains occupied during host waits; active CPU slots
  and in-flight workflows are therefore the same initial limit rather than a
  multiplexed pool.
