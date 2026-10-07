import { createConnecta, customExecutor } from "../../../src/index.js";
import { workerExecutor } from "../../../src/worker.js";
import type { AdmittingExecutor } from "../../../src/types.js";

let loaded = 0;
let workersDisposed = 0;
let entrypointsDisposed = 0;
let pending = 0;
let calls = 0;
let executor: AdmittingExecutor;
let app: ReturnType<typeof createConnecta>;

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader }) {
    if (!app) {
      // Observe the real native handles, not a stand-in executor.
      const loader = new Proxy(env.LOADER, {
        get(target, key) {
          if (key !== "load") return Reflect.get(target, key);
          return (code: WorkerLoaderWorkerCode) => {
            loaded++;
            const worker = target.load(code);
            return new Proxy(worker, {
              get(target, key) {
                if (key === Symbol.dispose) return () => {
                  workersDisposed++;
                  Reflect.get(target, key).call(target);
                };
                if (key === "getEntrypoint") return () => {
                  const entrypoint = target.getEntrypoint();
                  return new Proxy(entrypoint, {
                    get(target, key) {
                      if (key === Symbol.dispose) return () => {
                        entrypointsDisposed++;
                        Reflect.get(target, key).call(target);
                      };
                      const value = Reflect.get(target, key);
                      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
                    },
                  });
                };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
              },
            });
          };
        },
      });
      const inner = workerExecutor({ loader, timeout: 800, admission: {
        concurrency: 1, maxQueueSize: 0, queueTimeoutMs: 1_000,
      } });
      executor = {
        ...inner,
        async acquire(options) {
          const lease = await inner.acquire(options);
          return {
            ...lease,
            async execute(code, providers) {
              pending++;
              try { return await lease.execute(code, providers); }
              finally { pending--; }
            },
          };
        },
      };
      app = createConnecta({
        publicUrl: "http://localhost",
        logger: "silent",
        executor: customExecutor(executor, { lifecycle: "self-managed" }),
        connectors: [{
          id: "reader", kind: "api",
          async listTools() { return [{ name: "read", annotations: { readOnlyHint: true } }]; },
          async callTool() { calls++; return "ok"; },
        }],
      });
    }
    if (new URL(request.url).pathname === "/status") return Response.json({
      loaded, workersDisposed, entrypointsDisposed, pending, calls,
      admission: executor.admissionSnapshot?.(),
    });
    return app.fetch(request);
  },
};
