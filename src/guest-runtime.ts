import { GUEST_FUNCTIONS } from "./guest-functions.js";

/** Capture the single-use runner before evaluating the guest expression. */
export function wrapGuestProgram(code: string): string {
  return `async () => globalThis.__connecta_run()(async (connecta) => await (\n${code}\n)())`;
}

/** Separate user source from the trusted wrapper before publishing Worker modules. */
export function isolateGuestProgram(code: string): { program: string; wrapper: string } | undefined {
  const prefix = "async () => globalThis.__connecta_run()(";
  const callback = "async (connecta) => await (\n";
  const suffix = "\n)())";
  if (!code.startsWith(prefix + callback) || !code.endsWith(suffix)) return undefined;
  return {
    program: code.slice(prefix.length, -1),
    // Only this fixed wrapper enters the private runner module. Matching text
    // inside an arbitrary body/string is guest data, never a trusted wrapper.
    wrapper: `${prefix}__connecta_user_program)`,
  };
}

/**
 * Emissions are acknowledged before success, even when the guest omits await.
 * Capture intrinsics before user code can replace them.
 */
export function guestPrelude(): string {
  return `${guestInitializer()}(connecta);`;
}

/** Protect completion promises before any Worker or QuickJS guest runs. */
export function guestPromiseInitializer(): string {
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
})()`;
}

/**
 * The frozen namespace, joined from the registry. A `wrapped` or `emission`
 * function uses the initializer's local of the same name; an alias shares one
 * function object. Only guest source enters this string.
 */
const GUEST_NAMESPACE = (() => {
  const before: string[] = [];
  const entries = ["__proto__: null"];
  for (const fn of GUEST_FUNCTIONS) {
    if (fn.budget === "once") continue;
    if (fn.budget === "emission") {
      entries.push(`${fn.name}(block) {
      const ref = block && typeof block === "object" ? weakGet(nativeRefs, block) : undefined;
      return trackEmission(${fn.name}(ref || block));
    }`);
      continue;
    }
    const value = `hosted(${"wrapped" in fn ? fn.name : `provider.${fn.name}`})`;
    if (!("alias" in fn)) {
      entries.push(`${fn.name}: ${value}`);
      continue;
    }
    before.push(`  const ${fn.name} = ${value};\n`);
    entries.push(fn.name, `// Undeclared alias: ${fn.alias.note}\n    ${fn.alias.name}: ${fn.name}`);
  }
  return `${before.join("")}  const namespace = freeze({\n    ${entries.join(",\n    ")}\n  });`;
})();

/** Capture a private initializer before a Worker evaluates its guest module. */
export function guestInitializer(): string {
  return `(() => {
  ${guestPromiseInitializer()};
  const NativePromise = Promise;
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
  const apply = Function.prototype.call.bind(Function.prototype.apply);
  const NativeError = Error;
  const NativeWeakMap = WeakMap;
  const isArray = Array.isArray;
  const weakGet = Function.prototype.call.bind(WeakMap.prototype.get);
  const weakSet = Function.prototype.call.bind(WeakMap.prototype.set);
  const getPrototypeOf = Object.getPrototypeOf;
  const setPrototypeOf = Object.setPrototypeOf;
  const defineProperty = Object.defineProperty;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const bind = Function.prototype.call.bind(Function.prototype.bind);
  const NativeString = String;
  const ObjectPrototype = Object.prototype;
  const concatSpreadable = Symbol.isConcatSpreadable;
  const jsonParse = JSON.parse;
  const jsonStringify = JSON.stringify;
  const MUTATORS = freeze(["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);
  return freeze((provider) => {
  const pending = [];
  const emit = provider.emit;
  const hostCall = provider.call;
  const hostResult = provider.result;
  const nativeRefs = new NativeWeakMap();
  async function inline(value) {
    if (!value || typeof value.transfer !== "string" || !value.handle) return value;
    // A completed downstream call stays successful if transfer storage fails.
    // Preserve its handle so the caller can page later, without repeating a write.
    try {
      let text = "", page;
      do {
        page = await hostResult(value.transfer);
        text += page.text;
      } while (page.hasMore);
      return { data: value.handle.valueFormat === "json" ? JSON.parse(text) : text,
        format: value.handle.valueFormat };
    } catch { return value.handle; }
  }
  // Other properties read from data through the prototype chain, so the
  // envelope stays its own object: keys, JSON, spread and emit refs are unchanged.
  function readThrough(value) {
    if (!value || value.format === "paged" || !hasOwn(value, "data")) return value;
    const data = value.data;
    const hidden = (key, field) => defineProperty(value, key, { __proto__: null, value: field, writable: true, configurable: true });
    // These two keep their meaning even when data has a field of the same name.
    if (!hasOwn(value, "content")) hidden("content", undefined);
    if (!hasOwn(value, "contentResult")) hidden("contentResult", undefined);
    if (typeof data === "string") {
      setPrototypeOf(value, new NativeString(data));
      // String methods stringify their receiver; the wrapper's refuse this one.
      hidden("toString", () => data);
      hidden("valueOf", () => data);
    } else if (isArray(data)) {
      setPrototypeOf(value, data);
      hidden(concatSpreadable, true);
      // Generic mutators would write indexes onto the envelope, not the array.
      for (let i = 0; i < MUTATORS.length; i++) hidden(MUTATORS[i], bind(data[MUTATORS[i]], data));
    } else if (data && typeof data === "object") {
      // A value outside JSON keeps its own receiver checks (X7).
      const proto = getPrototypeOf(data);
      if (proto === ObjectPrototype || proto === null) setPrototypeOf(value, data);
    }
    return value;
  }
  async function call() {
    return readThrough(await apply(rawCall, undefined, arguments));
  }
  async function rawCall() {
    const reply = await apply(hostCall, undefined, arguments);
    if (!reply || !reply.native) return inline(reply);
    const native = await inline(reply.native.value);
    if (native.format === "paged" && !reply.value) return native;
    const value = reply.value ? await inline(reply.value) : {
      data: reply.native.dataKey ? native.data[reply.native.dataKey] : native.data, format: "json"
    };
    if (value.format === "paged") return value;
    if (native.format === "paged") {
      value.contentResult = native;
      return value;
    }
    if (native.format === "json" && native.data && isArray(native.data.content)) {
      const content = native.data.content;
      // Only host-issued refs cross back. Binary data never needs a second
      // guest-to-host transfer, and guest edits cannot mint native pointers.
      for (let i = 0; i < content.length; i++) {
        weakSet(nativeRefs, content[i], { ref: reply.native.ref, index: i });
      }
      value.content = content;
      weakSet(nativeRefs, value, { ref: reply.native.ref });
    }
    return value;
  }
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
  // Result fields read off an unawaited host call flag the run, still undefined.
  let unawaited = false;
  const fields = {};
  for (const key of ["data", "format", "content", "tools", "catalogErrors", "total", "text", "resultId", "hasMore", "nextOffset"])
    fields[key] = { get() { unawaited = true; } };
  const hosted = (fn) => function () {
    const promise = apply(fn, undefined, arguments);
    if (promise && typeof promise === "object") defineProperties(promise, fields);
    return promise;
  };
${GUEST_NAMESPACE}
  globalThis.connecta = namespace;
  defineProperties(globalThis, {
    Error: { value: NativeError, writable: false, configurable: false },
    __connecta_run: { configurable: true, value: () => {
      delete globalThis.__connecta_run;
      let used = false;
      return async (program) => {
        if (used) throw new NativeError("Guest runner initialization is single-use.");
        used = true;
        let result;
        try {
          result = await program(namespace);
        } catch (error) {
          if (unawaited) try { await provider.unawaited(); } catch {}
          throw error;
        }
        let settled = 0;
        const acknowledged = async () => {
          for (; settled < pending.length; settled++) {
            const report = await pending[settled].settled;
            if (!report.ok && !pending[settled].handled) throw report.error;
          }
        };
        await acknowledged();
        // Workers RPC refuses a read-through envelope's prototype. A value JSON
        // cannot carry keeps its existing refusal (X9). A getter or toJSON may
        // emit during this, so acknowledge again.
        if (result && typeof result === "object") {
          try {
            const text = jsonStringify(result);
            if (text !== undefined) result = jsonParse(text);
          } catch {}
          await acknowledged();
        }
        return result;
      };
    }}
  });
  });
})()`;
}

const ERROR_NAMES = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "ReferenceError",
  "RangeError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** Fixed repair guidance, used only in agent-facing results. */
export function programError(
  raw: { name?: unknown; message?: unknown; stack?: unknown; baseline?: unknown; line?: unknown; unawaited?: unknown },
  code: string,
) {
  const text = typeof raw.message === "string" ? raw.message : "Program failed.";
  // Executors may report "TypeError: …" as the message itself; name it once.
  const prefix = /^([A-Za-z]*Error): /.exec(text)?.[1];
  const name =
    typeof raw.name === "string" && ERROR_NAMES.has(raw.name)
      ? raw.name
      : prefix && ERROR_NAMES.has(prefix)
        ? prefix
        : "Error";
  const message = prefix === name ? text.slice(name.length + 2) : text;
  const stack = typeof raw.stack === "string" ? raw.stack : "";
  // Compare QuickJS/V8 locations to the wrapper baseline after the source.
  const location = /:(\d+)(?::\d+)?\)?(?:\n|$)/.exec(stack);
  const baseline = typeof raw.baseline === "string" ? /:(\d+)(?::\d+)?\)?(?:\n|$)/.exec(raw.baseline) : null;
  // Workers publish only the user callback in this module, with one prefix line.
  // Its trusted wrapper and baseline live in a separate, private module scope.
  const workerLocation = /connecta-guest\.js:(\d+):\d+/.exec(stack);
  const line =
    typeof raw.line === "number" && Number.isFinite(raw.line)
      ? Math.max(1, raw.line)
      : workerLocation
        ? Math.max(1, Number(workerLocation[1]) - 1)
        : location && baseline
          ? Math.max(1, Number(location[1]) - Number(baseline[1]) + code.split("\n").length + 1)
          : null;
  let hint = "Use plain JavaScript in one async () => { ... } expression and the connecta global.";
  if (raw.unawaited === true) {
    hint = "connecta.* returns a Promise; await it: (await connecta.call(address, args)).data.";
  } else if (
    /\brequire\b|\b[Ii]mports?\b|\bfs\b|filesystem|node:/.test(message) ||
    (name === "SyntaxError" && /\bimport\b/.test(code))
  ) {
    hint =
      "Imports, require, and filesystem access are outside the guest API. Use connecta.call to access configured services.";
  } else if (
    ["TypeError", "ReferenceError"].includes(name) &&
    /(?:const|let|var|function|\()\s*connecta\b/.test(code)
  ) {
    hint = "Do not shadow connecta. Use the host-provided connecta global.";
  } else if (
    /callTool|\bskills\b|connecta\.guide/.test(message) ||
    (["TypeError", "ReferenceError"].includes(name) && /connecta\.guide\b/.test(code))
  ) {
    hint =
      'Use connecta.call(address, args), connecta.search, connecta.describe, connecta.result, and connecta.skill("usage"). Services are addressed by connector.tool, never guest globals.';
  }
  return {
    code: "program_error",
    message: `Program ${name}: ${message}`,
    retryable: false,
    details: { name, line, hint },
  };
}
