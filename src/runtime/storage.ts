// The Storage service, as the registry's programs use it.
//
// KVStorage stays Promise-shaped: it is what a deployment author implements,
// and nobody should need Effect to write a storage adapter. The operations
// below compose a registered built-in native program, or lift one custom
// adapter call, using the Storage service. Failures retain the original thrown
// object so warnings keep the same checked facts.
//
// Which Storage a program sees is the registry's decision, not the runtime's.
// The Connecta runtime (src/runtime/services.ts) is keyed by the root
// Registry, and that is the wrong key here: a personal registry's storage is
// the root's namespaced to `principal:<key>:`, so handing its programs the
// runtime's Storage would read and write another partition. Each Registry —
// root, personal, or one a test built from plain arguments — therefore
// provides its own storage and logger to the programs it runs
// (`runOnPartition`). For the root registry those are the very values the
// runtime holds, because createConnecta passes the same two objects to both.
// A scoped view holds no storage of its own: it reaches Storage through the
// registry it delegates to, and the result stash is always the root's,
// because its capacity is deployment-wide.

import { Context, Effect } from "effect";
import type { KVStorage, Logger as LoggerShape } from "../types.js";
import { runEdge } from "./run.js";
import { getNativeStorage } from "./native-storage.js";
import { Logger, Storage } from "./services.js";

/** Read one key; null when absent. */
export function storageGet(key: string): Effect.Effect<string | null, unknown, Storage> {
  return Storage.use(
    (storage) =>
      getNativeStorage(storage)?.get(key) ??
      Effect.tryPromise({
        // Promise.resolve keeps an adapter that answers synchronously working,
        // as `await` did; a synchronous throw is caught either way.
        try: () => Promise.resolve(storage.get(key)),
        catch: (error) => error,
      }),
  );
}

/**
 * Read several keys, in one round trip when the store can; otherwise one
 * `get` after another. Values come back in `keys` order.
 */
export function storageGetMany(keys: readonly string[]): Effect.Effect<(string | null)[], unknown, Storage> {
  return Storage.use((storage) => {
    const native = getNativeStorage(storage);
    if (native?.getMany) return native.getMany(keys);
    return Effect.forEach(keys, (key) => storageGet(key).pipe(Effect.provideService(Storage, storage)));
  });
}

/** Write one key, with the adapter's optional TTL. */
export function storageSet(
  key: string,
  value: string,
  options?: Parameters<KVStorage["set"]>[2],
): Effect.Effect<void, unknown, Storage> {
  return Storage.use(
    (storage) =>
      getNativeStorage(storage)?.set(key, value, options) ??
      Effect.tryPromise({
        try: () => Promise.resolve(storage.set(key, value, options)),
        catch: (error) => error,
      }),
  );
}

/** Delete one key. */
export function storageDelete(key: string): Effect.Effect<void, unknown, Storage> {
  return Storage.use(
    (storage) =>
      getNativeStorage(storage)?.delete(key) ??
      Effect.tryPromise({
        try: () => Promise.resolve(storage.delete(key)),
        catch: (error) => error,
      }),
  );
}

/** Atomic compare-and-set of one key, as `KVStorage.compareAndSet`. */
export function storageCompareAndSet(
  key: string,
  expected: string | null,
  next: string | null,
  options?: Parameters<KVStorage["set"]>[2],
): Effect.Effect<boolean, unknown, Storage> {
  return Storage.use(
    (storage) =>
      getNativeStorage(storage)?.compareAndSet(key, expected, next, options) ??
      Effect.tryPromise({
        try: () => Promise.resolve(storage.compareAndSet(key, expected, next, options)),
        catch: (error) => error,
      }),
  );
}

/** List keys under one literal prefix, preserving the adapter's ordering. */
export function storageList(prefix: string): Effect.Effect<string[], unknown, Storage> {
  return Storage.use(
    (storage) =>
      getNativeStorage(storage)?.list(prefix) ??
      Effect.tryPromise({
        try: () => Promise.resolve(storage.list(prefix)),
        catch: (error) => error,
      }),
  );
}

/** The storage partition and logger one registry owns. */
interface Partition {
  readonly storage: KVStorage;
  readonly logger: LoggerShape;
}

// One context per partition object, built on first use. A registry's options
// object lives exactly as long as the registry, so the WeakMap never holds a
// partition past its owner.
const partitions = new WeakMap<Partition, Context.Context<Storage | Logger>>();

function partitionContext(partition: Partition): Context.Context<Storage | Logger> {
  let context = partitions.get(partition);
  if (!context) {
    context = Context.make(Storage, partition.storage).pipe(Context.add(Logger, partition.logger));
    partitions.set(partition, context);
  }
  return context;
}

/**
 * Run a registry program against the registry's own storage and logger, at a
 * Promise boundary. Resolves and rejects as runEdge does: the original error,
 * never a wrapper.
 */
export function runOnPartition<A, E>(effect: Effect.Effect<A, E, Storage | Logger>, partition: Partition): Promise<A> {
  return runEdge(Effect.provideContext(effect, partitionContext(partition)));
}
