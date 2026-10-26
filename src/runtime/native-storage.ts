// Optional native capabilities, with no SQL or platform implementation imports.
// Custom KVStorage implementations continue through the existing Promise lift.
import { Effect } from "effect";
import type { KVStorage } from "../types.js";
import type { ActivityPage, ActivityStore, ToolCallActivityEvent } from "../activity.js";

export interface NativeStorage {
  get(key: string): Effect.Effect<string | null, unknown>;
  set(key: string, value: string, options?: Parameters<KVStorage["set"]>[2]): Effect.Effect<void, unknown>;
  delete(key: string): Effect.Effect<void, unknown>;
  list(prefix: string): Effect.Effect<string[], unknown>;
  compareAndSet(
    key: string,
    expected: string | null,
    next: string | null,
    options?: Parameters<KVStorage["set"]>[2],
  ): Effect.Effect<boolean, unknown>;
}

export interface NativeActivityStore {
  record(event: ToolCallActivityEvent): Effect.Effect<void, unknown>;
  list(options: { cursor?: string; limit: number }): Effect.Effect<ActivityPage, unknown>;
}

// Match the custom Promise-store lift: operation construction, validation and
// decoding throws are ordinary failures with the exact thrown value. Interrupt
// reasons stay interrupts; catchDefect never recovers cancellation.
const typed = <A>(operation: () => Effect.Effect<A, unknown>): Effect.Effect<A, unknown> =>
  Effect.suspend(operation).pipe(Effect.catchDefect((error) => Effect.fail(error)));

const storage = new WeakMap<KVStorage, NativeStorage>();
const storageMethods = new WeakMap<KVStorage, Pick<KVStorage, "get" | "set" | "delete" | "list" | "compareAndSet">>();
const activity = new WeakMap<ActivityStore, NativeActivityStore>();

/** Recheck identity when the operation runs, even for an already-selected program. */
function current<A>(
  receiver: object,
  key: string,
  own: unknown,
  args: unknown[],
  native: () => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return typed(() => {
    const method = Reflect.get(receiver, key);
    return method === own
      ? native()
      : Effect.tryPromise({
          try: () => Promise.resolve(Reflect.apply(method, receiver, args)) as Promise<A>,
          catch: (error) => error,
        });
  });
}

export function registerNativeStorage(edge: KVStorage, native: NativeStorage): KVStorage {
  const own = { get: edge.get, set: edge.set, delete: edge.delete, list: edge.list, compareAndSet: edge.compareAndSet };
  storageMethods.set(edge, own);
  storage.set(edge, {
    get: (key) => current(edge, "get", own.get, [key], () => native.get(key)),
    set: (key, value, options) =>
      current(edge, "set", own.set, [key, value, options], () => native.set(key, value, options)),
    delete: (key) => current(edge, "delete", own.delete, [key], () => native.delete(key)),
    list: (prefix) => current(edge, "list", own.list, [prefix], () => native.list(prefix)),
    compareAndSet: (key, expected, next, options) =>
      current(edge, "compareAndSet", own.compareAndSet, [key, expected, next, options], () =>
        native.compareAndSet(key, expected, next, options),
      ),
  });
  return edge;
}
/** Capability presence does not authorize bypassing a current override. */
export function hasNativeStorage(edge: KVStorage): boolean {
  return storage.has(edge);
}
export function getNativeStorage(edge: KVStorage): NativeStorage | undefined {
  const own = storageMethods.get(edge);
  return own &&
    own.get === edge.get &&
    own.set === edge.set &&
    own.delete === edge.delete &&
    own.list === edge.list &&
    own.compareAndSet === edge.compareAndSet
    ? storage.get(edge)
    : undefined;
}

const activityMethods = new WeakMap<ActivityStore, { record: ActivityStore["record"]; list: ActivityStore["list"] }>();
export function registerNativeActivity(edge: ActivityStore, native: NativeActivityStore): ActivityStore {
  const own = { record: edge.record, list: edge.list };
  activityMethods.set(edge, own);
  activity.set(edge, {
    record: (event) => current(edge, "record", own.record, [event], () => native.record(event)),
    list: (options) => current(edge, "list", own.list, [options], () => native.list(options)),
  });
  return edge;
}
export function getNativeActivity(edge: ActivityStore): NativeActivityStore | undefined {
  const own = activityMethods.get(edge);
  return own && own.record === edge.record && own.list === edge.list ? activity.get(edge) : undefined;
}
