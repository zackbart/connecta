// The admitted principal a request-auth resolver may receive (#1103).
//
// Only the caller core attached from the admitting authorization counts
// (`callerOf`, see connector-caller.ts). No argument, program or header can
// name it, and a context no request admitted has none. Nothing here
// invents a delegated identity: a caller that is not an admitted person, or a
// declared agent the deployment explicitly accepts, is refused before the
// resolver runs.

import { isAgentName } from "./agent-identity.js";
import { callerOf } from "./connector-caller.js";
import { validIdentityReference } from "./identity.js";
import type { RequestPrincipal, RequestPrincipalPolicy } from "./request-token.js";
import type { ConnectorContext } from "./types.js";

const forwardingConnectors = new WeakSet<object>();

/** Internal construction tag; never inferred from request data or descriptions. */
export function tagPrincipalForwarding<C extends object>(connector: C): C {
  forwardingConnectors.add(connector);
  return connector;
}

export function forwardsPrincipal(connector: object): boolean {
  for (let current: object | null = connector; current; current = Object.getPrototypeOf(current) as object | null) {
    if (forwardingConnectors.has(current)) return true;
  }
  return false;
}

/**
 * The principal this operation's admitted caller is. Anything else is refused
 * through `refuse`, the connector's own `auth_required` error.
 */
export function requestPrincipalFor(
  policy: RequestPrincipalPolicy,
  ctx: ConnectorContext,
  refuse: (reason: string) => Error,
): RequestPrincipal {
  const caller = callerOf(ctx);
  // A context no request admitted, or an open deployment's anonymous caller.
  if (!caller?.authenticated) throw refuse("acts as the admitted caller, and this operation has none");
  const { identity } = caller;
  if (identity.agent !== undefined) {
    if (policy !== "human-or-agent") throw refuse("refuses agents unless deployment code accepts them");
    if (!isAgentName(identity.agent) || identity.principal !== undefined || !caller.pool)
      throw refuse("acts as the admitted caller, and refuses this one");
    return Object.freeze({ kind: "agent", name: identity.agent, pool: caller.pool });
  }
  const principal = identity.principal;
  if (!validIdentityReference(principal)) throw refuse("acts as the admitted caller, and refuses this one");
  // Fixed key order: `JSON.stringify` of the frozen result is its partition key.
  return Object.freeze({ kind: "human", namespace: principal.namespace, id: principal.id });
}
