// Optional native capabilities, with no SQL or platform implementation imports.
// Custom KVStorage implementations continue through the existing Promise lift.
import type { Effect } from "effect";
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

const storage = new WeakMap<KVStorage, NativeStorage>();
const activity = new WeakMap<ActivityStore, NativeActivityStore>();

export function registerNativeStorage(edge: KVStorage, native: NativeStorage): KVStorage {
  storage.set(edge, native);
  return edge;
}
export function getNativeStorage(edge: KVStorage): NativeStorage | undefined {
  return storage.get(edge);
}
export function registerNativeActivity(edge: ActivityStore, native: NativeActivityStore): ActivityStore {
  activity.set(edge, native);
  return edge;
}
export function getNativeActivity(edge: ActivityStore): NativeActivityStore | undefined {
  return activity.get(edge);
}
