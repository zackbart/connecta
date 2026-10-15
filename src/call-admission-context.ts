// Internal provider requests share the enclosing invocation's admission
// partition and concurrency permit. Keep this authority off the public context
// and bind it only after the registry admits the tool call.
import type { CallAdmissionPermit } from "./call-admission.js";
import { chargeCallBudget } from "./runtime/call-admission.js";
import { runEdge } from "./runtime/run.js";
import type { ConnectorContext } from "./types.js";

const permits = new WeakMap<ConnectorContext, CallAdmissionPermit>();

export function attachCallAdmission(ctx: ConnectorContext, permit: CallAdmissionPermit): void {
  permits.set(ctx, permit);
}

/**
 * Charge one sequential auxiliary request using the enclosing concurrency slot.
 * Await before dispatch and propagate refusal. Contexts outside an invocation
 * have no registry policy to charge.
 */
export function chargeConnectorCall(ctx: ConnectorContext): Promise<void> {
  const permit = permits.get(ctx);
  return permit ? runEdge(chargeCallBudget(permit, ctx.signal)) : Promise.resolve();
}
