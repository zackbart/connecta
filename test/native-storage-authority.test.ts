import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { authStorage } from "../src/auth/native.js";
import { api } from "../src/connectors/api.js";
import {
  getNativeActivity,
  getNativeStorage,
  registerNativeActivity,
  registerNativeStorage,
  type NativeStorage,
} from "../src/runtime/native-storage.js";
import { runEdge } from "../src/runtime/run.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { KVStorage } from "../src/types.js";
import type { ActivityStore, ToolCallActivityEvent } from "../src/activity.js";
import { deferred } from "./fixtures/misc.js";
import { makeRegistry } from "./helpers.js";

const leaf = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });
function fixture(inherited = false) {
  const backing = memoryStorage(),
    shells = vi.fn(),
    nativeCalls = vi.fn();
  const native: NativeStorage = {
    get: (key) =>
      Effect.andThen(
        Effect.sync(() => nativeCalls("get", key)),
        leaf(() => backing.get(key)),
      ),
    set: (...args) =>
      Effect.andThen(
        Effect.sync(() => nativeCalls("set", args[0])),
        leaf(() => backing.set(...args)),
      ),
    delete: (key) => leaf(() => backing.delete(key)),
    list: (prefix) => leaf(() => backing.list(prefix)),
    compareAndSet: (...args) =>
      Effect.andThen(
        Effect.sync(() => nativeCalls("compareAndSet", args[0])),
        leaf(() => backing.compareAndSet(...args)),
      ),
  };
  class Base implements KVStorage {
    readonly capabilities = backing.capabilities;
    get(key: string) {
      shells("get");
      return runEdge(native.get(key));
    }
    set(...args: Parameters<KVStorage["set"]>) {
      shells("set");
      return runEdge(native.set(...args));
    }
    delete(key: string) {
      return runEdge(native.delete(key));
    }
    list(prefix: string) {
      return runEdge(native.list(prefix));
    }
    compareAndSet(...args: Parameters<KVStorage["compareAndSet"]>) {
      shells("compareAndSet");
      return runEdge(native.compareAndSet(...args));
    }
  }
  class Child extends Base {}
  const store = inherited
    ? new Child()
    : (Object.assign({ capabilities: backing.capabilities }, Base.prototype) as KVStorage);
  if (!inherited)
    for (const key of ["get", "set", "delete", "list", "compareAndSet"] as const)
      Object.defineProperty(store, key, { value: Base.prototype[key], writable: true, configurable: true });
  registerNativeStorage(store, native);
  return { store, nativeCalls, shells, prototype: Base.prototype };
}
function namespace(store: KVStorage): KVStorage {
  const connector = api("notes", { tools: [], authScope: "personal" });
  return makeRegistry([connector], { storage: store })
    .scoped({ connectorIds: ["notes"], principalKey: "alice" })
    .contextFor("notes", "https://connecta.test").storage;
}
const methods = ["get", "set", "compareAndSet"] as const;
const args = { get: ["key"], set: ["key", "value"], compareAndSet: ["key", null, "next"] } as const;
function invoke(store: KVStorage, key: (typeof methods)[number]) {
  return authStorage(store, key, [...args[key]]);
}

describe("current storage authority", () => {
  it.each(["direct", "before namespace", "after namespace"] as const)(
    "INV-4 INV-13: %s replacement and restoration preserve current get/set/CAS selection, including previously selected programs",
    async (phase) => {
      for (const key of methods) {
        const { store, shells, nativeCalls } = fixture();
        const target = phase === "after namespace" ? namespace(store) : store;
        const selected = getNativeStorage(target)!;
        const saved = store[key];
        const custom = vi.fn(async () => (key === "get" ? "replacement" : key === "compareAndSet" ? false : undefined));
        Object.defineProperty(store, key, { value: custom, writable: true, configurable: true });
        const view = phase === "before namespace" ? namespace(store) : target;
        expect(getNativeStorage(store)).toBeUndefined();
        const result = await runEdge(invoke(view, key));
        expect(result).toBe(key === "get" ? "replacement" : key === "compareAndSet" ? false : undefined);
        expect(custom).toHaveBeenCalledTimes(1);
        expect(shells).not.toHaveBeenCalled();
        expect(nativeCalls).not.toHaveBeenCalled();
        // An already-selected program rechecks at execution, too.
        await runEdge(Reflect.apply(selected[key], selected, [...args[key]]));
        expect(custom).toHaveBeenCalledTimes(2);
        Object.defineProperty(store, key, { value: saved, writable: true, configurable: true });
        expect(getNativeStorage(store)).toBeDefined();
        await runEdge(invoke(view, key));
        expect(custom).toHaveBeenCalledTimes(2);
        expect(nativeCalls).toHaveBeenCalledTimes(1);
        expect(shells).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "INV-4 INV-13: inherited=%s decorators delegate to saved original shells exactly once",
    async (inherited) => {
      for (const key of methods) {
        const { store, shells, nativeCalls, prototype } = fixture(inherited),
          view = namespace(store);
        const receiver = inherited ? prototype : store;
        const saved = Reflect.get(receiver, key) as Function;
        const decorated = vi.fn(function (this: KVStorage, ...values: unknown[]) {
          return Reflect.apply(saved, this, values);
        });
        Object.defineProperty(receiver, key, { value: decorated, writable: true, configurable: true });
        try {
          await runEdge(invoke(view, key));
          expect(decorated).toHaveBeenCalledTimes(1);
          expect(shells).toHaveBeenCalledTimes(1);
          expect(nativeCalls).toHaveBeenCalledTimes(1);
        } finally {
          Object.defineProperty(receiver, key, { value: saved, writable: true, configurable: true });
        }
        shells.mockClear();
        nativeCalls.mockClear();
        await runEdge(invoke(view, key));
        expect(shells).not.toHaveBeenCalled();
        expect(nativeCalls).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("INV-7 INV-13: inherited replacement failures keep typed identity and interruption retains its abort reason", async () => {
    const { store, prototype } = fixture(true),
      view = namespace(store);
    const sentinel = { source: "storage guard" };
    const saved = prototype.get;
    prototype.get = () => {
      throw sentinel;
    };
    try {
      const result = await runEdge(Effect.result(invoke(view, "get")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBe(sentinel);
      const ready = deferred<void>();
      prototype.get = () => {
        ready.resolve();
        return new Promise(() => {});
      };
      const abort = new AbortController();
      const pending = runEdge(invoke(view, "get").pipe(Effect.result), { signal: abort.signal });
      await ready.promise;
      abort.abort(sentinel);
      await expect(pending).rejects.toBe(sentinel);
    } finally {
      prototype.get = saved;
    }
  });
});

it("INV-4 INV-13: activity record/list replacements, inherited delegates and restoration remain authoritative", async () => {
  const record = vi.fn(),
    list = vi.fn();
  const native = {
    record: () => Effect.sync(() => record()),
    list: () =>
      Effect.sync(() => {
        list();
        return { events: [] };
      }),
  };
  class Base implements ActivityStore {
    record(_event: ToolCallActivityEvent) {
      return runEdge(native.record());
    }
    list(_options: { limit: number }) {
      return runEdge(native.list());
    }
  }
  class Child extends Base {}
  const store = new Child();
  registerNativeActivity(store, native);
  const selected = getNativeActivity(store)!;
  const savedRecord = Base.prototype.record,
    savedList = Base.prototype.list;
  const sentinel = { source: "activity replacement" };
  Base.prototype.record = () => {
    throw sentinel;
  };
  Base.prototype.list = async () => ({ events: [] });
  expect(getNativeActivity(store)).toBeUndefined();
  const failed = await runEdge(Effect.result(selected.record({} as ToolCallActivityEvent)));
  expect(failed._tag).toBe("Failure");
  if (failed._tag === "Failure") expect(failed.failure).toBe(sentinel);
  await runEdge(selected.list({ limit: 1 }));
  expect(record).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
  const wrapper = vi.fn(function (this: ActivityStore, event: ToolCallActivityEvent) {
    return savedRecord.call(this, event);
  });
  Base.prototype.record = wrapper;
  await runEdge(selected.record({} as ToolCallActivityEvent));
  expect(wrapper).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledTimes(1);
  Base.prototype.record = savedRecord;
  Base.prototype.list = savedList;
  expect(getNativeActivity(store)).toBeDefined();
  await runEdge(selected.list({ limit: 1 }));
  expect(list).toHaveBeenCalledTimes(1);
});
