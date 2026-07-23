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

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  const logFn = ctx.newFunction("__log", (h) => {
    if (logs.length < MAX_LOG_ENTRIES) {
      logs.push(ctx.getString(h));
    } else if (logs.length === MAX_LOG_ENTRIES) {
      logs.push(`[log truncated after ${MAX_LOG_ENTRIES} entries]`);
    }
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
      return JSON.stringify({ ok: true, value });
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
          const settled = await Promise.race([
            bridge.waitForSettle.then(() => true),
            new Promise<boolean>((r) => setTimeout(() => r(false), remaining)),
          ]);
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
