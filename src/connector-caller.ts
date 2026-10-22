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
//   downstream subject (PRINCIPLES.md INV-3, #678), or, for an agent, use the
//   admitted pool's configured owner (decisions/0006), and the scoped registry
//   view hides the connector from an agent whose pool has none. The provider never
//   decides whose account to open; config does, from this.
//
// Core sets it from the authorization that admitted the request, on the scoped
// registry view that request receives, and `api()` hands handlers that same
// context object; no argument or program can name it, and a header only
// through an inbound-auth provider configured to read one (a bearer's asserted
// principal). A context no request admitted, such as an operator probe, has no caller, and a delegated provider fails closed on it,
// as it does on the anonymous caller an open deployment admits.

import { Caller, serviceFor, setViewService } from "./runtime/call.js";
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
  /** The pool the call arrived on, at `/mcp/<pool>` or `/agent/<pool>`. */
  pool?: string;
  /**
   * That pool's configured `owner`, the Workspace address an agent acts as
   * (decisions/0006). Core copies it from the admitted pool's config; no
   * request can set it, and humans never act as it.
   */
  poolOwner?: string;
}

export function attachCaller(ctx: ConnectorContext, caller: ConnectorCaller | undefined): ConnectorContext {
  setViewService(ctx, Caller, caller);
  return ctx;
}
export function callerOf(ctx: ConnectorContext): ConnectorCaller | undefined {
  return serviceFor(ctx, Caller);
}
