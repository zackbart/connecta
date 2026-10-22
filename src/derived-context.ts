// The Promise bridge shares its service entry only through explicit derivation.
import { deriveView } from "./runtime/call.js";
import type { ConnectorContext } from "./types.js";
export function deriveContext<T extends ConnectorContext = ConnectorContext>(
  ctx: ConnectorContext,
  overrides: Omit<T, keyof ConnectorContext> & Partial<Omit<ConnectorContext, "requestScope">>,
): T {
  return deriveView<T>(ctx, overrides as Partial<T>);
}
