// QuickJS-in-WebAssembly executor — the Node-side sandbox for execute_code.
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
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import type { ExecuteResult, Executor, ExecutorProvider } from "../types.js";

export interface QuickJsExecutorOptions {
  /**
   * Wall-clock budget for the whole execution, host tool calls included
   * (same wall-clock-budget semantics as codemode's DynamicWorkerExecutor).
   * Default 30s — intentionally tighter than codemode's 60s default: connecta
   * sandbox code is tool-call glue, not compute, so a shorter leash surfaces
   * hung downstreams sooner. Raise it here if a workload legitimately needs it.
   */
  timeoutMs?: number;
  /** Guest heap limit. Default 64 MiB. */
  memoryLimitBytes?: number;
  /** Guest stack limit. Default 1 MiB. */
  maxStackSizeBytes?: number;
}

const MAX_LOG_ENTRIES = 200;
// Cap each entry AND the cumulative buffer at capture time so untrusted guest
// code can't retain unbounded host memory: a single `console.log("x".repeat(N))`
// otherwise copies the whole N-char guest string into a host array we hold for
// the entire execution. 8k chars/entry is generous for glue-code logging (the
// join in execute.ts trims the assembled log to 4k anyway), and 256k total
// keeps the worst case — 200 maxed-out entries — bounded well under a MiB.
const MAX_LOG_ENTRY_CHARS = 8_000;
const MAX_LOG_TOTAL_CHARS = 256_000;
// Keep one host result below the range where quickjs-emscripten@0.32.0 can
// nondeterministically fail during runtime disposal under concurrent load.
// This still lets guest code reduce data more than ten times larger than
// connecta's final response budget.
const MAX_HOST_RESULT_BYTES = 256 * 1024;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/** Guest-side prelude: console capture, the JSON call bridge, one frozen global per provider. */
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
  ];
  for (const p of providers) {
    const ns = JSON.stringify(p.name);
    const fields = Object.keys(p.fns).map((fn) => {
      const f = JSON.stringify(fn);
      // Forward every argument verbatim, positionally — same as codemode's
      // sandbox proxy (`(...args) => call(fn, args)`). The host wrappers in
      // buildSandboxProviders already guard the no-arg case, so no coercion.
      return `  [${f}]: (...a) => __invoke(${ns}, ${f}, a),`;
    });
    lines.push(`globalThis[${ns}] = Object.freeze({\n${fields.join("\n")}\n});`);
  }
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

  // Running total of chars actually retained in `logs`; once the cumulative
  // budget is spent we push one marker and drop the rest, so a flood of large
  // entries can't grow the host array without bound.
  let logTotalChars = 0;
  let logBudgetSpent = false;
  const logFn = ctx.newFunction("__log", (h) => {
    if (logs.length >= MAX_LOG_ENTRIES) {
      if (logs.length === MAX_LOG_ENTRIES) {
        logs.push(`[log truncated after ${MAX_LOG_ENTRIES} entries]`);
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
    if (logTotalChars + entry.length > MAX_LOG_TOTAL_CHARS) {
      logs.push("[log truncated: size budget exceeded]");
      logBudgetSpent = true;
      return;
    }
    logs.push(entry);
    logTotalChars += entry.length;
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
 * Sandbox executor for Node (or any JS runtime) built on quickjs-emscripten.
 * Suits connecta's execute_code: code is tool-call glue, so an interpreter's
 * speed is irrelevant while its isolation (plain WASM, zero native deps) is
 * the point. One fresh QuickJS context per execution; the WASM module itself
 * is cached across calls by quickjs-emscripten.
 */
export function quickJsExecutor(
  options: QuickJsExecutorOptions = {},
): Executor {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
  const maxStackSizeBytes = options.maxStackSizeBytes ?? 1024 * 1024;

  return {
    async execute(
      code: string,
      providers: ExecutorProvider[],
    ): Promise<ExecuteResult> {
      const QuickJS = await getQuickJS();
      const ctx = QuickJS.newContext();
      const deadline = Date.now() + timeoutMs;
      const timeoutError = `Execution timed out after ${timeoutMs}ms.`;
      ctx.runtime.setMemoryLimit(memoryLimitBytes);
      ctx.runtime.setMaxStackSize(maxStackSizeBytes);
      ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

      const logs: string[] = [];
      const bridge = installBridge(ctx, providers, logs);
      const finish = (r: ExecuteResult): ExecuteResult => {
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

      const setup = ctx.evalCode(setupScript(providers));
      if (setup.error) {
        const detail = formatGuestError(ctx.dump(setup.error));
        setup.error.dispose();
        return fail(`Sandbox setup failed: ${detail}`);
      }
      setup.value.dispose();

      const evaluated = ctx.evalCode(
        `Promise.resolve((\n${normalizeCode(code)}\n)())`,
      );
      if (evaluated.error) {
        const dumped = ctx.dump(evaluated.error);
        evaluated.error.dispose();
        // A synchronous runaway (no await to yield on) trips the deadline
        // interrupt here; surface the friendly timeout, not "interrupted".
        if (isInterrupt(dumped) && Date.now() >= deadline) return fail(timeoutError);
        return fail(formatGuestError(dumped));
      }
      const promiseHandle = evaluated.value;

      // Drive the guest: run microtask jobs, inspect the result promise,
      // sleep until a host call settles (or the budget runs out), repeat.
      // Returns without touching the context lifecycle; disposal happens below.
      const drive = async (): Promise<ExecuteResult> => {
        for (;;) {
          const jobs = ctx.runtime.executePendingJobs();
          if (jobs.error) {
            const dumped = ctx.dump(jobs.error);
            jobs.error.dispose();
            // A runaway inside a resumed continuation trips the interrupt here.
            if (isInterrupt(dumped) && Date.now() >= deadline) {
              return { result: undefined, error: timeoutError };
            }
            return { result: undefined, error: formatGuestError(dumped) };
          }
          const state = ctx.getPromiseState(promiseHandle);
          if (state.type === "fulfilled") {
            const result: unknown = ctx.dump(state.value);
            state.value.dispose();
            return { result };
          }
          if (state.type === "rejected") {
            const dumped = ctx.dump(state.error);
            state.error.dispose();
            // A synchronous runaway rejects the async fn's promise with the
            // interrupt; surface the friendly timeout, not "interrupted".
            if (isInterrupt(dumped) && Date.now() >= deadline) {
              return { result: undefined, error: timeoutError };
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
            return { result: undefined, error: timeoutError };
          }
          const settled = await waitForHostOrDeadline(
            bridge.waitForSettle,
            remaining,
          );
          if (settled) armWake(bridge);
          else {
            return { result: undefined, error: timeoutError };
          }
        }
      };

      let outcome: ExecuteResult;
      try {
        outcome = await drive();
      } finally {
        promiseHandle.dispose();
      }
      return finish(outcome);
    },
  };
}
