// Who is calling, for the connectors connecta ships and nothing else.
//
// `ConnectorContext` deliberately carries no identity: a deployment's own
// connector acts for the deployment, and one that could read its caller would
// invite per-user behavior the access rules never saw. The built-in artifacts
// connector is the exception — every version it writes records who wrote it —
// so the identity rides beside the context, the way the OAuth sealer does,
// where only in-repo code can read it. Core sets it from the authorization
// that admitted the request, on the scoped registry view that request
// receives; no argument, header, or program can name it.

import type { AuthenticatedIdentity, ConnectorContext } from "./types.js";

export interface ConnectorCaller {
  identity: AuthenticatedIdentity;
  /** The `/mcp/<pool>` the call arrived on, when it was a pool. */
  pool?: string;
}

const callers = new WeakMap<ConnectorContext, ConnectorCaller>();

export function attachCaller(
  ctx: ConnectorContext,
  caller: ConnectorCaller | undefined,
): ConnectorContext {
  if (caller) callers.set(ctx, caller);
  return ctx;
}

export function callerOf(ctx: ConnectorContext): ConnectorCaller | undefined {
  return callers.get(ctx);
}
