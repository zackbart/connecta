/** Host-authored protocol shared by every sandbox. No guest prose authenticates a failure. */
export const GUEST_FAILURE_FRAME = "\u001econnecta-error:";

export function guestSecret(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function guestRunnerName(secret: string): string {
  return `__connecta_run_${secret}`;
}

/** Capture the runner before user code runs, then remove its global entry. */
export function wrapGuestProgram(code: string, secret: string): string {
  const key = JSON.stringify(guestRunnerName(secret));
  // Resolve the factory before evaluating the guest expression. It deletes its
  // global entry and returns the runner directly to the engine's operand stack:
  // no host binding is in the guest closure's lexical scope.
  return `async () => globalThis[${key}]()(async (connecta) => await (\n${code}\n)(), new Error().stack)`;
}

/** Separate user source from the trusted wrapper before publishing Worker modules. */
export function isolateGuestProgram(code: string): { program: string; wrapper: string } | undefined {
  const start = code.indexOf("async (connecta) => await (\n");
  const end = code.lastIndexOf("\n)(), new Error().stack)");
  if (start < 0 || end < start) return undefined;
  return {
    program: code.slice(start, end + "\n)()".length),
    wrapper: code.slice(0, start) + "__connecta_user_program" + code.slice(end + "\n)()".length),
  };
}

/**
 * The frame is retained by Error identity, not by its message or public fields.
 * Emissions are acknowledged before success, even when the guest omits await.
 * Capture intrinsics before user code can replace them.
 */
export function guestPrelude(secret: string): string {
  return `((failurePrefix, runnerKey, token) => {
  const NativeError = globalThis.Error;
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
  // Guest callbacks must never observe the runner's private return frame.
  Object.freeze(NativePromise.prototype);
  const startsWith = Function.prototype.call.bind(String.prototype.startsWith);
  const slice = Function.prototype.call.bind(String.prototype.slice);
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const defineProperties = Object.defineProperties;
  const construct = Reflect.construct;
  // Both bridges decode the private host frame through JSON. Protect that
  // codec and its object prototypes from guest hooks before a frame can arrive.
  freeze(JSON);
  freeze(Object.prototype);
  defineProperties(globalThis, {
    JSON: { value: JSON, writable: false, configurable: false },
    Promise: { value: NativePromise, writable: false, configurable: false }
  });
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  const promiseThen = Function.prototype.call.bind(NativePromise.prototype.then);
  const promiseCatch = Function.prototype.call.bind(NativePromise.prototype.catch);
  const promiseFinally = Function.prototype.call.bind(NativePromise.prototype.finally);
  const push = Function.prototype.call.bind(Array.prototype.push);
  const split = Function.prototype.call.bind(String.prototype.split);
  const filter = Function.prototype.call.bind(Array.prototype.filter);
  const join = Function.prototype.call.bind(Array.prototype.join);
  const includes = Function.prototype.call.bind(String.prototype.includes);
  const frames = new WeakMap();
  const pending = [];
  const provider = connecta;
  const emit = provider.emit;
  function trackEmission(task) {
    const entry = { handled: false, settled: promiseThen(task,
      () => ({ ok: true }), error => ({ ok: false, error })) };
    push(pending, entry);
    return freeze({
      then(resolve, reject) {
        if (typeof reject === "function") entry.handled = true;
        return trackEmission(promiseThen(task, resolve, reject));
      },
      catch(reject) {
        if (typeof reject === "function") entry.handled = true;
        return trackEmission(promiseCatch(task, reject));
      },
      finally(callback) { return trackEmission(promiseFinally(task, callback)); }
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
  function ConnectaError(message, options) {
    let details, id;
    if (typeof message === "string" && startsWith(message, failurePrefix)) {
      try { const frame = parse(slice(message, failurePrefix.length)); details = frame.details; id = frame.id; }
      catch { message = "Invalid host failure frame."; }
    }
    const error = construct(NativeError,
      options === undefined ? [details ? details.message : message] : [details ? details.message : message, options],
      new.target || NativeError);
    // Constructor wrappers add a frame in both engines; remove it for source locations.
    if (typeof error.stack === "string") error.stack = join(filter(split(error.stack, "\\n"), line => !includes(line, "ConnectaError")), "\\n");
    if (details) {
      weakSet(frames, error, id);
      freeze(details);
      defineProperties(error, {
        code: { value: details.code, enumerable: true },
        retryable: { value: details.retryable, enumerable: true },
        details: { value: details, enumerable: true }
      });
    }
    return error;
  }
  ConnectaError.prototype = NativeError.prototype;
  Object.setPrototypeOf(ConnectaError, NativeError);
  Object.defineProperty(globalThis, "Error", { value: ConnectaError, writable: false, configurable: false });
  Object.defineProperty(globalThis, runnerKey, { configurable: true, value: () => {
    delete globalThis[runnerKey];
    return async (program, baseline) => {
      try {
        const result = await program(namespace);
        // Await native promises directly: Promise.all consults mutable Promise.resolve.
        // The list also retains derived branches whose callbacks may reject.
        for (let i = 0; i < pending.length; i++) {
          const report = await pending[i].settled;
          if (!report.ok && !pending[i].handled) throw report.error;
        }
        return result;
      } catch (error) {
        const hostId = weakGet(frames, error);
        if (hostId) return freeze({ __connectaFailure: freeze({ token, hostId }) });
        let name = "Error", message = "Program threw a value.", stack = "";
        try {
          if (typeof error === "string") message = error;
          else if (error) {
            if (typeof error.name === "string") name = slice(error.name, 0, 64);
            if (typeof error.message === "string") message = error.message;
            if (typeof error.stack === "string") stack = slice(error.stack, 0, 1000);
          }
        } catch {}
        // Three 1,000-character fields fit the transport cap even when every
        // character needs a six-character JSON escape. Failures never truncate
        // into an ordinary successful program result.
        return freeze({ __connectaFailure: freeze({ token, program: freeze({ name, message: slice(message, 0, 1000), stack,
          baseline: typeof baseline === "string" ? slice(baseline, 0, 1000) : "" }) }) });
      }
    };
  }});
})(${JSON.stringify(`${GUEST_FAILURE_FRAME}${secret}:`)}, ${JSON.stringify(guestRunnerName(secret))}, ${JSON.stringify(secret)});`;
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
  if (/require|\bimport\b|\bfs\b|filesystem|node:/.test(message) || name === "SyntaxError" && /\bimport\b/.test(code)) {
    hint = "Imports, require, and filesystem access are outside the guest API. Use connecta.call to access configured services.";
  } else if (["TypeError", "ReferenceError"].includes(name) && /(?:const|let|var|function|\()\s*connecta\b/.test(code)) {
    hint = "Do not shadow connecta. Use the host-provided connecta global.";
  } else if ((/callTool|mixpanel|\bskills\b|connecta\.(?:guide|skills)/.test(message) || ["TypeError", "ReferenceError"].includes(name) && /connecta\.(?:guide|skills)\b/.test(code))) {
    hint = "Use connecta.call(address, args), connecta.search, connecta.describe, connecta.result, and connecta.skill(name). Services are addressed by connector.tool, never guest globals.";
  }
  return { code: "program_error", message: `Program ${name}: ${message}`, retryable: false, details: { name, line, hint } };
}
