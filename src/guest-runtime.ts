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
  async function call() {
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
  const namespace = freeze({
    __proto__: null,
    search: provider.search,
    describe: provider.describe,
    call,
    read: provider.read,
    result: provider.result,
    skill: provider.skill,
    // Undeclared alias: models write connecta.skills, the top-level tool's name.
    skills: provider.skill,
    emit(block) {
      const ref = block && typeof block === "object" ? weakGet(nativeRefs, block) : undefined;
      return trackEmission(emit(ref || block));
    }
  });
  globalThis.connecta = namespace;
  defineProperties(globalThis, {
    Error: { value: NativeError, writable: false, configurable: false },
    __connecta_run: { configurable: true, value: () => {
      delete globalThis.__connecta_run;
      let used = false;
      return async (program) => {
        if (used) throw new NativeError("Guest runner initialization is single-use.");
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

const HOST_CALL_RE = /\bconnecta\s*\.\s*(?:search|describe|call|read|result|skills?)\s*\(/g;
/** A member read that is not a Promise method: `.data`, `?.tools`, `[0]`. */
const MEMBER_READ = String.raw`\s*(?:(?:\?\.|\.)\s*(?!(?:then|catch|finally)\b)[A-Za-z_$]|(?:\?\.)?\s*\[)`;
const MEMBER_READ_RE = new RegExp(`^${MEMBER_READ}`);
/** `name = ` or a destructuring `} = ` directly before the call, so no await. */
const UNAWAITED_BINDING_RE = /(?:([A-Za-z_$][\w$]*)|[}\]])\s*=\s*$/;

/** The index just past the parenthesis closing the one opened before `start`, skipping string literals. */
function closingParen(code: string, start: number): number | undefined {
  let depth = 1;
  for (let index = start; index < code.length; index++) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      for (index++; index < code.length && code[index] !== char; index++) if (code[index] === "\\") index++;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return undefined;
}

/**
 * Whether the source reads a member of a host call's Promise: a field read
 * straight off `connecta.call(...)`, or a variable or destructuring bound to
 * one without `await`. Only the verdict leaves this function, never source.
 * The first 64 call sites bound the scan of a pathological 64 KiB program.
 */
function unawaitedHostResult(code: string): boolean {
  let sites = 0;
  for (const match of code.matchAll(HOST_CALL_RE)) {
    if (++sites > 64) break;
    const end = closingParen(code, match.index + match[0].length);
    if (end === undefined) continue;
    const rest = code.slice(end);
    if (MEMBER_READ_RE.test(rest)) return true;
    const binding = UNAWAITED_BINDING_RE.exec(code.slice(Math.max(0, match.index - 128), match.index));
    if (!binding) continue;
    const variable = binding[1];
    if (variable === undefined) return true;
    if (new RegExp(`(?<![\\w$.])${variable.replaceAll("$", "\\$")}${MEMBER_READ}`).test(rest)) return true;
  }
  return false;
}

/** Fixed repair guidance, used only in agent-facing results. */
export function programError(
  raw: { name?: unknown; message?: unknown; stack?: unknown; baseline?: unknown; line?: unknown },
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
  if (
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
  } else if (name === "TypeError" && unawaitedHostResult(code)) {
    hint = "connecta.* returns a Promise; await it: (await connecta.call(address, args)).data.";
  }
  return {
    code: "program_error",
    message: `Program ${name}: ${message}`,
    retryable: false,
    details: { name, line, hint },
  };
}
