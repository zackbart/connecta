// Facts Connecta keeps beside a value by identity, never as its properties: failure facts,
// classifications, statuses, a vendor's reasons. Redaction returns a copy of what it checked for
// every error, every array or object that is not verified plain data, and every container a
// change reaches, so each store registered here follows the copy. Web APIs only.
type Store = WeakMap<object, unknown> | WeakSet<object>;

const stores: Store[] = [];

/** Keep `store`'s entry for a value on every redacted copy of that value. */
export function followRedactedCopies<T extends Store>(store: T): T {
  stores.push(store);
  return store;
}

/** `to`, a redacted copy of `from`, takes every registered fact about `from`. */
export function redactedCopyOf<T extends object>(from: object, to: T): T {
  for (const store of stores) {
    if (!store.has(from)) continue;
    if (store instanceof WeakMap) store.set(to, store.get(from));
    else store.add(to);
  }
  return to;
}
