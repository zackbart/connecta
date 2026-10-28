// The upstream sandbox, with request-owned loader/RPC handles. A guest's
// deadline cannot clean up after the parent response has already ended.
import { Deferred, Effect, Exit, Scope } from "effect";
import { admit } from "./runtime/admission.js";
import { detach, runEdge } from "./runtime/run.js";
import { awaitExecutorLease, provideExecutorProgram, executorProgram } from "./runtime/executor.js";
import { DynamicWorkerExecutor, normalizeCode, type DynamicWorkerExecutorOptions } from "@cloudflare/codemode";
import { AdmissionController, type AdmissionControllerOptions, ExecutorExecutionError } from "./executor-admission.js";
import type { AdmittingExecutor, ExecuteResult, ExecutorLease, ExecutorProvider } from "./types.js";
import { brandExecutor } from "./executor-contract.js";
import { InvocationFailure } from "./invocation.js";
import { parse, type Node } from "acorn";
import { guestInitializer, guestPrelude, guestPromiseInitializer, isolateGuestProgram } from "./guest-runtime.js";

/** Private RPC identity; published executor results contain only host facts. */
type WorkerRunResult = ExecuteResult & {
  failure?: NonNullable<ExecuteResult["failure"]> & { failureId?: string };
};

/** Parse guest syntax before rewriting imports; strings and regexes are data. */
function routeGuestImports(source: string): string {
  const offsets: number[] = [];
  const visit = (node: Node) => {
    if (node.type === "ImportExpression") offsets.push(node.start - "export default (".length);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child === "object" && "type" in child) visit(child);
      } else if (value && typeof value === "object" && "type" in value) visit(value as Node);
    }
  };
  const module = parse(`export default (${source}\n);`, {
    ecmaVersion: "latest",
    sourceType: "module",
    locations: true,
  });
  // Closing the parentheses and adding statements must never create module
  // code outside this one expression. Check the assembled splice, including
  // comments and all grouping parentheses, before the loader sees any source.
  if (module.body.length !== 1 || module.body[0]?.type !== "ExportDefaultDeclaration") {
    throw new SyntaxError("A Worker program must contain exactly one expression.");
  }
  visit(module);
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
  // One pool per executor, so per isolate. A queued run may wait out one
  // default guest deadline: programs spend it awaiting host calls, and a
  // five-second wait refused nearly every run queued behind one.
  const admission = new AdmissionController(
    options.admission ?? {
      concurrency: 2,
      maxQueueSize: 8,
      queueTimeoutMs: 60_000,
      retryAfterMs: 1_000,
    },
  );
  const active = new Set<ExecutorLease>();
  const acquire = (request: { signal?: AbortSignal; wait?: boolean } = {}) =>
    Effect.gen(function* () {
      const permit = yield* admit(admission, request);
      const resources = Scope.makeUnsafe();
      const stopped = Deferred.makeUnsafe<never, ExecutorExecutionError>();

      let released = false;
      let executed = false;
      let runEnded = false;
      let hostProviders: ExecutorProvider[] | undefined;
      const hostFailures = new Map<string, InvocationFailure["details"]>();
      // An upstream evaluation can remain pending after disposal. Its
      // dispatchers retain only these forwarders, detached on lease release.
      const forward =
        (index: number, name: string) =>
        (...args: unknown[]) =>
          runEdge(
            Effect.raceFirst(
              Effect.tryPromise({
                try: () => {
                  const fn = hostProviders?.[index]?.fns[name];
                  if (!fn || released || runEnded) throw new Error("The Worker run ended.");
                  return Promise.resolve(fn(...args));
                },
                catch: (error) => error,
              }),
              Deferred.await(stopped),
            ).pipe(
              Effect.match({
                onSuccess: (value) => ({ ok: true, value }),
                onFailure: (error) => {
                  const message = error instanceof Error ? error.message : "Host call failed.";
                  if (error instanceof InvocationFailure && !released && !runEnded) {
                    const failureId = crypto.randomUUID();
                    hostFailures.set(failureId, error.details);
                    // Guest hooks receive a copy; authority remains in this map.
                    return {
                      ok: false,
                      error: {
                        message,
                        code: error.details.code,
                        retryable: error.details.retryable,
                        details: structuredClone(error.details),
                      },
                      failureId,
                    };
                  }
                  return { ok: false, error: { message } };
                },
              }),
            ),
          );
      // The SDK prepares its source/dispatchers against this inert loader.
      // Actual Loader and RPC acquisition belongs to the native program below.
      let prepared: { load: () => object; args?: unknown[] | undefined } | undefined;
      const dispose = (resource: object) =>
        Effect.sync(() => {
          try {
            const method = Reflect.get(resource, Symbol.dispose);
            if (typeof method === "function") method.call(resource);
          } catch {
            /* A failed RPC disposer cannot skip the Loader cleanup. */
          }
        });
      let executableCode: string | undefined;
      let guestProgram: ReturnType<typeof isolateGuestProgram>;
      let normalizationLines = 0;
      const loader = new Proxy(options.loader, {
        get(target, key) {
          if (key === "load")
            return (...args: unknown[]) => {
              if (released) throw new Error("Executor lease was already released.");
              const definition = args[0] as { modules?: Record<string, unknown> };
              const source = definition?.modules?.["executor.js"];
              // Keep guest source in its own module, outside the lexical scope of
              // RPC dispatchers and retained host-failure identities.
              if (typeof source !== "string" || !executableCode || !hostProviders)
                throw new Error("Worker executable module was unavailable.");
              const index = source.indexOf(executableCode);
              if (index < 0) throw new Error("Worker executable module did not contain the program.");
              const guest = guestProgram;
              if (guest) normalizationLines = 0;
              const names = hostProviders.map((provider) => provider.name).join(", ");
              const globals = hostProviders
                .map((provider) => `globalThis[${JSON.stringify(provider.name)}] = ${provider.name};`)
                .join("\n");
              let isolated =
                source.slice(0, index) + "__connecta_program" + source.slice(index + executableCode.length);
              const bridge = `if (data.error) throw new Error(data.error);\n          return data.result;`;
              if (hostProviders.length > 0 && !isolated.includes(bridge))
                throw new Error("Worker bridge contract changed.");
              isolated = isolated.replaceAll(
                bridge,
                `if (data.error) throw new NativeError(data.error);
          const reply = data.result;
          if (!reply.ok) {
            const error = new NativeError(reply.error.message);
            if (typeof reply.failureId === "string") {
              retain(failures, error, reply.failureId);
              defineProperties(error, {
                code: { value: reply.error.code, enumerable: true },
                retryable: { value: reply.error.retryable, enumerable: true },
                details: { value: freeze(clone(reply.error.details)), enumerable: true },
                data: { value: freeze(clone(reply.error.details)), enumerable: true }
              });
            }
            throw error;
          }
          return reply.value;`,
              );
              isolated = isolated.replace(
                "    const __logs = [];",
                `    if (initialized) throw new NativeError("Worker initialization is single-use.");
    initialized = true;
    const failures = new NativeWeakMap();
    const timeoutError = new NativeError("Execution timed out");
    const __logs = [];`,
              );
              isolated = isolated.replace('new Error("Execution timed out")', "timeoutError");
              isolated = isolated.replace(
                "setTimeout(() => reject(timeoutError)",
                "nativeSetTimeout(() => reject(timeoutError)",
              );
              isolated = isolated.replace(
                "return { result: undefined, error: err.message, logs: __logs };",
                `
      const failureId = lookup(failures, err);
      let name = "Error", message = "Program threw a value.", stack = "";
      try {
        if (typeof err === "string") message = slice(err, 0, 1000);
        else if (err) {
          if (typeof err.name === "string") name = slice(err.name, 0, 64);
          if (typeof err.message === "string") message = slice(err.message, 0, 1000);
          if (typeof err.stack === "string") stack = slice(err.stack, 0, 1000);
        }
      } catch {}
      const location = exec(/connecta-guest\\.js:(\\d+):\\d+/, stack);
      return { result: undefined, error: message, logs: __logs, failure: {
        name, ...(failureId ? { failureId } : {}), ...(location ? { line: toNumber(location[1]) - 1 } : {}),
        ...(err === timeoutError ? { timeout: { elapsedMs: ${options.timeout ?? 60_000}, deadlineMs: ${options.timeout ?? 60_000} } } : {})
      } };`,
              );
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
              const captureGuest = preludes.includes(guestPrelude());
              const initializer = preludes.length
                ? `const __connecta_initialize = (${names}) => {\n${preludes.map((prelude) => (prelude === guestPrelude() ? "__connecta_guest_initialize(connecta);" : prelude)).join("\n")}\n};\n`
                : "";
              // Runner modules are inaccessible to guest imports. The callback has
              // no lexical access to initialization or RPC dispatchers.
              const programName = guest ? "__connecta_user_program" : "__connecta_program";
              const imports =
                'import Runner from "./connecta-runner.js";\n' + `import program from "./connecta-guest.js";\n`;
              const wrapper = guest ? `    const __connecta_program = (${guest.wrapper});\n` : "";
              const hardening = `
const builtinAllowed = name => typeof name === "string" && name !== "module" && name !== "node:module" && name !== "process" && name !== "node:process";
if (typeof process !== "undefined" && typeof process.getBuiltinModule === "function") {
  const getBuiltin = process.getBuiltinModule.bind(process);
  Object.defineProperty(process, "getBuiltinModule", { configurable: false, writable: false,
    value: name => builtinAllowed(name) ? getBuiltin(name) : undefined });
}
`;
              // ESM evaluates the first dependency completely before the next.
              // This module has no guest dependency; its references and retained
              // failures stay private, and guest imports cannot reach its export.
              const captures = `
const {
  NativeError, NativeWeakMap, NativeProxy, NativePromise, NativeUint8Array, NativeArrayBuffer,
  defineProperties, freeze, clone, retain, lookup, slice, nativeSetTimeout, toNumber, exec,
  hasOwn, push, map, join, toString, fromCharCode, min, subarray, charCodeAt, bufferSlice,
  isView, nativeBtoa, nativeAtob, race, jsonParse, jsonStringify, nativeConsole
} = Object.freeze({
  NativeError: Error, NativeWeakMap: WeakMap, NativeProxy: Proxy, NativePromise: Promise,
  NativeUint8Array: Uint8Array, NativeArrayBuffer: ArrayBuffer,
  defineProperties: Object.defineProperties, freeze: Object.freeze, clone: structuredClone,
  retain: Function.prototype.call.bind(WeakMap.prototype.set),
  lookup: Function.prototype.call.bind(WeakMap.prototype.get),
  slice: Function.prototype.call.bind(String.prototype.slice),
  nativeSetTimeout: setTimeout, toNumber: Number,
  exec: Function.prototype.call.bind(RegExp.prototype.exec),
  hasOwn: Function.prototype.call.bind(Object.prototype.hasOwnProperty),
  push: Function.prototype.call.bind(Array.prototype.push),
  map: Function.prototype.call.bind(Array.prototype.map),
  join: Function.prototype.call.bind(Array.prototype.join), toString: String,
  fromCharCode: String.fromCharCode, min: Math.min,
  subarray: Function.prototype.call.bind(Uint8Array.prototype.subarray),
  charCodeAt: Function.prototype.call.bind(String.prototype.charCodeAt),
  bufferSlice: Function.prototype.call.bind(ArrayBuffer.prototype.slice),
  isView: ArrayBuffer.isView, nativeBtoa: btoa, nativeAtob: atob,
  race: Promise.race.bind(Promise), jsonParse: JSON.parse, jsonStringify: JSON.stringify,
  nativeConsole: console
});
`;
              const binaryTagCheck = "(__CODEMODE_BINARY_TAG in value)";
              const binaryDataCheck = 'typeof value.data !== "string"';
              if (!isolated.includes(binaryTagCheck) || !isolated.includes(binaryDataCheck)) {
                throw new Error("Worker binary codec contract changed.");
              }
              isolated = isolated
                .replace(
                  "async evaluate(__dispatchers = {}, __connectors = {}) {",
                  `async evaluate(__dispatchers = {}, __connectors = {}, ${programName}) {\n${wrapper}`,
                )
                .replaceAll("JSON.parse(", "jsonParse(")
                .replaceAll("JSON.stringify(", "jsonStringify(")
                .replaceAll(binaryTagCheck, "hasOwn(value, __CODEMODE_BINARY_TAG)")
                .replaceAll(binaryDataCheck, '!hasOwn(value, "data") || typeof value.data !== "string"')
                .replaceAll("console.", "nativeConsole.")
                .replaceAll("new Proxy(", "new NativeProxy(")
                .replaceAll("Object.prototype.hasOwnProperty.call(target, toolName)", "hasOwn(target, toolName)")
                .replaceAll("String(toolName)", "toString(toolName)")
                .replaceAll('a.map(String).join(" ")', 'join(map(a, toString), " ")')
                .replaceAll("__logs.push(", "push(__logs, ")
                .replaceAll("String.fromCharCode(", "fromCharCode(")
                .replaceAll(
                  "bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength))",
                  "subarray(bytes, i, min(i + chunkSize, bytes.byteLength))",
                )
                .replaceAll("btoa(binary)", "nativeBtoa(binary)")
                .replaceAll("atob(b64)", "nativeAtob(b64)")
                .replaceAll("new Uint8Array(", "new NativeUint8Array(")
                .replaceAll("instanceof Uint8Array", "instanceof NativeUint8Array")
                .replaceAll("instanceof ArrayBuffer", "instanceof NativeArrayBuffer")
                .replaceAll("ArrayBuffer.isView(", "isView(")
                .replaceAll("binary.charCodeAt(i)", "charCodeAt(binary, i)")
                .replaceAll(
                  "bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)",
                  "bufferSlice(bytes.buffer, bytes.byteOffset, bytes.byteOffset + bytes.byteLength)",
                )
                .replaceAll("Promise.race(", "race(")
                .replaceAll("new Promise(", "new NativePromise(");
              // Recompute the insertion point after changing the generated runner.
              const setup = firstInitializer
                ? isolated.indexOf(firstInitializer)
                : isolated.indexOf("    try {\n      const result = await race");
              if (setup < 0) throw new Error("Worker provider setup was unavailable.");
              const runner =
                hardening +
                (captureGuest
                  ? `const __connecta_guest_initialize = ${guestInitializer()};\n`
                  : `${guestPromiseInitializer()};\n`) +
                captures +
                "let initialized = false;\n" +
                initializer +
                isolated.slice(0, setup) +
                globals +
                "\n" +
                isolated.slice(setup);
              const main =
                imports +
                `export default class CodeExecutor extends Runner {
  evaluate(dispatchers, connectors) { return super.evaluate(dispatchers, connectors, program); }
}`;
              const routed = routeGuestImports(guest?.program ?? executableCode);
              const acquisition = {
                load: () =>
                  Reflect.apply(Reflect.get(target, key), target, [
                    {
                      ...definition,
                      modules: {
                        ...definition.modules,
                        "executor.js": main,
                        "connecta-runner.js": runner,
                        "connecta-guest.js": `const startsWith = Function.prototype.call.bind(String.prototype.startsWith); const reject = Promise.reject.bind(Promise); const NativeError = Error; const __connecta_import = specifier => typeof specifier === "string" && ((startsWith(specifier, "node:") && specifier !== "node:module" && specifier !== "node:process") || specifier === "cloudflare:workers") ? import(specifier) : reject(new NativeError("Imports of runner modules are outside the guest API."));\nexport default (${routed}\n);`,
                      },
                    },
                    ...args.slice(1),
                  ]) as object,
                args: undefined as unknown[] | undefined,
              };
              prepared = acquisition;
              return {
                getEntrypoint: () => ({
                  evaluate: (...evaluateArgs: unknown[]) => {
                    acquisition.args = evaluateArgs;
                    return Promise.resolve({ result: undefined });
                  },
                }),
              };
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
        },
      });
      const execute = (code: string, providers: ExecutorProvider[]): Effect.Effect<ExecuteResult, unknown> =>
        Effect.suspend(() => {
          if (released) return Effect.fail(new Error("Executor lease was already released."));
          if (executed) return Effect.fail(new Error("Executor lease may execute only once."));
          executed = true;
          return Effect.gen(function* () {
            hostProviders = providers;
            // Extract the fixed wrapper from the original source. Upstream may
            // wrap invalid syntax as a bare body; that must not turn an attempted
            // module escape into runnable statements or shift guest locations.
            guestProgram = isolateGuestProgram(code.trim());
            executableCode = normalizeCode(code);
            const original = executableCode.indexOf(code.trim());
            if (original >= 0) normalizationLines = executableCode.slice(0, original).split("\n").length - 1;
            const detached = providers.map((provider, index) => ({
              name: provider.name,
              ...(provider.prelude ? { prelude: provider.prelude } : {}),
              fns: Object.fromEntries(Object.keys(provider.fns).map((name) => [name, forward(index, name)])),
            }));
            const started = Date.now();
            const operation = Effect.gen(function* () {
              const setup = yield* Effect.tryPromise({
                try: () =>
                  new DynamicWorkerExecutor({
                    loader,
                    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
                  }).execute(code, detached),
                catch: (error) => error,
              });
              // Provider validation can return before the SDK reaches its loader.
              if (!prepared) return setup;
              const load = prepared.load;
              const args = prepared.args;
              const open = () =>
                Effect.suspend(() =>
                  released || resources.state._tag === "Closed"
                    ? Effect.fail(
                        new ExecutorExecutionError(
                          "executor_cancelled",
                          "Worker executor lease was released during execution.",
                        ),
                      )
                    : Effect.void,
                );
              const evaluation = Effect.gen(function* () {
                yield* open();
                const worker = yield* Effect.acquireRelease(
                  Effect.try({ try: load, catch: (error) => error }),
                  dispose,
                );
                yield* open();
                const entrypoint = yield* Effect.acquireRelease(
                  Effect.try({
                    try: () => Reflect.apply(Reflect.get(worker, "getEntrypoint"), worker, []) as object,
                    catch: (error) => error,
                  }),
                  dispose,
                );
                yield* open();
                return yield* Effect.tryPromise({
                  try: () =>
                    Reflect.apply(
                      Reflect.get(entrypoint, "evaluate"),
                      entrypoint,
                      args ?? [],
                    ) as Promise<WorkerRunResult>,
                  catch: (error) => error,
                });
              }).pipe(Scope.provide(resources));
              const result = yield* evaluation;
              const outcome: WorkerRunResult = result;
              if (outcome.failure) {
                const failure = { ...outcome.failure };
                const call = typeof failure.failureId === "string" ? hostFailures.get(failure.failureId) : undefined;
                // Neither an unknown id nor a guest/RPC-supplied call record
                // supplies typed host details. Strip the private id at the edge.
                delete failure.call;
                delete failure.failureId;
                outcome.failure = { ...failure, ...(call ? { call } : {}) };
              }
              if (outcome.failure?.timeout) outcome.failure.timeout.elapsedMs = Date.now() - started;
              return outcome;
            });
            return yield* operation.pipe(
              Effect.catch((error) => {
                const message = error instanceof Error ? error.message : "";
                // Worker Loader erases the native SyntaxError type at its RPC edge.
                // Match its startup diagnostic only; guest/downstream failures return normally.
                const syntax =
                  /^Failed to start Worker:\nUncaught SyntaxError: ([^\n]*)\n\s+at connecta-guest\.js:(\d+):\d+$/.exec(
                    message,
                  );
                if (error instanceof SyntaxError || syntax) {
                  const location =
                    error instanceof SyntaxError && "loc" in error ? (error.loc as { line?: number }) : undefined;
                  const line = syntax
                    ? Math.max(1, Number(syntax[2]) - normalizationLines - 1)
                    : location?.line !== undefined
                      ? Math.max(1, location.line)
                      : undefined;
                  return Effect.succeed({
                    result: undefined,
                    error: (syntax?.[1] ?? message) || "Invalid JavaScript program.",
                    failure: { name: "SyntaxError", ...(line !== undefined ? { line } : {}) },
                  });
                }
                return Effect.fail(error);
              }),
            );
          }).pipe(
            Effect.raceFirst(Deferred.await(stopped)),
            Effect.catchDefect((error) => Effect.fail(error)),
            Effect.ensuring(
              Effect.sync(() => {
                runEnded = true;
                hostProviders = undefined;
                prepared = undefined;
                hostFailures.clear();
                Deferred.doneUnsafe(
                  stopped,
                  Exit.fail(new ExecutorExecutionError("executor_cancelled", "The Worker run ended.")),
                );
              }),
            ),
            Effect.ensuring(Scope.close(resources, Exit.void)),
          );
        });
      const lease: ExecutorLease = {
        waitMs: permit.waitMs,
        execute: (code, providers) => runEdge(execute(code, providers)),
        release() {
          if (released) return;
          released = true;
          hostProviders = undefined;
          prepared = undefined;
          hostFailures.clear();
          // Only synchronous SDK disposers inhabit this scope. They run before
          // release returns, even if evaluate never settles or a disposer throws.
          void detach(Scope.close(resources, Exit.void));
          Deferred.doneUnsafe(
            stopped,
            Exit.fail(
              new ExecutorExecutionError("executor_cancelled", "Worker executor lease was released during execution."),
            ),
          );
          active.delete(lease);
          permit.release();
        },
      };
      provideExecutorProgram(lease, execute);
      active.add(lease);
      return lease;
    });
  const acquireShell: AdmittingExecutor["acquire"] = (request) => runEdge(acquire(request));
  const executor: AdmittingExecutor = {
    name: "DynamicWorkerExecutor",
    acquire: acquireShell,
    execute: (code, providers) => runEdge(execute(code, providers)),
    admissionSnapshot: () => admission.snapshot(),
    close() {
      admission.close();
      for (const lease of active) lease.release();
    },
  };
  const execute = (code: string, providers: ExecutorProvider[]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* Effect.acquireRelease(
          Effect.suspend(() =>
            executor.acquire !== acquireShell || admission.activeCount >= admission.concurrency
              ? awaitExecutorLease((signal) => executor.acquire({ signal }))
              : acquire(),
          ),
          (lease) => Effect.sync(() => lease.release()),
          { interruptible: true },
        );
        return yield* executorProgram(lease, code, providers);
      }),
    );
  provideExecutorProgram(executor, execute);
  return brandExecutor(executor, "leased");
}
