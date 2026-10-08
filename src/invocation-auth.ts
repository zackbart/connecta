import type { Connector, ConnectorContext } from "./types.js";

// Only built-in factories register local credential checks. This hook is not
// part of Connector, and a replacement callTool cannot inherit its proof.
const checks = new WeakMap<Connector, {
  callTool: Connector["callTool"];
  check: (ctx: ConnectorContext) => Promise<void>;
}>();

export function registerInvocationAuth(connector: Connector, check: (ctx: ConnectorContext) => Promise<void>): void {
  checks.set(connector, { callTool: connector.callTool, check });
}

/** Local credential resolution only, before entering any connector call. */
export async function resolveInvocationAuth(connector: Connector, ctx: ConnectorContext): Promise<void> {
  const entry = checks.get(connector);
  if (entry?.callTool === connector.callTool) await entry.check(ctx);
}

interface RequestInvocations {
  writeEntered: boolean;
  authFailures: Map<string, boolean>;
}
const requests = new WeakMap<object, RequestInvocations>();

function requestFor(scope: object): RequestInvocations {
  let facts = requests.get(scope);
  if (!facts) {
    facts = { writeEntered: false, authFailures: new Map() };
    requests.set(scope, facts);
  }
  return facts;
}

/** Called by the host immediately before callTool, using its private scope. */
export function recordWriteEntry(scope: object): void {
  requestFor(scope).writeEntered = true;
}

/** Eligibility comes from invocation control flow, never error fields. */
export function recordAuthFailure(scope: object, connector: string, eligible: boolean): void {
  const failures = requestFor(scope).authFailures;
  failures.set(connector, eligible && failures.get(connector) !== false);
}

export function authRecoveryFacts(scope: object, connector: string): { writeEntered: boolean; eligible: boolean } {
  const facts = requestFor(scope);
  return { writeEntered: facts.writeEntered, eligible: facts.authFailures.get(connector) === true };
}
