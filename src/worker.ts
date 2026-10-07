// The upstream sandbox, with request-owned loader/RPC handles. A guest's
// deadline cannot clean up after the parent response has already ended.
import { DynamicWorkerExecutor, type DynamicWorkerExecutorOptions } from "@cloudflare/codemode";
import {
  AdmissionController,
  type AdmissionControllerOptions,
  ExecutorExecutionError,
} from "./executor-admission.js";
import type { AdmittingExecutor, ExecuteResult, ExecutorLease, ExecutorProvider } from "./types.js";

interface WorkerExecutorOptions {
  loader: DynamicWorkerExecutorOptions["loader"];
  timeout?: number;
  admission?: AdmissionControllerOptions;
}

/** Loader-only upstream sandbox whose lease disposes handles at run end. */
export function workerExecutor(options: WorkerExecutorOptions): AdmittingExecutor {
  const admission = new AdmissionController(options.admission ?? {
    concurrency: 2,
    maxQueueSize: 8,
    queueTimeoutMs: 5_000,
    retryAfterMs: 1_000,
  });
  const active = new Set<ExecutorLease>();
  return {
    name: "DynamicWorkerExecutor",
    async acquire(request = {}) {
      const permit = await admission.acquire(request);
      const disposers: Array<() => void> = [];
      let released = false;
      let executed = false;
      let cancel: (() => void) | undefined;
      let hostProviders: ExecutorProvider[] | undefined;
      // An upstream evaluation can remain pending after disposal. Its
      // dispatchers retain only these forwarders, detached on lease release.
      const forward = (index: number, name: string) => (...args: unknown[]) => {
        const fn = hostProviders?.[index]?.fns[name];
        return fn ? fn(...args) : Promise.reject(new Error("The Worker run ended."));
      };
      // Keep each native method's receiver and make upstream's later finally
      // harmless. Release RPC stubs before the Worker Loader handle.
      const track = <T extends object>(resource: T, entrypoint = false): T => {
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          const method = Reflect.get(resource, Symbol.dispose);
          if (typeof method === "function") method.call(resource);
        };
        disposers.push(dispose);
        return new Proxy(resource, {
          get(target, key) {
            if (key === Symbol.dispose) return dispose;
            if (key === "getEntrypoint" && !entrypoint) {
              return (...args: unknown[]) => track(
                Reflect.apply(Reflect.get(target as object, key), target, args) as object, true,
              );
            }
            const value = Reflect.get(target, key);
            return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
          },
        });
      };
      const loader = new Proxy(options.loader, {
        get(target, key) {
          if (key === "load") return (...args: unknown[]) => {
            if (released) throw new Error("Executor lease was already released.");
            return track(Reflect.apply(Reflect.get(target, key), target, args));
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
        },
      });
      const lease: ExecutorLease = {
        waitMs: permit.waitMs,
        async execute(code, providers) {
          if (released) throw new Error("Executor lease was already released.");
          if (executed) throw new Error("Executor lease may execute only once.");
          executed = true;
          hostProviders = providers;
          const detached = providers.map((provider, index) => ({
            name: provider.name,
            ...(provider.prelude ? { prelude: provider.prelude } : {}),
            fns: Object.fromEntries(Object.keys(provider.fns).map((name) => [name, forward(index, name)])),
          }));
          const stopped = new Promise<ExecuteResult>((_resolve, reject) => {
            cancel = () => reject(new ExecutorExecutionError(
              "executor_cancelled", "Worker executor lease was released during execution.",
            ));
          });
          try {
            return await Promise.race([
              new DynamicWorkerExecutor({
                loader,
                ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
              }).execute(code, detached),
              stopped,
            ]);
          } finally {
            cancel = undefined;
          }
        },
        release() {
          if (released) return;
          released = true;
          hostProviders = undefined;
          cancel?.();
          for (const dispose of disposers.reverse()) {
            try { dispose(); } catch { /* Release every handle and the permit. */ }
          }
          disposers.length = 0;
          active.delete(lease);
          permit.release();
        },
      };
      active.add(lease);
      return lease;
    },
    async execute(code, providers) {
      const lease = await this.acquire();
      try { return await lease.execute(code, providers); }
      finally { lease.release(); }
    },
    admissionSnapshot: () => admission.snapshot(),
    close() {
      admission.close();
      for (const lease of active) lease.release();
    },
  };
}
