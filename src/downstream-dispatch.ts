// Host-owned dispatch facts. A handler receives no counter or reset capability.
import type { ConnectorContext } from "./types.js";

interface RequestDispatches {
  count: number;
  writes: number;
}
interface InvocationDispatches {
  request: RequestDispatches;
  write: boolean;
  count: number;
}
const requests = new WeakMap<object, RequestDispatches>();
const invocations = new WeakMap<ConnectorContext, InvocationDispatches>();

function requestFor(scope: object): RequestDispatches {
  let facts = requests.get(scope);
  if (!facts) { facts = { count: 0, writes: 0 }; requests.set(scope, facts); }
  return facts;
}

/** Bind the registry's classification and scope before handing over a context. */
export function trackInvocationDispatch(ctx: ConnectorContext, write: boolean): void {
  if (!invocations.has(ctx)) {
    invocations.set(ctx, { request: requestFor(ctx.requestScope ?? ctx), write, count: 0 });
  }
}

/** Called only at the last transport boundary, immediately before sending.
 * Shared MCP transports conservatively attribute a send to every active call,
 * but count the physical request once for each upstream request scope. */
export function recordDownstreamDispatch(contexts: readonly ConnectorContext[]): void {
  const recipients = new Map<RequestDispatches, boolean>();
  for (const ctx of new Set(contexts)) {
    const invocation = invocations.get(ctx);
    if (invocation) invocation.count++;
    const request = invocation?.request ?? requestFor(ctx.requestScope ?? ctx);
    recipients.set(request, Boolean(recipients.get(request) || invocation?.write));
  }
  for (const [request, write] of recipients) {
    request.count++;
    if (write) request.writes++;
  }
}

export function invocationDispatchCount(ctx: ConnectorContext): number {
  return invocations.get(ctx)?.count ?? 0;
}

export function requestDispatches(scope: object): Readonly<RequestDispatches> {
  const facts = requestFor(scope);
  return { count: facts.count, writes: facts.writes };
}
