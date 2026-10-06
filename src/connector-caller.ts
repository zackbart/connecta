// Who is calling, for the connectors connecta ships and nothing else.
//
// `ConnectorContext` deliberately carries no identity: a deployment's own
// connector acts for the deployment, and one that could read its caller would
// invite per-user behavior the access rules never saw. Two kinds of in-repo
// code are the exceptions, so the identity rides beside the context, the way
// the OAuth sealer does, where only in-repo code can read it:
//
// - the built-in artifacts connector, because every version it writes records
//   who wrote it;
// - maintained providers that act *as* the caller downstream — Google
//   Workspace through domain-wide delegation (`src/providers/google/`) — which
//   hand the identity to a deployment-config function that names the
//   downstream subject (ethos.md, config-mapped delegated subjects, #678). The
//   provider never decides whose account to open; config does, from this.
//
// Core sets it from the authorization that admitted the request, on the scoped
// registry view that request receives, and `api()` hands handlers that same
// context object; no argument, header, or program can name it. A context no
// request admitted — a scheduled artifact refresh, an operator probe — has no
// caller, and a delegated provider fails closed on it.

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
