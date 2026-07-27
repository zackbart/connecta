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
  execution can be orchestrated without extra MCP round trips.
- **`console.*`** — captured and returned as `logs`.

No `fetch`, filesystem, env, timers, or imports. Tool calls return plain
values (MCP text content is JSON-parsed when possible, `structuredContent`
preferred, `isError` becomes a thrown exception the code can catch).
Downstream credentials stay host-side — sandboxed code can do nothing that a
sequence of explicitly read-only `call_tool` calls could not. Every other
operation must leave the sandbox and use `call_destructive_tool`.

### Executors

The seam is deliberately tiny (`src/types.ts`):

```ts
interface Executor {
  execute(code: string, providers: ExecutorProvider[]): Promise<ExecuteResult>;
}
```

Two known implementations:

- **Cloudflare Workers** — `DynamicWorkerExecutor` from
  [`@cloudflare/codemode`](https://www.npmjs.com/package/@cloudflare/codemode)
  (structurally compatible; no adapter). Runs code in a Dynamic Worker isolate
  with `globalOutbound: null`. Needs a Worker Loader binding
  (`"worker_loaders": [{ "binding": "LOADER" }]` in wrangler.jsonc — open beta,
  paid plans):

  ```ts
  import { DynamicWorkerExecutor } from "@cloudflare/codemode";
  createConnecta({ executor: new DynamicWorkerExecutor({ loader: env.LOADER }), /* … */ });
  ```

- **Node (or anywhere)** — `quickJsExecutor()` from `@zackbart/connecta/quickjs`:
  install the optional `quickjs-emscripten` peer, then use the QuickJS engine
  compiled to WebAssembly. WASM is
  memory-safe with no ambient authority, so the guest genuinely cannot reach
  the network or filesystem; options cap memory (default 64 MiB), stack
  (1 MiB), and wall-clock time (30 s, host tool calls included).

  Guest `await` is driven from the host, not by suspending the interpreter: a
  tool call hands the guest a QuickJS deferred promise and the host pumps
  `executePendingJobs` to advance continuations as calls settle. The obvious
  alternative — asyncify, which suspends and resumes the WASM stack — was tried
  and abandoned as too flaky to trust with hostile code. The pending-jobs loop
  is why the executor can notice a promise that can never settle and fail fast
  with "execution stalled" instead of burning the whole timeout.

  The 30 s default is intentionally tighter than codemode's 60 s: sandbox code
  is tool-call glue, not compute, so a shorter leash surfaces hung downstreams
  sooner. Both executors forward provider-function arguments verbatim and
  positionally, so identical sandbox code behaves the same on either.

  ```ts
  import { quickJsExecutor } from "@zackbart/connecta/quickjs";
  createConnecta({ executor: quickJsExecutor({ timeoutMs: 30_000 }), /* … */ });
  ```

**Never** back the seam with an unsandboxed `eval`/`node:vm` — the code is
model-written and must be treated as hostile.

### Behavior details

- Providers are built per call from the live registry: broken connectors are
  skipped (same isolation as `search_tools`), and name collisions after
  sanitization are logged and skipped (first wins). `connecta` is a reserved
  namespace.
- Results are JSON-serialized and truncated at ~24k chars with an explicit
  marker telling the model to reduce data in code; logs are capped too.
- A guest that awaits something that can never settle fails fast with an
  "execution stalled" error rather than burning the whole timeout
  (QuickJS executor).
- In the QuickJS executor, `Promise.all` over tool calls runs the host calls
  concurrently; if a downstream call outlives the timeout, the sandbox context
  is torn down as soon as the call settles.
