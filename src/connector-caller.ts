// Who is calling, for the connectors connecta ships and nothing else.
//
// `ConnectorContext` deliberately carries no identity: a deployment's own
// connector acts for the deployment, and one that could read its caller would
// invite per-user behavior the access rules never saw. Maintained providers are the exception, so the identity rides beside the context, the way
// the OAuth sealer does, where only in-repo code can read it:
//
// - maintained providers that act *as* the caller downstream — Google
//   Workspace through domain-wide delegation (`src/providers/_shared/google/`) — which
//   hand the identity to a deployment-config function that names the
//   downstream subject (PRINCIPLES.md INV-3, #678). The
//   provider never decides whose account to open; config does, from this.
//
// Core sets it from the authorization that admitted the request, on the scoped
// registry view that request receives, and `api()` hands handlers that same
// context object; no argument or program can name it, and a header only
// through an inbound-auth provider configured to read one (a bearer's asserted
// principal). A context no request admitted, such as an operator probe, has no caller, and a delegated provider fails closed on it,
// as it does on the anonymous caller an open deployment admits.

import type { AuthenticatedIdentity, ConnectorContext } from "./types.js";

export interface ConnectorCaller {
  identity: AuthenticatedIdentity;
  /**
   * Whether an inbound auth provider admitted this request. An open
   * deployment admits every request as `{ kind: "anonymous" }`, and that is
   * a caller without being anyone: code that acts *as* the caller downstream
   * refuses it. Any provider's `ok` counts — an interactive user, a bearer
   * with or without a subject, a Connecta-issued access token.
   */
  authenticated: boolean;
  /** The `/mcp/<pool>` the call arrived on, when it was a pool. */
  pool?: string;
}

const callers = new WeakMap<ConnectorContext, ConnectorCaller>();

export function attachCaller(ctx: ConnectorContext, caller: ConnectorCaller | undefined): ConnectorContext {
  if (caller) callers.set(ctx, caller);
  return ctx;
}

export function callerOf(ctx: ConnectorContext): ConnectorCaller | undefined {
  return callers.get(ctx);
}
