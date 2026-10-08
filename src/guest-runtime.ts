/** Capture the single-use runner before evaluating the guest expression. */
export function wrapGuestProgram(code: string): string {
  return `async () => globalThis.__connecta_run()(async (connecta) => await (\n${code}\n)())`;
}

/** Separate user source from the trusted wrapper before publishing Worker modules. */
export function isolateGuestProgram(code: string): { program: string; wrapper: string } | undefined {
  const start = code.indexOf("async (connecta) => await (\n");
  const end = code.lastIndexOf("\n)())");
  if (start < 0 || end < start) return undefined;
  return {
    program: code.slice(start, end + "\n)()".length),
    wrapper: code.slice(0, start) + "__connecta_user_program" + code.slice(end + "\n)()".length),
  };
}

/**
 * Emissions are acknowledged before success, even when the guest omits await.
 * Capture intrinsics before user code can replace them.
 */
export function guestPrelude(): string {
  return `(() => {
  const NativePromise = Promise;
  const nativeResolve = Function.prototype.call.bind(NativePromise.resolve);
  const nativeRace = Function.prototype.call.bind(NativePromise.race);
  const isArray = Array.isArray;
  const iteratorKey = Symbol.iterator;
  const arrayValues = Function.prototype.call.bind(Array.prototype.values);
  const arrayNext = Function.prototype.call.bind(Object.getPrototypeOf([][Symbol.iterator]()).next);
  function safeRace(values) {
    // Upstream constructs its completion array after the program starts.
    // Use captured array iteration, with private own methods, so neither a
    // replaced iterator factory nor iterator.next can observe its promises.
    if (isArray(values)) {
      const iterator = arrayValues(values);
      values = { __proto__: null, [iteratorKey]: () => ({ __proto__: null,
        next: () => arrayNext(iterator) }) };
    }
    return nativeRace(HostPromise, values);
  }
  // The upstream Worker starts its Promise.race after invoking the program.
  // Its deadline must not use a resolve function replaced during that invocation.
  class HostPromise extends NativePromise {}
  Object.defineProperties(HostPromise, {
    resolve: { value: value => nativeResolve(HostPromise, value) },
    [Symbol.species]: { value: HostPromise }
  });
  Object.freeze(HostPromise.prototype);
  Object.freeze(HostPromise);
  Object.defineProperties(NativePromise, {
    race: { value: safeRace, writable: false, configurable: false },
    [Symbol.species]: { value: NativePromise, configurable: false }
  });
  // Async return values are adopted through their prototype's then method.
  // Guest callbacks must not change host completion.
  Object.freeze(NativePromise.prototype);
  const freeze = Object.freeze;
  const defineProperties = Object.defineProperties;
  // Protect the bridge codec and its object prototypes from guest hooks.
  freeze(JSON);
  freeze(Object.prototype);
  defineProperties(globalThis, {
    JSON: { value: JSON, writable: false, configurable: false },
    Promise: { value: NativePromise, writable: false, configurable: false }
  });
  const promiseThen = Function.prototype.call.bind(NativePromise.prototype.then);
  const promiseCatch = Function.prototype.call.bind(NativePromise.prototype.catch);
  const promiseFinally = Function.prototype.call.bind(NativePromise.prototype.finally);
  const push = Function.prototype.call.bind(Array.prototype.push);
  const pending = [];
  const provider = connecta;
  const emit = provider.emit;
  function trackEmission(task) {
    const entry = { handled: false, settled: promiseThen(task,
      () => ({ ok: true }), error => ({ ok: false, error })) };
    push(pending, entry);
    // Every derived promise owns propagated rejection; only an unhandled
    // leaf fails the run, so a later catch also handles its ancestors.
    return freeze({
      then(resolve, reject) {
        entry.handled = true;
        return trackEmission(promiseThen(task, resolve, reject));
      },
      catch(reject) {
        entry.handled = true;
        return trackEmission(promiseCatch(task, reject));
      },
      finally(callback) {
        entry.handled = true;
        return trackEmission(promiseFinally(task, callback));
      }
    });
  }
  const namespace = freeze({
    __proto__: null,
    search: provider.search,
    describe: provider.describe,
    call: provider.call,
    result: provider.result,
    skill: provider.skill,
    emit(block) { return trackEmission(emit(block)); }
  });
  globalThis.connecta = namespace;
  defineProperties(globalThis, {
    Error: { value: globalThis.Error, writable: false, configurable: false },
    __connecta_run: { configurable: true, value: () => {
      delete globalThis.__connecta_run;
      let used = false;
      return async (program) => {
        if (used) throw new Error("Guest runner initialization is single-use.");
        used = true;
        const result = await program(namespace);
        for (let i = 0; i < pending.length; i++) {
          const report = await pending[i].settled;
          if (!report.ok && !pending[i].handled) throw report.error;
        }
        return result;
      };
    }}
  });
})();`;
}

const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "ReferenceError", "RangeError", "EvalError", "URIError", "AggregateError"]);

/** Fixed repair guidance, used only in agent-facing results. */
export function programError(raw: { name?: unknown; message?: unknown; stack?: unknown; baseline?: unknown; line?: unknown }, code: string) {
  const message = typeof raw.message === "string" ? raw.message : "Program failed.";
  const name = typeof raw.name === "string" && ERROR_NAMES.has(raw.name) ? raw.name : "Error";
  const stack = typeof raw.stack === "string" ? raw.stack : "";
  // Compare QuickJS/V8 locations to the wrapper baseline after the source.
  const location = /:(\d+)(?::\d+)?\)?(?:\n|$)/.exec(stack);
  const baseline = typeof raw.baseline === "string" ? /:(\d+)(?::\d+)?\)?(?:\n|$)/.exec(raw.baseline) : null;
  // Workers publish only the user callback in this module, with one prefix line.
  // Its trusted wrapper and baseline live in a separate, private module scope.
  const workerLocation = /connecta-guest\.js:(\d+):\d+/.exec(stack);
  const line = typeof raw.line === "number" && Number.isFinite(raw.line) ? Math.max(1, raw.line)
    : workerLocation ? Math.max(1, Number(workerLocation[1]) - 1)
    : location && baseline ? Math.max(1, Number(location[1]) - Number(baseline[1]) + code.split("\n").length + 1) : null;
  let hint = "Use plain JavaScript in one async () => { ... } expression and the connecta global.";
  if (/require|\b[Ii]mports?\b|\bfs\b|filesystem|node:/.test(message) || name === "SyntaxError" && /\bimport\b/.test(code)) {
    hint = "Imports, require, and filesystem access are outside the guest API. Use connecta.call to access configured services.";
  } else if (["TypeError", "ReferenceError"].includes(name) && /(?:const|let|var|function|\()\s*connecta\b/.test(code)) {
    hint = "Do not shadow connecta. Use the host-provided connecta global.";
  } else if ((/callTool|mixpanel|\bskills\b|connecta\.(?:guide|skills)/.test(message) || ["TypeError", "ReferenceError"].includes(name) && /connecta\.(?:guide|skills)\b/.test(code))) {
    hint = "Use connecta.call(address, args), connecta.search, connecta.describe, connecta.result, and connecta.skill(name). Services are addressed by connector.tool, never guest globals.";
  }
  return { code: "program_error", message: `Program ${name}: ${message}`, retryable: false, details: { name, line, hint } };
}
