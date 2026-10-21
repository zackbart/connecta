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

// Error classes whose instances' `name` redaction keeps whatever was sent, by identity: the
// built-in errors, DOMException, and connecta's and the pinned MCP SDK's own classes, each
// registered with literals beside its class. Any other name an error carries, including one a
// custom class gives itself, is checked like other text.
const errorNames = new Map<object, ReadonlySet<string>>();

/** Keep `names` as the `name` of `ctor`'s instances and its subclasses'. */
export function keepErrorName(ctor: { readonly prototype: object }, ...names: string[]): void {
  errorNames.set(ctor.prototype, new Set(names));
}

/** Whether a registered class on `prototype`'s chain gives its instances `name`. */
export function keptErrorName(prototype: object | null, name: string): boolean {
  for (let at = prototype; at; at = Object.getPrototypeOf(at) as object | null)
    if (errorNames.get(at)?.has(name)) return true;
  return false;
}

for (const [ctor, name] of [
  [Error, "Error"],
  [TypeError, "TypeError"],
  [RangeError, "RangeError"],
  [SyntaxError, "SyntaxError"],
  [ReferenceError, "ReferenceError"],
  [EvalError, "EvalError"],
  [URIError, "URIError"],
  [AggregateError, "AggregateError"],
] as const)
  keepErrorName(ctor, name);
if (typeof DOMException === "function") keepErrorName(DOMException, "DOMException", "AbortError", "TimeoutError");
