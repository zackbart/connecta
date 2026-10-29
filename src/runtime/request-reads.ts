// Request-scoped memo of storage reads (INV-7).
//
// One request often reads the same key many times: the SDK asks the OAuth
// provider for tokens once per HTTP message, and status, drift and detail
// views each open the same credential. A call site that has argued staleness
// within one request is safe reads through `RequestReads.read`; every other
// read stays a plain storage read. The memo belongs to one request owner,
// holds plain strings only, and is emptied when the request closes. Nothing in
// it crosses requests: each request owner has its own. Entries are keyed by
// the physical key in the underlying store, through any namespaced views, so
// one principal's partition never answers another's and two views of the same
// partition share one entry.
//
// Freshness. Every write through a store connecta can observe — the SQL
// drivers, `memoryStorage()`, and namespaced views over them — tells each open
// memo over that store, in this isolate, that its key is changing: before the
// write is submitted and again when it settles. The memo drops that key, and
// a read of it already in flight is not recorded, since it may or may not
// include the write. So a write by this request, or by any other request in
// this isolate, is never hidden by a memoized value. A store whose writes
// connecta cannot observe (a custom adapter, or a built-in one whose methods
// were replaced) is never memoized. Writes in another isolate, and expiry
// within the request, are the staleness a memoizing call site accepts for the
// rest of one request; it must say why that is safe.
//
// A `fresh` read bypasses the lookup and records what it saw, so a memoized
// reader never returns a value older than this request's latest fresh read of
// the same key.
import { Effect } from "effect";
import type { KVStorage } from "../types.js";

/** One physical store's identity. */
export type StoreIdentity = object;

type StorageMethods = Pick<KVStorage, "get" | "set" | "delete" | "list" | "compareAndSet">;
type Layer = { root: StoreIdentity } | { storage: KVStorage; prefix: string };
const observed = new WeakMap<KVStorage, { own: StorageMethods; layer: Layer }>();
/**
 * Open memos holding or reading entries of each store. Weak, so a request
 * owner that is never closed still lets its memo be collected with it.
 */
const open = new WeakMap<StoreIdentity, Set<WeakRef<RequestReads>>>();

function eachOpen(store: StoreIdentity, visit: (memo: RequestReads) => void): void {
  const memos = open.get(store);
  if (!memos) return;
  for (const ref of memos) {
    const memo = ref.deref();
    if (memo) visit(memo);
    else memos.delete(ref);
  }
}

/** A write to `key` of `store` is about to be submitted, or has settled. */
export function noteStorageWrite(store: StoreIdentity, key: string): void {
  eachOpen(store, (memo) => memo.changed(store, key));
}

/** Wrap one write so open memos see it begin and settle, however it ends. */
export function observedWrite<A, E, R>(
  store: StoreIdentity,
  key: string,
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    noteStorageWrite(store, key);
    return write;
  }).pipe(Effect.ensuring(Effect.sync(() => noteStorageWrite(store, key))));
}

/**
 * Declare that every write through `storage` reaches `noteStorageWrite` for
 * `root`, as long as its methods stay the ones it has now; or that `storage`
 * stores `key` at `prefix + key` in another store, observed only while that
 * one is.
 */
export function observeStorageWrites(storage: KVStorage, layer: Layer): KVStorage {
  observed.set(storage, {
    own: {
      get: storage.get,
      set: storage.set,
      delete: storage.delete,
      list: storage.list,
      compareAndSet: storage.compareAndSet,
    },
    layer,
  });
  return storage;
}

/** The underlying store and key a read of `key` reaches, when every layer is observed. */
function physical(storage: KVStorage, key: string): { store: StoreIdentity; key: string } | undefined {
  const entry = observed.get(storage);
  if (!entry) return undefined;
  const { own, layer } = entry;
  if (
    own.get !== storage.get ||
    own.set !== storage.set ||
    own.delete !== storage.delete ||
    own.list !== storage.list ||
    own.compareAndSet !== storage.compareAndSet
  )
    return undefined;
  return "root" in layer ? { store: layer.root, key } : physical(layer.storage, layer.prefix + key);
}

interface StoreEntries {
  values: Map<string, string | null>;
  /** Advanced by each write notice; a read records only if unchanged. */
  versions: Map<string, number>;
}

export class RequestReads {
  private closed = false;
  private readonly stores = new Map<StoreIdentity, StoreEntries>();
  private readonly ref = new WeakRef(this);

  private entriesFor(store: StoreIdentity): StoreEntries {
    let entries = this.stores.get(store);
    if (!entries) {
      entries = { values: new Map(), versions: new Map() };
      this.stores.set(store, entries);
      eachOpen(store, () => {}); // prune collected memos
      let memos = open.get(store);
      if (!memos) open.set(store, (memos = new Set()));
      memos.add(this.ref);
    }
    return entries;
  }

  /** A write notice: forget `key` and refuse any read of it in flight. */
  changed(store: StoreIdentity, key: string): void {
    const entries = this.stores.get(store);
    if (!entries) return;
    entries.values.delete(key);
    entries.versions.set(key, (entries.versions.get(key) ?? 0) + 1);
  }

  /** A memoized answer, or how to record the value a storage read returns. */
  private lookup(
    storage: KVStorage,
    key: string,
    fresh: boolean,
  ): { hit: true; value: string | null } | { hit: false; record: (value: string | null) => void } | undefined {
    const address = this.closed ? undefined : physical(storage, key);
    if (!address) return undefined;
    const entries = this.entriesFor(address.store);
    if (!fresh && entries.values.has(address.key)) return { hit: true, value: entries.values.get(address.key)! };
    const before = entries.versions.get(address.key) ?? 0;
    return {
      hit: false,
      record: (value) => {
        if (!this.closed && (entries.versions.get(address.key) ?? 0) === before) entries.values.set(address.key, value);
      },
    };
  }

  /**
   * `load` reads `key` from `storage`. Without `fresh`, a value this request
   * already read, with no observed write to that key since, answers instead.
   */
  read<E, R>(
    storage: KVStorage,
    key: string,
    load: Effect.Effect<string | null, E, R>,
    fresh = false,
  ): Effect.Effect<string | null, E, R> {
    return Effect.suspend(() => {
      const found = this.lookup(storage, key, fresh);
      if (!found) return load;
      if (found.hit) return Effect.succeed(found.value);
      return Effect.tap(load, (value) => Effect.sync(() => found.record(value)));
    });
  }

  /** `read` for a Promise-shaped caller, without another Effect edge. */
  async readPromise(
    storage: KVStorage,
    key: string,
    load: () => Promise<string | null>,
    fresh = false,
  ): Promise<string | null> {
    const found = this.lookup(storage, key, fresh);
    if (!found) return load();
    if (found.hit) return found.value;
    const value = await load();
    found.record(value);
    return value;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const store of this.stores.keys()) open.get(store)?.delete(this.ref);
    this.stores.clear();
  }
}
