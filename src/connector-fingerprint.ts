// A connector's effective configuration, as plain data, for digests only.
//
// `describe()` is value-free by design: it omits configured header values,
// URL queries and other secrets. Bounded facts keyed by configuration (health
// records) must still change when one of those changes, so the connector
// builders register their full options here. Readers only ever digest them:
// the options never leave this module as text, and no record stores them.
import type { Connector } from "./types.js";

const effective = new WeakMap<Connector, () => unknown>();

/** Register how to read a connector's options for digests. */
export function registerEffectiveConfig(connector: Connector, read: () => unknown): void {
  effective.set(connector, read);
}

/** The registered options, or undefined for a connector that registered none. */
export function effectiveConfigOf(connector: Connector): unknown {
  return effective.get(connector)?.();
}
