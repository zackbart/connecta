// One call's private state rides beside its ConnectorContext in side tables
// keyed on the context object: the caller, the admission permit, recovery
// facts, sent secrets, the call's classification, the OAuth sealer and owner
// partition, and catalog-cache policy. A `{ ...ctx }` copy is a new key, so it
// silently starts without any of them.
//
// Derive a context here instead. Every side table looks its entry up through
// `contextKey`, which answers the context a copy was derived from, so state
// recorded through either object is seen through the other, including state
// recorded after the copy was made. The copy also keeps the origin's request
// scope. Decision 0009 (B.1) replaces these tables with Context services.
import type { ConnectorContext } from "./types.js";

const origins = new WeakMap<object, object>();

/** The object every side table keys this context's call state under. */
export function contextKey(ctx: object): object {
  return origins.get(ctx) ?? ctx;
}

/**
 * A copy of `ctx` with `overrides` that shares every side-table entry of the
 * context it came from. The request scope cannot be overridden: a derived
 * context belongs to the same request.
 */
export function deriveContext<T extends ConnectorContext = ConnectorContext>(
  ctx: ConnectorContext,
  overrides: Omit<T, keyof ConnectorContext> & Partial<Omit<ConnectorContext, "requestScope">>,
): T {
  const origin = contextKey(ctx);
  const derived = { ...ctx, ...overrides, requestScope: ctx.requestScope ?? origin } as T;
  origins.set(derived, origin);
  return derived;
}
