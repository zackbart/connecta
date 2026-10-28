import type { CallAdmissionPermit } from "../../src/call-admission.js";
import { Budget, setViewService } from "../../src/runtime/call.js";
import { chargeCallBudget } from "../../src/runtime/call-admission.js";
import type { ConnectorContext } from "../../src/types.js";

export function attachCallAdmission(ctx: ConnectorContext, permit: CallAdmissionPermit): void {
  setViewService(ctx, Budget, { charge: chargeCallBudget(permit, ctx.signal) });
}
