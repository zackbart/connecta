// The Promise view of the call's admission service; authority stays internal.
import type { CallAdmissionPermit } from "./call-admission.js";
import { Budget, callScopeKnown, chargeView, recordedService, setViewService } from "./runtime/call.js";
import { chargeCallBudget } from "./runtime/call-admission.js";
import type { ConnectorContext } from "./types.js";
export function attachCallAdmission(ctx: ConnectorContext, permit: CallAdmissionPermit): void {
  setViewService(ctx, Budget, { charge: chargeCallBudget(permit, ctx.signal) });
}
export function chargeConnectorCall(ctx: ConnectorContext): Promise<void> {
  return recordedService(ctx, Budget) || callScopeKnown(ctx) ? chargeView(ctx) : Promise.resolve();
}
