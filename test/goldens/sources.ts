// Installed by Vitest setup BEFORE any provider, connector, or Effect import.
// Dispatchers keep their identity across captures, including prebound methods.
// Native functions stay in this module's closure. Unscoped runner calls
// delegate unchanged; closed capture continuations reject before dispatch.
import { AsyncLocalStorage } from "node:async_hooks";

export const GOLDEN_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
type Callback = (...args: unknown[]) => void;
type Method = (this: unknown, ...args: unknown[]) => unknown;
interface Timer {
  at: number;
  callback: () => void;
  interval?: number;
  deadline?: boolean;
}
export interface SourceState {
  now: number;
  loading: boolean;
  inFlight: number;
  /** Only captured Web Crypto implementations, never producer-fed body reads. */
  nativePending: Set<Promise<unknown>>;
  microtasks: number;
  events: number;
  violation?: Error;
  timers: Map<number, Timer>;
  assertCurrent(): void;
  waitForNative(): Promise<void>;
  tick(ms: number): void;
  next(): number | undefined;
  stop(restarting?: boolean): void;
}
interface Sources {
  capture<T>(work: () => Promise<T>): Promise<T>;
  start(): SourceState;
  turn(): Promise<void>;
  importSource(source: string, duringLoad: boolean): void;
}
const KEY = Symbol.for("connecta.golden.sources");
const globals = globalThis as unknown as Record<PropertyKey, unknown>;

export function installSources(): Sources {
  if (globals[KEY]) return globals[KEY] as Sources;
  let active: SourceState | undefined;
  interface Epoch {
    open: boolean;
    pending: Set<Promise<unknown>>;
  }
  const context = new AsyncLocalStorage<Epoch>();
  const closeEpoch = (epoch: Epoch) => {
    epoch.open = false;
    // Consume abandoned body-read rejections without waiting or hiding errors
    // in an open capture. Native implementations may resume after teardown.
    for (const pending of epoch.pending) void pending.catch(() => {});
    epoch.pending.clear();
  };
  let activeEpoch: Epoch | undefined;
  const assertEpoch = (expected = context.getStore()) => {
    const epoch = context.getStore();
    if ((epoch && !epoch.open) || epoch !== expected) throw new Error("Golden capture epoch is closed");
  };
  const NativeDate = Date;
  const nativeDateNow = Date.now.bind(Date);
  const nativeTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeImmediate = globalThis.setImmediate?.bind(globalThis);
  const turn = () =>
    new Promise<void>((resolve) => (nativeImmediate ? nativeImmediate(resolve) : nativeTimeout(resolve, 0)));
  let id = 0;
  const unsupported = (source: string): never => {
    assertEpoch();
    const error = new Error(
      `Unsupported asynchronous source: ${source}; register and count it in test/goldens/sources.ts before capturing it`,
    );
    if (active) active.violation = error;
    throw error;
  };
  const replace = (owner: object, name: PropertyKey, value: unknown) => {
    Object.defineProperty(owner, name, { configurable: true, writable: true, value });
  };
  const dispatch = (owner: object, name: string, during: Method) => {
    const native = (owner as Record<string, unknown>)[name];
    if (typeof native !== "function") return;
    let defining = owner;
    while (!Object.hasOwn(defining, name) && Object.getPrototypeOf(defining))
      defining = Object.getPrototypeOf(defining);
    replace(defining, name, function (this: unknown, ...args: unknown[]) {
      assertEpoch();
      return (active ? during : (native as Method)).apply(this, args);
    });
  };
  const schedule = (callback: unknown, ms: unknown, args: unknown[], interval?: number) => {
    if (typeof callback !== "function") return unsupported("string timer callback");
    const delay = ms === undefined ? 0 : Number(ms);
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 2_147_483_647)
      return unsupported("timer delay outside finite nonnegative integer milliseconds");
    const state = active!;
    const key = ++id;
    state.timers.set(key, {
      at: state.now + delay,
      callback: () => (callback as Callback)(...args),
      ...(interval === undefined ? {} : { interval }),
    });
    state.events++;
    // Node timer consumers (Effect included) may unref a timer.
    return {
      [Symbol.toPrimitive]: () => key,
      ref() {
        return this;
      },
      unref() {
        return this;
      },
      hasRef: () => true,
    };
  };
  dispatch(globalThis, "setTimeout", (_callback, _ms, ..._args) => schedule(_callback, _ms, _args));
  dispatch(globalThis, "setInterval", (_callback, _ms, ..._args) =>
    schedule(_callback, _ms, _args, Math.max(1, Number(_ms) || 0)),
  );
  dispatch(globalThis, "setImmediate", (_callback, ..._args) => schedule(_callback, 0, _args));
  for (const name of ["clearTimeout", "clearInterval", "clearImmediate"]) {
    dispatch(globalThis, name, (handle) => {
      if (active!.timers.delete(Number(handle))) active!.events++;
    });
  }
  const nativeMicrotask = queueMicrotask.bind(globalThis);
  dispatch(globalThis, "queueMicrotask", (callback) => {
    const state = active!;
    state.microtasks++;
    state.events++;
    nativeMicrotask(() => {
      try {
        assertEpoch();
        (callback as () => void)();
      } catch (error) {
        state.violation = error instanceof Error ? error : new Error(String(error));
      } finally {
        state.microtasks--;
        state.events++;
      }
    });
  });
  // A Proxy preserves Date() as well as new Date(), UTC, parse and instanceof.
  const dateNow = () => (active ? active.now : nativeDateNow());
  const ControlledDate = new Proxy(NativeDate, {
    apply(target, self, args) {
      return active ? new NativeDate(active.now).toString() : Reflect.apply(target, self, args);
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, active && args.length === 0 ? [active.now] : args, newTarget);
    },
    get(target, name, receiver) {
      return name === "now" ? dateNow : Reflect.get(target, name, receiver);
    },
    getOwnPropertyDescriptor(target, name) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, name);
      return name === "now" ? { ...descriptor, value: dateNow } : descriptor;
    },
  });
  replace(globalThis, "Date", ControlledDate);
  replace(NativeDate.prototype, "constructor", ControlledDate);
  dispatch(performance, "now", () => active!.now - GOLDEN_NOW);
  if ("timeOrigin" in performance) {
    let owner: object = performance;
    while (!Object.hasOwn(owner, "timeOrigin") && Object.getPrototypeOf(owner)) owner = Object.getPrototypeOf(owner);
    const descriptor = Object.getOwnPropertyDescriptor(owner, "timeOrigin")!;
    Object.defineProperty(owner, "timeOrigin", {
      configurable: true,
      get() {
        return active ? GOLDEN_NOW : descriptor.get ? descriptor.get.call(this) : descriptor.value;
      },
    });
  }
  // Formatting an omitted date otherwise asks the host clock internally.
  const dateFormat = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!;
  Object.defineProperty(Intl.DateTimeFormat.prototype, "format", {
    configurable: true,
    get() {
      const format = dateFormat.get!.call(this) as (date?: number | Date) => string;
      return (date?: number | Date) => format(active && date === undefined ? active.now : date);
    },
  });
  const formatParts = Intl.DateTimeFormat.prototype.formatToParts;
  dispatch(Intl.DateTimeFormat.prototype, "formatToParts", function (this: unknown, date) {
    return formatParts.call(this as Intl.DateTimeFormat, date === undefined ? active!.now : (date as number));
  });
  for (const name of [
    "mark",
    "measure",
    "getEntries",
    "getEntriesByName",
    "getEntriesByType",
    "toJSON",
    "eventLoopUtilization",
    "timerify",
  ]) {
    dispatch(performance, name, () => unsupported(`performance.${name}`));
  }
  const proc = (globalThis as { process?: { hrtime?: typeof process.hrtime; nextTick?: typeof process.nextTick } })
    .process;
  if (proc?.hrtime) {
    const native = proc.hrtime.bind(proc);
    const bigint = proc.hrtime.bigint.bind(proc.hrtime);
    const controlled = (previous?: [number, number]): [number, number] => {
      if (!active) return native(previous);
      const nanos = BigInt(active.now - GOLDEN_NOW) * 1_000_000n;
      const diff = nanos - (previous ? BigInt(previous[0]) * 1_000_000_000n + BigInt(previous[1]) : 0n);
      return [Number(diff / 1_000_000_000n), Number(diff % 1_000_000_000n)];
    };
    controlled.bigint = () => (active ? BigInt(active.now - GOLDEN_NOW) * 1_000_000n : bigint());
    replace(proc, "hrtime", controlled);
  }
  // nextTick can be captured by provider code just like setImmediate. It has
  // no portable Workers equivalent; provider use is deliberately unsupported.
  if (proc?.nextTick) dispatch(proc, "nextTick", () => unsupported("process.nextTick"));
  if (proc)
    for (const name of ["uptime", "binding", "_linkedBinding", "dlopen"])
      dispatch(proc, name, () => unsupported(`process.${name}`));
  // Effect asks for AsyncResource while loading on workerd. It propagates
  // synchronous context only. Expose that constructor, never the host-module
  // loader or the rest of async_hooks (which could observe runner activity).
  const builtins = (proc as { getBuiltinModule?: (name: string) => { AsyncResource?: unknown } } | undefined)
    ?.getBuiltinModule;
  if (proc && builtins) {
    const context = builtins.call(proc, "node:async_hooks")?.AsyncResource;
    dispatch(proc, "getBuiltinModule", (name) => {
      if (name === "node:async_hooks" || name === "async_hooks") return { AsyncResource: context };
      return unsupported("process.getBuiltinModule");
    });
  }
  if (typeof Atomics !== "undefined") dispatch(Atomics, "waitAsync", () => unsupported("Atomics.waitAsync"));
  let uuid = 0,
    byte = 0,
    seed = 0;
  dispatch(crypto, "randomUUID", () => `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, "0")}`);
  dispatch(crypto, "getRandomValues", (array) => {
    const view = array as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    for (let index = 0; index < bytes.length; index++) bytes[index] = byte++ & 0xff;
    return array;
  });
  dispatch(Math, "random", () => (seed = (seed * 9301 + 49297) % 233280) / 233280);
  const counted = (owner: object, names: string[], nativeOperation = false) => {
    for (const name of names) {
      const native = (owner as Record<string, Method>)[name];
      if (typeof native !== "function") continue;
      dispatch(owner, name, function (this: unknown, ...args) {
        const state = active!;
        const epoch = activeEpoch!;
        state.inFlight++;
        state.events++;
        try {
          const pending = Promise.resolve(native.apply(this, args)).finally(() => {
            state.inFlight--;
            state.events++;
            state.nativePending.delete(pending);
            epoch.pending.delete(pending);
          });
          epoch.pending.add(pending);
          if (nativeOperation) state.nativePending.add(pending);
          return pending;
        } catch (error) {
          state.inFlight--;
          state.events++;
          throw error;
        }
      });
    }
  };
  counted(
    crypto.subtle,
    [
      "decrypt",
      "deriveBits",
      "deriveKey",
      "digest",
      "encrypt",
      "exportKey",
      "generateKey",
      "importKey",
      "sign",
      "unwrapKey",
      "verify",
      "wrapKey",
    ],
    true,
  );
  const body = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"];
  for (const owner of [Request.prototype, Response.prototype, Blob.prototype]) counted(owner, body);
  counted(ReadableStreamDefaultReader.prototype, ["read", "cancel"]);
  counted(ReadableStream.prototype, ["cancel", "pipeTo"]);
  // Native compression and host I/O have hidden completion channels. Reject
  // their constructors, including saved constructors; a caught error poisons
  // the capture as well. Synchronous Web stream transforms remain supported.
  for (const name of [
    "CompressionStream",
    "DecompressionStream",
    "WebSocket",
    "Worker",
    "XMLHttpRequest",
    "EventSource",
    "MessageChannel",
    "BroadcastChannel",
  ]) {
    const native = globals[name];
    if (typeof native !== "function") continue;
    const guarded = new Proxy(native, {
      construct(target, args, newTarget) {
        assertEpoch();
        return active ? unsupported(name) : Reflect.construct(target, args, newTarget);
      },
      apply(target, self, args) {
        assertEpoch();
        return active ? unsupported(name) : Reflect.apply(target, self, args);
      },
    });
    replace(globalThis, name, guarded);
    if (native.prototype) replace(native.prototype, "constructor", guarded);
  }
  const temporal = (globals.Temporal as { Now?: object } | undefined)?.Now;
  if (temporal)
    for (const name of [
      "instant",
      "plainDateISO",
      "plainDateTimeISO",
      "plainTimeISO",
      "timeZoneId",
      "zonedDateTimeISO",
    ])
      dispatch(temporal, name, () => unsupported(`Temporal.Now.${name}`));
  const scheduler = globals.scheduler;
  if (scheduler)
    for (const name of ["wait", "yield", "postTask"])
      dispatch(scheduler as object, name, () => unsupported(`scheduler.${name}`));
  const abortTimeout = AbortSignal.timeout;
  replace(AbortSignal, "timeout", (ms: number) => {
    assertEpoch();
    if (!active) return abortTimeout.call(AbortSignal, ms);
    const controller = new AbortController();
    const handle = schedule(
      () => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
      ms,
      [],
    );
    active.timers.get(Number(handle))!.deadline = true;
    return controller.signal;
  });
  // A saved global fetch must never reach the network during a capture.
  dispatch(globalThis, "fetch", () => unsupported("prebound fetch; use the capture's fake network"));
  const sources: Sources = {
    async capture(work) {
      assertEpoch();
      const epoch: Epoch = { open: true, pending: new Set() };
      return context.run(epoch, async () => {
        try {
          return await work();
        } finally {
          closeEpoch(epoch);
        }
      });
    },
    turn,
    importSource(source, duringLoad) {
      assertEpoch();
      if (active && (!duringLoad || !active.loading)) unsupported(source);
    },
    start() {
      assertEpoch();
      if (active) throw new Error("Overlapping golden captures are unsupported");
      const epoch = context.getStore();
      if (!epoch) throw new Error("Golden capture epoch is missing");
      uuid = byte = seed = 0;
      const state: SourceState = {
        now: GOLDEN_NOW,
        loading: true,
        inFlight: 0,
        nativePending: new Set(),
        microtasks: 0,
        events: 0,
        timers: new Map(),
        assertCurrent() {
          assertEpoch(epoch);
          if (active !== state) throw new Error("Golden capture epoch is closed");
        },
        async waitForNative() {
          // Snapshot only operations that already entered the captured native
          // implementation. A consumer may start more work as these settle;
          // that work gets a fresh bounded polling window, not an open-ended join.
          await Promise.allSettled(state.nativePending);
        },
        tick(ms) {
          state.now += ms;
          let iterations = 0;
          for (;;) {
            const next = [...state.timers]
              .filter(([, timer]) => timer.at <= state.now)
              .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!next) return;
            if (++iterations > 10_000) return unsupported("unbounded due-timer loop");
            const [key, timer] = next;
            if (timer.interval) timer.at += timer.interval;
            else state.timers.delete(key);
            state.events++;
            timer.callback();
          }
        },
        next() {
          return state.timers.size
            ? Math.min(...[...state.timers.values()].map((timer) => timer.at)) - state.now
            : undefined;
        },
        stop(restarting = false) {
          state.timers.clear();
          if (active === state) {
            if (!restarting) closeEpoch(epoch);
            active = undefined;
            activeEpoch = undefined;
          }
        },
      };
      active = state;
      activeEpoch = epoch;
      return state;
    },
  };
  globals[KEY] = sources;
  return sources;
}

export function goldenSources(): Sources {
  const sources = globals[KEY] as Sources | undefined;
  if (!sources)
    throw new Error("Golden source controls must be installed by test/goldens/setup.ts before test imports");
  return sources;
}
