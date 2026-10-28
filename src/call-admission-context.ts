// The Promise view of the call's admission service; authority stays internal.
import { Budget, callScopeKnown, chargeView, recordedService } from "./runtime/call.js";
import type { ConnectorContext } from "./types.js";
export function chargeConnectorCall(ctx: ConnectorContext): Promise<void> {
  return recordedService(ctx, Budget) || callScopeKnown(ctx) ? chargeView(ctx) : Promise.resolve();
}
