// QuickJS-in-WebAssembly runtime used inside the disposable child process.
//
// Model-written code runs inside a QuickJS interpreter compiled to WASM:
// memory-safe, no ambient authority — the guest has no fetch, filesystem,
// env, timers, or imports. The only bridge to the host is `__call`, which
// returns a QuickJS promise that the host resolves with a JSON payload after
// running the provider function; `executePendingJobs` drives guest
// continuations from a host-side loop. Values cross the boundary as JSON, so
// provider args/results must be JSON-serializable.

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import type { ExecuteResult, ExecutorProvider } from "../types.js";
import {
  MAX_QUICKJS_LOG_TRANSPORT_BYTES,
  serializedBytes,
} from "./quickjs-protocol.js";

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

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  if (fence) c = fence[1].trim();
  // Sniff for an existing function expression past any leading comments/blank
  // lines — models routinely prefix their code with a `//` or `/* */` note,
  // which would otherwise defeat the detection and wrap the whole thing.
  const head = c.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)+/, "");
  if (/^async\b/.test(head) || head.startsWith("(")) return c;
  return `async () => {\n${c}\n}`;
}

/**
 * Constant-size guest prelude: one lazy namespace Proxy per provider, never one
 * generated closure per visible tool. Unknown properties cross the host bridge
 * and fail closed there.
 */
function setupScript(providers: ExecutorProvider[]): string {
  const lines: string[] = [
    `globalThis.console = (() => {
  const fmt = (x) => { if (typeof x === "string") return x; try { return JSON.stringify(x); } catch { return String(x); } };
  const emit = (...a) => __log(a.map(fmt).join(" "));
  return { log: emit, info: emit, warn: emit, error: emit, debug: emit };
})();`,
    `globalThis.__invoke = async (ns, fn, args) => {
  const r = JSON.parse(await __call(ns, fn, JSON.stringify(args)));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};`,
    `globalThis.__namespace = (ns) => Object.freeze(new Proxy(Object.create(null), {
  get: (_target, key) => typeof key === "string" ? (...args) => __invoke(ns, key, args) : undefined
}));`,
  ];
  for (const p of providers) {
    const ns = JSON.stringify(p.name);
    lines.push(`globalThis[${ns}] = __namespace(${ns});`);
  }
  for (const p of providers) {
    if (p.prelude) lines.push(p.prelude);
  }
  lines.push(`delete globalThis.__namespace;`);
  return lines.join("\n");
}

/** True when a dumped error is QuickJS's deadline-interrupt signal. */
function isInterrupt(dumped: unknown): boolean {
  if (!dumped || typeof dumped !== "object") return false;
  const e = dumped as { name?: unknown; message?: unknown };
  return e.name === "InternalError" && e.message === "interrupted";
}

function formatGuestError(dumped: unknown): string {
  if (dumped && typeof dumped === "object") {
    const e = dumped as { name?: unknown; message?: unknown };
    if (e.message != null) {
      return e.name != null && e.name !== "Error"
        ? `${String(e.name)}: ${String(e.message)}`
        : String(e.message);
    }
  }
  return typeof dumped === "string" ? dumped : JSON.stringify(dumped);
}

interface HostBridge {
  pending: number;
  aborted: boolean;
  wake: () => void;
  waitForSettle: Promise<void>;
}

function armWake(bridge: HostBridge): void {
  bridge.waitForSettle = new Promise((resolve) => {
    bridge.wake = resolve;
  });
}

function waitForHostOrDeadline(
  waitForSettle: Promise<void>,
  remainingMs: number,
): Promise<boolean> {
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
): HostBridge {
  const bridge: HostBridge = {
    pending: 0,
    aborted: false,
    wake: () => {},
    waitForSettle: Promise.resolve(),
  };
  armWake(bridge);

  // Keep both the in-memory character budget and the twice-JSON-encoded
  // transport budget. Reserve enough byte budget for whichever truncation
  // marker ends the stream.
  let logTotalChars = 0;
  let logTotalTransportBytes = 0;
  let logBudgetSpent = false;
  const logFn = ctx.newFunction("__log", (h) => {
    if (logs.length >= MAX_LOG_ENTRIES) {
      if (logs.length === MAX_LOG_ENTRIES) {
        logs.push(LOG_ENTRY_LIMIT_MARKER);
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
      logTotalTransportBytes + entryTransportBytes >
        MAX_QUICKJS_LOG_TRANSPORT_BYTES - MAX_LOG_MARKER_TRANSPORT_BYTES
    ) {
      logs.push(LOG_SIZE_LIMIT_MARKER);
      logBudgetSpent = true;
      return;
    }
    logs.push(entry);
    logTotalChars += entry.length;
    logTotalTransportBytes += entryTransportBytes;
  });
  ctx.setProp(ctx.global, "__log", logFn);
  logFn.dispose();

  const byName = new Map(providers.map((p) => [p.name, p]));
  const invoke = async (
    ns: string,
    fn: string,
    argsJson: string,
  ): Promise<string> => {
    try {
      const provider = byName.get(ns);
      const f =
        provider && Object.hasOwn(provider.fns, fn)
          ? provider.fns[fn]
          : undefined;
      if (!f) throw new Error(`Unknown function ${ns}.${fn}`);
      const args = JSON.parse(argsJson) as unknown[];
      const value = await f(...args);
      let json: string;
      try {
        json = JSON.stringify({ ok: true, value });
      } catch (err) {
        throw new Error(
          `Host result from ${ns}.${fn} could not be serialized: ${msg(err)}`,
        );
      }
      if (exceedsUtf8ByteLimit(json, MAX_HOST_RESULT_BYTES)) {
        throw new Error(
          `Host result from ${ns}.${fn} exceeds the ${MAX_HOST_RESULT_BYTES}-byte serialized bridge limit.`,
        );
      }
      return json;
    } catch (err) {
      return JSON.stringify({ ok: false, error: msg(err) });
    }
  };

  const callFn = ctx.newFunction("__call", (nsH, fnH, argsH) => {
    const ns = ctx.getString(nsH);
    const fn = ctx.getString(fnH);
    const argsJson = ctx.getString(argsH);
    const deferred: QuickJSDeferredPromise = ctx.newPromise();
    bridge.pending++;
    void invoke(ns, fn, argsJson).then((json) => {
      bridge.pending--;
      if (bridge.aborted) {
        // Context is (about to be) torn down — settle nothing, free our handles.
        deferred.dispose();
      } else {
        const h = ctx.newString(json);
        deferred.resolve(h);
        h.dispose();
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
): Promise<QuickJsExecutionResult> {
      const { timeoutMs, cpuTimeMs, memoryLimitBytes, maxStackSizeBytes } =
        options;
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
        cpuInterrupted =
          cpuUsedMs + (Date.now() - segmentStarted) >= cpuTimeMs;
        return wallInterrupted || cpuInterrupted;
      });

      const logs: string[] = [];
      const bridge = installBridge(ctx, providers, logs);
      const finish = <T extends ExecuteResult>(r: T): T => {
        bridge.aborted = true;
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
      const fail = (error: string): ExecuteResult =>
        finish({ result: undefined, error });
      const timedOut = (): QuickJsExecutionResult => ({
        result: undefined,
        error: timeoutError,
        timedOut: true,
      });

      const setup = runGuest(() => ctx.evalCode(setupScript(providers)));
      if (setup.error) {
        const detail = formatGuestError(ctx.dump(setup.error));
        setup.error.dispose();
        if (wallInterrupted) return finish(timedOut());
        if (cpuInterrupted) return fail(cpuTimeoutError);
        return fail(`Sandbox setup failed: ${detail}`);
      }
      setup.value.dispose();

      const evaluated = runGuest(() =>
        ctx.evalCode(`Promise.resolve((\n${normalizeCode(code)}\n)())`),
      );
      if (evaluated.error) {
        const dumped = ctx.dump(evaluated.error);
        evaluated.error.dispose();
        if (isInterrupt(dumped) && wallInterrupted) return finish(timedOut());
        if (isInterrupt(dumped) && cpuInterrupted) return fail(cpuTimeoutError);
        return fail(formatGuestError(dumped));
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
            const dumped = ctx.dump(jobs.error);
            jobs.error.dispose();
            if (isInterrupt(dumped) && wallInterrupted) {
              return timedOut();
            }
            if (isInterrupt(dumped) && cpuInterrupted) {
              return { result: undefined, error: cpuTimeoutError };
            }
            return { result: undefined, error: formatGuestError(dumped) };
          }
          const state = ctx.getPromiseState(promiseHandle);
          if (state.type === "fulfilled") {
            const result: unknown = runGuest(() => ctx.dump(state.value));
            state.value.dispose();
            return { result };
          }
          if (state.type === "rejected") {
            const dumped = ctx.dump(state.error);
            state.error.dispose();
            if (isInterrupt(dumped) && wallInterrupted) {
              return timedOut();
            }
            if (isInterrupt(dumped) && cpuInterrupted) {
              return { result: undefined, error: cpuTimeoutError };
            }
            return { result: undefined, error: formatGuestError(dumped) };
          }
          if (bridge.pending === 0) {
            return {
              result: undefined,
              error:
                "Execution stalled: code awaits something that can never settle.",
            };
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            return timedOut();
          }
          const settled = await waitForHostOrDeadline(
            bridge.waitForSettle,
            remaining,
          );
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
