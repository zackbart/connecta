// The served verdict comes from invocation, never a handler argument or method.
import { Classification, ServedClassification, recordedService, setViewService } from "./runtime/call.js";
import type { ConnectorContext } from "./types.js";
export function attachCallClassification(ctx: ConnectorContext, classification: "read" | "write"): void {
  setViewService(ctx, Classification, classification);
  setViewService(ctx, ServedClassification, classification);
}
export function callClassification(ctx: ConnectorContext): "read" | "write" | undefined {
  return recordedService(ctx, ServedClassification);
}
