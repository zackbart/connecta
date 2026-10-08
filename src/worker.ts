// The upstream sandbox, with request-owned loader/RPC handles. A guest's
// deadline cannot clean up after the parent response has already ended.
import { DynamicWorkerExecutor, normalizeCode, type DynamicWorkerExecutorOptions } from "@cloudflare/codemode";
import {
  AdmissionController,
  type AdmissionControllerOptions,
  ExecutorExecutionError,
} from "./executor-admission.js";
import type { AdmittingExecutor, ExecuteResult, ExecutorLease, ExecutorProvider } from "./types.js";
import { brandExecutor } from "./executor-contract.js";
import { InvocationFailure } from "./invocation.js";
import { parse, type Node } from "acorn";
import { isolateGuestProgram } from "./guest-runtime.js";

/** Parse guest syntax before rewriting imports; strings and regexes are data. */
function routeGuestImports(source: string): string {
  const offsets: number[] = [];
  const visit = (node: Node) => {
    if (node.type === "ImportExpression") offsets.push(node.start - 1);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && "type" in child) visit(child);
      } else if (value && typeof value === "object" && "type" in value) visit(value as Node);
    }
  };
  visit(parse(`(${source})`, { ecmaVersion: "latest", sourceType: "module", locations: true }));
  for (const offset of offsets.sort((a, b) => b - a)) {
    source = source.slice(0, offset) + "__connecta_import" + source.slice(offset + 6);
  }
  return source;
}

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
  return brandExecutor<AdmittingExecutor>({
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
      const forward = (index: number, name: string) => async (...args: unknown[]) => {
        const fn = hostProviders?.[index]?.fns[name];
        try {
          if (!fn) throw new Error("The Worker run ended.");
          return { ok: true, value: await fn(...args) };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : "Host call failed.",
            ...(error instanceof InvocationFailure ? { call: error.details } : {}) };
        }
      };
      let rpcOutcome: ExecuteResult | undefined;
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
            if (key === "evaluate" && entrypoint) return async (...args: unknown[]) => {
              const result = await Reflect.apply(Reflect.get(target as object, key), target, args) as ExecuteResult;
              // Only the native RPC return channel supplies executor facts.
              rpcOutcome = result;
              return result;
            };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
          },
        });
      };
      let executableCode: string | undefined;
      let normalizationLines = 0;
      const loader = new Proxy(options.loader, {
        get(target, key) {
          if (key === "load") return (...args: unknown[]) => {
            if (released) throw new Error("Executor lease was already released.");
            const definition = args[0] as { modules?: Record<string, unknown> };
            const source = definition?.modules?.["executor.js"];
            // Keep guest source in its own module, outside the lexical scope of
            // RPC dispatchers and retained host-failure identities.
            if (typeof source !== "string" || !executableCode || !hostProviders) throw new Error("Worker executable module was unavailable.");
            const index = source.indexOf(executableCode);
            if (index < 0) throw new Error("Worker executable module did not contain the program.");
            const guest = isolateGuestProgram(executableCode);
            if (guest) normalizationLines = 0;
            const names = hostProviders.map(provider => provider.name).join(", ");
            const globals = hostProviders.map(provider => `globalThis[${JSON.stringify(provider.name)}] = ${provider.name};`).join("\n");
            let isolated = source.slice(0, index) + "__connecta_program" + source.slice(index + executableCode.length);
            const bridge = `if (data.error) throw new Error(data.error);\n          return data.result;`;
            if (!isolated.includes(bridge)) throw new Error("Worker bridge contract changed.");
            isolated = isolated.replaceAll(bridge, `if (data.error) throw new NativeError(data.error);
          const reply = data.result;
          if (!reply.ok) {
            const error = new NativeError(reply.error);
            if (reply.call) {
              retain(failures, error, reply.call);
              defineProperties(error, {
                code: { value: reply.call.code, enumerable: true },
                retryable: { value: reply.call.retryable, enumerable: true },
                details: { value: freeze(reply.call), enumerable: true }
              });
            }
            throw error;
          }
          return reply.value;`);
            isolated = isolated.replace('    const __logs = [];', `    if (initialized) throw new Error("Worker initialization is single-use.");
    initialized = true;
    const NativeError = Error;
    const defineProperties = Object.defineProperties;
    const freeze = Object.freeze;
    const retain = Function.prototype.call.bind(WeakMap.prototype.set);
    const lookup = Function.prototype.call.bind(WeakMap.prototype.get);
    const slice = Function.prototype.call.bind(String.prototype.slice);
    const failures = new WeakMap();
    const timeoutError = new NativeError("Execution timed out");
    const __logs = [];`);
            isolated = isolated.replace('new Error("Execution timed out")', 'timeoutError');
            isolated = isolated.replace('return { result: undefined, error: err.message, logs: __logs };', `
      const call = lookup(failures, err);
      let name = "Error", message = "Program threw a value.", stack = "";
      try {
        if (typeof err === "string") message = slice(err, 0, 1000);
        else if (err) {
          if (typeof err.name === "string") name = slice(err.name, 0, 64);
          if (typeof err.message === "string") message = slice(err.message, 0, 1000);
          if (typeof err.stack === "string") stack = slice(err.stack, 0, 1000);
        }
      } catch {}
      const location = /connecta-guest\\.js:(\\d+):\\d+/.exec(stack);
      return { result: undefined, error: message, logs: __logs, failure: {
        name, ...(call ? { call } : {}), ...(location ? { line: Number(location[1]) - 1 } : {}),
        ...(err === timeoutError ? { timeout: { elapsedMs: ${options.timeout ?? 60_000}, deadlineMs: ${options.timeout ?? 60_000} } } : {})
      } };`);
            const preludes: string[] = [];
            let firstInitializer: string | undefined;
            for (const provider of hostProviders) {
              if (!provider.prelude) continue;
              if (!isolated.includes(provider.prelude)) throw new Error("Worker provider setup was unavailable.");
              preludes.push(provider.prelude);
              const call = firstInitializer ? "" : `__connecta_initialize(${names});`;
              isolated = isolated.replace(provider.prelude, call);
              firstInitializer ||= call;
            }
            // Successive preludes share lexical bindings in both executors.
            const initializer = preludes.length ? `const __connecta_initialize = (${names}) => {\n${preludes.join("\n")}\n};\n` : "";
            const before = firstInitializer ? isolated.indexOf(firstInitializer) : isolated.indexOf("    try {\n      const result = await Promise.race");
            if (before < 0) throw new Error("Worker provider setup was unavailable.");
            // Runner modules are inaccessible to guest imports. The callback has
            // no lexical access to initialization or RPC dispatchers.
            const imports = guest
              ? 'import __connecta_user_program from "./connecta-guest.js";\n'
              : 'import __connecta_program from "./connecta-guest.js";\n';
            const wrapper = guest ? `const __connecta_program = (${guest.wrapper});\n` : "";
            const main = imports + "let initialized = false;\n" + initializer + wrapper + isolated.slice(0, before) + globals + "\n" + isolated.slice(before);
            return track(Reflect.apply(Reflect.get(target, key), target, [{ ...definition, modules: {
              ...definition.modules,
              "executor.js": main,
              "connecta-guest.js": `const startsWith = Function.prototype.call.bind(String.prototype.startsWith); const reject = Promise.reject.bind(Promise); const NativeError = Error; const __connecta_import = specifier => typeof specifier === "string" && (startsWith(specifier, "node:") || specifier === "cloudflare:workers") ? import(specifier) : reject(new NativeError("Imports of runner modules are outside the guest API."));\nexport default (${routeGuestImports(guest?.program ?? executableCode)});`,
            } }, ...args.slice(1)]));
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
          executableCode = normalizeCode(code);
          const original = executableCode.indexOf(code.trim());
          if (original >= 0) normalizationLines = executableCode.slice(0, original).split("\n").length - 1;
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
          const started = Date.now();
          try {
            const result = await Promise.race([
              new DynamicWorkerExecutor({
                loader,
                ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
              }).execute(code, detached),
              stopped,
            ]);
            const outcome: ExecuteResult = rpcOutcome ?? result;
            if (outcome.failure?.timeout) outcome.failure.timeout.elapsedMs = Date.now() - started;
            return outcome;
          } catch (error) {
            const message = error instanceof Error ? error.message : "";
            // Worker Loader erases the native SyntaxError type at its RPC edge.
            // Match its startup diagnostic only; guest/downstream failures return normally.
            const syntax = /^Failed to start Worker:\nUncaught SyntaxError: ([^\n]*)\n\s+at connecta-guest\.js:(\d+):\d+$/.exec(message);
            if (error instanceof SyntaxError || syntax) {
              const location = error instanceof SyntaxError && "loc" in error ? error.loc as { line?: number } : undefined;
              const line = syntax ? Math.max(1, Number(syntax[2]) - normalizationLines - 1)
                : location?.line !== undefined ? Math.max(1, location.line) : undefined;
              return { result: undefined, error: (syntax?.[1] ?? message) || "Invalid JavaScript program.", failure: { name: "SyntaxError", ...(line !== undefined ? { line } : {}) } };
            }
            throw error;
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
  }, "leased");
}
