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
const activity = new WeakMap<ActivityStore, NativeActivityStore>();

export function registerNativeStorage(edge: KVStorage, native: NativeStorage): KVStorage {
  storage.set(edge, {
    get: (key) => typed(() => native.get(key)),
    set: (key, value, options) => typed(() => native.set(key, value, options)),
    delete: (key) => typed(() => native.delete(key)),
    list: (prefix) => typed(() => native.list(prefix)),
    compareAndSet: (key, expected, next, options) => typed(() => native.compareAndSet(key, expected, next, options)),
  });
  return edge;
}
export function getNativeStorage(edge: KVStorage): NativeStorage | undefined {
  return storage.get(edge);
}
export function registerNativeActivity(edge: ActivityStore, native: NativeActivityStore): ActivityStore {
  activity.set(edge, {
    record: (event) => typed(() => native.record(event)),
    list: (options) => typed(() => native.list(options)),
  });
  return edge;
}
export function getNativeActivity(edge: ActivityStore): NativeActivityStore | undefined {
  return activity.get(edge);
}
