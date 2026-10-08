import type { CallErrorDetails } from "../errors.js";
// QuickJS-in-WebAssembly runtime used inside the disposable child process.
//
// Model-written code runs inside a QuickJS interpreter compiled to WASM:
// memory-safe, no ambient authority — the guest has no fetch, filesystem,
// env, timers, or imports. The only bridge to the host is `__call`, which
// returns a QuickJS promise that the host resolves with a JSON payload after
// running the provider function; `executePendingJobs` drives guest
// continuations from a host-side loop. Values cross the boundary as JSON, so
// provider args/results must be JSON-serializable.

import { getQuickJS, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import type { ExecuteResult, ExecutorProvider } from "../types.js";
import { InvocationFailure } from "../invocation.js";
import { msg } from "../errors.js";
import { withoutProgramTerminator } from "../program-source.js";
import { hostCallLabel, MAX_QUICKJS_LOG_TRANSPORT_BYTES, serializedBytes } from "./quickjs-protocol.js";

export interface QuickJsRuntimeOptions {
  timeoutMs: number;
  cpuTimeMs: number;
  memoryLimitBytes: number;
  maxStackSizeBytes: number;
}

/** Load and compile the shared QuickJS WASM module before a run budget starts. */
export async function prepareQuickJs(): Promise<void> {
  await getQuickJS();
}

const MAX_LOG_ENTRIES = 200;
// Cap each entry AND the cumulative buffer at capture time so untrusted guest
// code can't retain unbounded host memory: a single `console.log("x".repeat(N))`
// otherwise copies the whole N-char guest string into a host array we hold for
// the entire execution. The separate transport-byte budget below accounts for
// JSON escaping and is what keeps the result envelope below its IPC ceiling.
const MAX_LOG_ENTRY_CHARS = 8_000;
const MAX_LOG_TOTAL_CHARS = 256_000;
const LOG_ENTRY_LIMIT_MARKER = `[log truncated after ${MAX_LOG_ENTRIES} entries]`;
const LOG_SIZE_LIMIT_MARKER = "[log truncated: size budget exceeded]";
const MAX_LOG_MARKER_TRANSPORT_BYTES = Math.max(
  logTransportBytes(LOG_ENTRY_LIMIT_MARKER),
  logTransportBytes(LOG_SIZE_LIMIT_MARKER),
);
// Keep one host result below the range where quickjs-emscripten@0.32.0 can
// nondeterministically fail during runtime disposal under concurrent load.
// This still lets guest code reduce data more than ten times larger than
// connecta's final response budget.
const MAX_HOST_RESULT_BYTES = 256 * 1024;

function logTransportBytes(entry: string): number {
  // The log is encoded into ExecutionPayload, then that payloadJson string is
  // encoded into ChildToParentMessage. Measure the units the IPC cap sees.
  return serializedBytes(JSON.stringify(JSON.stringify(entry)));
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

/** Normalize model output into an async-arrow expression: strip markdown fences, wrap bare bodies. */
export function normalizeCode(code: string): string {
  let c = code.trim();
  const fence = /^```[\w-]*\s*\n([\s\S]*?)\n?```$/.exec(c);
  const fencedCode = fence?.[1];
  if (fencedCode !== undefined) c = fencedCode.trim();
  // Sniff for an existing function expression past any leading comments/blank
  // lines — models routinely prefix their code with a `//` or `/* */` note,
  // which would otherwise defeat the detection and wrap the whole thing.
  const head = c.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, "");
  if (/^async\b/.test(head) || head.startsWith("(")) {
    return withoutProgramTerminator(c);
  }
  return `async () => {\n${c}\n}`;
}

/**
 * Constant-size guest prelude: one lazy namespace Proxy per provider, never one
 * generated closure per visible tool. Unknown properties cross the host bridge
 * and fail closed there.
 */
function setupScript(providers: ExecutorProvider[]): string {
  // Capture the host bridge and codec before guest code runs.
  // Rejections are native guest Errors created and retained by the host.
  const lines: string[] = [
    `(() => {
  const call = globalThis.__call;
  const log = globalThis.__log;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const ProxyConstructor = Proxy;
  const create = Object.create;
  delete globalThis.__call;
  delete globalThis.__log;
  globalThis.console = (() => {
    const fmt = (x) => { if (typeof x === "string") return x; try { return stringify(x); } catch { return String(x); } };
    const emit = (...a) => log(a.map(fmt).join(" "));
    return { log: emit, info: emit, warn: emit, error: emit, debug: emit };
  })();
  const invoke = async (ns, fn, args) => {
    const r = parse(await call(ns, fn, stringify(args)));
    return r.value;
  };
  const namespace = (ns) => freeze(new ProxyConstructor(create(null), {
    get: (_target, key) => typeof key === "string" ? (...args) => invoke(ns, key, args) : undefined
  }));`,
  ];
  for (const p of providers) {
    const ns = JSON.stringify(p.name);
    lines.push(`globalThis[${ns}] = namespace(${ns});`);
  }
  for (const p of providers) {
    if (p.prelude) lines.push(p.prelude);
  }
  lines.push(`})();`);
  return lines.join("\n");
}

function formatGuestError(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const e = dumped as { name?: unknown; message?: unknown };
    if (e.message != null) {
      return e.name != null && e.name !== "Error" ? `${String(e.name)}: ${String(e.message)}` : String(e.message);
    }
  }
  return typeof dumped === "string" ? dumped : JSON.stringify(dumped);
}

interface HostBridge {
  pending: number;
  aborted: boolean;
  wake: () => void;
  waitForSettle: Promise<void>;
  failures: Array<{ error: QuickJSHandle; call: CallErrorDetails }>;
}

function armWake(bridge: HostBridge): void {
  bridge.waitForSettle = new Promise((resolve) => {
    bridge.wake = resolve;
  });
}

function waitForHostOrDeadline(waitForSettle: Promise<void>, remainingMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(false);
    }, remainingMs);
    void waitForSettle.then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function installBridge(
  ctx: QuickJSContext,
  providers: ExecutorProvider[],
  logs: string[],
  onLog?: (entry: string) => void,
): HostBridge {
  const bridge: HostBridge = {
    pending: 0,
    aborted: false,
    wake: () => {},
    waitForSettle: Promise.resolve(),
    failures: [],
  };
  armWake(bridge);

  // Keep both the in-memory character budget and the twice-JSON-encoded
  // transport budget. Reserve enough byte budget for whichever truncation
  // marker ends the stream.
  const captureLog = (entry: string) => {
    logs.push(entry);
    onLog?.(entry);
  };
  let logTotalChars = 0;
  let logTotalTransportBytes = 0;
  let logBudgetSpent = false;
  const logFn = ctx.newFunction("__log", (h) => {
    if (logs.length >= MAX_LOG_ENTRIES) {
      if (logs.length === MAX_LOG_ENTRIES) {
        captureLog(LOG_ENTRY_LIMIT_MARKER);
      }
      return;
    }
    if (logBudgetSpent) return;
    // Cap the entry before retaining it: `getString` yields a transient copy,
    // but slicing here keeps only a bounded string alive in `logs`.
    let entry = ctx.getString(h);
    if (entry.length > MAX_LOG_ENTRY_CHARS) {
      entry = `${entry.slice(0, MAX_LOG_ENTRY_CHARS)}…[entry truncated]`;
    }
    const entryTransportBytes = logTransportBytes(entry);
    if (
      logTotalChars + entry.length > MAX_LOG_TOTAL_CHARS ||
      logTotalTransportBytes + entryTransportBytes > MAX_QUICKJS_LOG_TRANSPORT_BYTES - MAX_LOG_MARKER_TRANSPORT_BYTES
    ) {
      captureLog(LOG_SIZE_LIMIT_MARKER);
      logBudgetSpent = true;
      return;
    }
    captureLog(entry);
    logTotalChars += entry.length;
    logTotalTransportBytes += entryTransportBytes;
  });
  ctx.setProp(ctx.global, "__log", logFn);
  logFn.dispose();

  const byName = new Map(providers.map((p) => [p.name, p]));
  const invoke = async (ns: string, fn: string, argsJson: string): Promise<{ json: string } | { error: unknown }> => {
    try {
      const provider = byName.get(ns);
      const f = provider && Object.hasOwn(provider.fns, fn) ? provider.fns[fn] : undefined;
      if (!f) throw new Error(`Unknown function ${ns}.${fn}`);
      const args = JSON.parse(argsJson) as unknown[];
      // Name the address the program called, never the internal dispatcher the
      // lazy connector namespaces share.
      const label = hostCallLabel({ namespace: ns, functionName: fn, args });
      const value = await f(...args);
      let json: string;
      try {
        json = JSON.stringify({ ok: true, value });
      } catch (err) {
        throw new Error(`Host result from ${label} could not be serialized: ${msg(err)}`);
      }
      if (exceedsUtf8ByteLimit(json, MAX_HOST_RESULT_BYTES)) {
        throw new Error(`Host result from ${label} exceeds the ${MAX_HOST_RESULT_BYTES}-byte serialized bridge limit.`);
      }
      return { json };
    } catch (err) {
      return { error: err };
    }
  };

  const callFn = ctx.newFunction("__call", (nsH, fnH, argsH) => {
    const ns = ctx.getString(nsH);
    const fn = ctx.getString(fnH);
    const argsJson = ctx.getString(argsH);
    const deferred: QuickJSDeferredPromise = ctx.newPromise();
    bridge.pending++;
    void invoke(ns, fn, argsJson).then((reply) => {
      bridge.pending--;
      if (bridge.aborted) {
        // Context is (about to be) torn down — settle nothing, free our handles.
        deferred.dispose();
      } else {
        if ("json" in reply) {
          const h = ctx.newString(reply.json);
          deferred.resolve(h);
          h.dispose();
        } else {
          const error = ctx.newError();
          const message = ctx.unwrapResult(ctx.evalCode(JSON.stringify(msg(reply.error).slice(0, 4_000))));
          ctx.setProp(error, "message", message);
          message.dispose();
          if (reply.error instanceof InvocationFailure) {
            const call = reply.error.details;
            // The error identity and typed facts stay in host state. A guest
            // may edit public fields without changing the retained failure.
            bridge.failures.push({ error: error.dup(), call });
            for (const [key, value] of Object.entries({ code: call.code, retryable: call.retryable, details: call })) {
              const property = ctx.unwrapResult(ctx.evalCode(`(${JSON.stringify(value)})`));
              ctx.setProp(error, key, property);
              property.dispose();
            }
          }
          deferred.reject(error);
          error.dispose();
        }
      }
      bridge.wake();
    });
    return deferred.handle;
  });
  ctx.setProp(ctx.global, "__call", callFn);
  callFn.dispose();

  return bridge;
}

/**
 * ExecuteResult plus a structural wall-expiry marker. Guest errors flow through
 * formatGuestError verbatim, so the timeout message text is forgeable; this
 * flag is set only by the return sites below and never from guest values.
 */
export interface QuickJsExecutionResult extends ExecuteResult {
  timedOut?: boolean;
}

/**
 * Execute one program inside the child. Wall time includes host waits; guest
 * CPU accumulates only while evalCode/executePendingJobs is synchronously
 * driving QuickJS, so a slow downstream does not consume the short CPU budget.
 */
export async function executeQuickJs(
  code: string,
  providers: ExecutorProvider[],
  options: QuickJsRuntimeOptions,
  onLog?: (entry: string) => void,
): Promise<QuickJsExecutionResult> {
  const { timeoutMs, cpuTimeMs, memoryLimitBytes, maxStackSizeBytes } = options;
  const QuickJS = await getQuickJS();
  const ctx = QuickJS.newContext();
  const deadline = Date.now() + timeoutMs;
  const timeoutError = `Execution timed out after ${timeoutMs}ms.`;
  const cpuTimeoutError = `Execution exceeded the ${cpuTimeMs}ms guest CPU budget.`;
  let cpuUsedMs = 0;
  let segmentStarted = 0;
  let inGuest = false;
  let cpuInterrupted = false;
  let wallInterrupted = false;
  const runGuest = <T>(operation: () => T): T => {
    segmentStarted = Date.now();
    inGuest = true;
    try {
      return operation();
    } finally {
      cpuUsedMs += Date.now() - segmentStarted;
      inGuest = false;
    }
  };
  ctx.runtime.setMemoryLimit(memoryLimitBytes);
  ctx.runtime.setMaxStackSize(maxStackSizeBytes);
  ctx.runtime.setInterruptHandler(() => {
    if (!inGuest) return false;
    wallInterrupted = Date.now() >= deadline;
    cpuInterrupted = cpuUsedMs + (Date.now() - segmentStarted) >= cpuTimeMs;
    return wallInterrupted || cpuInterrupted;
  });

  let describeError: QuickJSHandle | undefined;
  const logs: string[] = [];
  const bridge = installBridge(ctx, providers, logs, onLog);
  const finish = <T extends ExecuteResult>(r: T): T => {
    bridge.aborted = true;
    describeError?.dispose();
    for (const failure of bridge.failures) failure.error.dispose();
    bridge.failures.length = 0;
    // Outstanding host calls still hold deferred-promise handles; their
    // callbacks free them and wake the drain, which disposes the context
    // once the last straggler settles. Re-arm before every wait so the
    // deferred never resolves-and-stays-resolved between settles — that
    // would spin the microtask queue and starve the very timers the
    // stragglers are waiting on. Arming before the pending check (and
    // synchronously, before the first await) closes the settle-before-arm
    // window: any settle after this point resolves the promise we await.
    if (bridge.pending === 0) ctx.dispose();
    else {
      void (async () => {
        armWake(bridge);
        while (bridge.pending > 0) {
          await bridge.waitForSettle;
          armWake(bridge);
        }
        ctx.dispose();
      })();
    }
    return logs.length > 0 ? { ...r, logs } : r;
  };
  const rejected = (error: QuickJSHandle): QuickJsExecutionResult => {
    // Interrupt/deadline facts are host state, never inferred by inspecting
    // the thrown value. Do not reenter a guest whose budget has ended.
    if (wallInterrupted || Date.now() >= deadline) return timedOut();
    if (cpuInterrupted || cpuUsedMs >= cpuTimeMs) return { result: undefined, error: cpuTimeoutError };
    const call = bridge.failures.find((failure) => ctx.eq(failure.error, error))?.call;
    let description: unknown = { name: "Error", message: "Program threw a value." };
    const type = ctx.typeof(error);
    if (type === "string") description = ctx.getString(error).slice(0, 4000);
    else if (type === "number") description = ctx.getNumber(error);
    else if (type === "undefined") description = "undefined";
    else if (type === "boolean") description = ctx.eq(error, ctx.true);
    else if (ctx.eq(error, ctx.null)) description = null;
    else if (describeError) {
      const describe = describeError;
      const described = runGuest(() => ctx.callFunction(describe, ctx.undefined, error));
      if (described.error) described.error.dispose();
      else {
        description = JSON.parse(ctx.getString(described.value)) ?? description;
        described.value.dispose();
      }
      if (wallInterrupted || Date.now() >= deadline) return timedOut();
      if (cpuInterrupted || cpuUsedMs >= cpuTimeMs) return { result: undefined, error: cpuTimeoutError };
    }
    const name =
      description && typeof description === "object" && "name" in description && typeof description.name === "string"
        ? description.name
        : "Error";
    const stack =
      description && typeof description === "object" && "stack" in description && typeof description.stack === "string"
        ? description.stack
        : "";
    const location = /:(\d+)(?::\d+)?\)?(?:\n|$)/.exec(stack);
    return {
      result: undefined,
      error: formatGuestError(description).slice(0, 4000),
      failure: {
        name,
        ...(call ? { call } : {}),
        ...(location ? { line: Math.max(1, Number(location[1]) - 1) } : {}),
      },
    };
  };
  const timedOut = (): QuickJsExecutionResult => ({
    result: undefined,
    error: timeoutError,
    failure: {
      name: "TimeoutError",
      timeout: { elapsedMs: Date.now() - (deadline - timeoutMs), deadlineMs: timeoutMs },
    },
    timedOut: true,
  });

  // Keep this diagnostic function in a host-owned handle. Error.isError
  // checks the native brand without Proxy traps. Own data descriptors of
  // native Errors are safe to read; accessors and arbitrary thrown objects
  // get a fixed description instead of dump's guest serialization/getters.
  const described = runGuest(() =>
    ctx.evalCode(`(() => {
        const isError = Error.isError;
        const descriptor = Object.getOwnPropertyDescriptor;
        const prototypeOf = Object.getPrototypeOf;
        const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
        const slice = Function.prototype.call.bind(String.prototype.slice);
        const stringify = JSON.stringify;
        const prototypes = [
          [Error.prototype, "Error"], [TypeError.prototype, "TypeError"],
          [SyntaxError.prototype, "SyntaxError"], [ReferenceError.prototype, "ReferenceError"],
          [RangeError.prototype, "RangeError"], [EvalError.prototype, "EvalError"],
          [URIError.prototype, "URIError"], [AggregateError.prototype, "AggregateError"]
        ];
        return (error) => {
          if (!isError(error)) return "null";
          const text = (key, fallback, limit) => {
            const own = descriptor(error, key);
            return own && hasOwn(own, "value") && typeof own.value === "string"
              ? slice(own.value, 0, limit) : fallback;
          };
          const prototype = prototypeOf(error);
          let name = "Error";
          for (let i = 0; i < prototypes.length; i++) {
            if (prototype === prototypes[i][0]) { name = prototypes[i][1]; break; }
          }
          return stringify({ __proto__: null, name: text("name", name, 64),
            message: text("message", "Program threw a value.", 4000), stack: text("stack", "", 1000) });
        };
      })()`),
  );
  if (described.error) {
    const rejection = rejected(described.error);
    described.error.dispose();
    return finish(rejection);
  }
  describeError = described.value;

  const setup = runGuest(() => ctx.evalCode(setupScript(providers)));
  if (setup.error) {
    const rejection = rejected(setup.error);
    setup.error.dispose();
    return finish(
      rejection.timedOut || cpuInterrupted
        ? rejection
        : { ...rejection, error: `Sandbox setup failed: ${rejection.error}` },
    );
  }
  setup.value.dispose();

  const evaluated = runGuest(() => ctx.evalCode(`Promise.resolve((\n${normalizeCode(code)}\n)())`));
  if (evaluated.error) {
    const rejection = rejected(evaluated.error);
    evaluated.error.dispose();
    return finish(rejection);
  }
  const promiseHandle = evaluated.value;

  // Drive the guest: run microtask jobs, inspect the result promise,
  // sleep until a host call settles (or the budget runs out), repeat.
  // Returns without touching the context lifecycle; disposal happens below.
  const drive = async (): Promise<QuickJsExecutionResult> => {
    for (;;) {
      if (Date.now() >= deadline) {
        return timedOut();
      }
      const jobs = runGuest(() => ctx.runtime.executePendingJobs());
      if (jobs.error) {
        const rejection = rejected(jobs.error);
        jobs.error.dispose();
        return rejection;
      }
      const state = ctx.getPromiseState(promiseHandle);
      if (state.type === "fulfilled") {
        const result: unknown = runGuest(() => ctx.dump(state.value));
        state.value.dispose();
        return { result };
      }
      if (state.type === "rejected") {
        const rejection = rejected(state.error);
        state.error.dispose();
        return rejection;
      }
      if (bridge.pending === 0) {
        return {
          result: undefined,
          error: "Execution stalled: code awaits something that can never settle.",
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return timedOut();
      }
      const settled = await waitForHostOrDeadline(bridge.waitForSettle, remaining);
      if (settled) armWake(bridge);
      else {
        return timedOut();
      }
    }
  };

  let outcome: QuickJsExecutionResult;
  try {
    outcome = await drive();
  } finally {
    promiseHandle.dispose();
  }
  return finish(outcome);
}
