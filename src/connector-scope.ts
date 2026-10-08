import type { Connector, ConnectorContext } from "./types.js";
import { closeScope } from "./runtime/connector-scope.js";
import { runEdge } from "./runtime/run.js";

// Internal ownership for credential probes invoked by a route. Context copies
// keep the requestScope, and each connector retains its own cleanup ownership.
// Standalone connector tests still close themselves.
const cleanupOwners = new WeakMap<object, Map<string, number>>();

export function claimConnectorScopeCleanup(ctx: ConnectorContext, connectorId: string): () => void {
  const scope = ctx.requestScope ?? ctx;
  let owners = cleanupOwners.get(scope);
  if (!owners) cleanupOwners.set(scope, (owners = new Map()));
  owners.set(connectorId, (owners.get(connectorId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = owners.get(connectorId)! - 1;
    if (remaining) owners.set(connectorId, remaining);
    else owners.delete(connectorId);
    if (!owners.size) cleanupOwners.delete(scope);
  };
}

export function connectorScopeCleanupClaimed(ctx: ConnectorContext, connectorId: string): boolean {
  return cleanupOwners.get(ctx.requestScope ?? ctx)?.has(connectorId) === true;
}

/** Runtime hook for work that may safely continue after a response is ready. */
export type DeferredWork = (promise: Promise<unknown>) => void;

/**
 * Tell a connector that a scope owned by the core has ended.
 *
 * Scope teardown is deliberately best-effort: a missing hook is a no-op and a
 * rejected hook is swallowed so cleanup can never replace the probe result that
 * caused it. The hook gets a small, fixed completion window so edge runtimes do
 * not cut off a real close as the response ends. When the runtime supplies
 * `defer`, the bounded tail is handed to it without extending the caller-facing
 * window. Callers own the at-most-once guarantee and must not use the scope
 * again after this returns.
 */
export function closeConnectorScope(connector: Connector, ctx: ConnectorContext, defer?: DeferredWork): Promise<void> {
  // The Promise face of closeScope (src/runtime/connector-scope.ts), which
  // owns the budgets; an Effect caller registers it as a Scope finalizer.
  return runEdge(closeScope(connector, ctx, defer));
}
