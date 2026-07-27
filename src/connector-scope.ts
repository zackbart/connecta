import type { Connector, ConnectorContext } from "./types.js";

/** Enough for local transport abort/close without letting cleanup own latency. */
const CONNECTOR_SCOPE_CLOSE_BUDGET_MS = 100;

/**
 * Tell a connector that a scope owned by the core has ended.
 *
 * Scope teardown is deliberately best-effort: a missing hook is a no-op and a
 * rejected hook is swallowed so cleanup can never replace the probe result that
 * caused it. The hook gets a small, fixed completion window so edge runtimes do
 * not cut off a real close as the response ends, but one that never settles
 * cannot hold the completed probe open indefinitely. Callers own the
 * at-most-once guarantee and must not use the scope again after this returns.
 */
export async function closeConnectorScope(
  connector: Connector,
  ctx: ConnectorContext,
): Promise<void> {
  try {
    const closing = connector.closeScope?.(ctx);
    if (!closing) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CONNECTOR_SCOPE_CLOSE_BUDGET_MS);
      // Both handlers stay attached after the timer wins, so a late rejection
      // is still consumed rather than becoming an unhandled rejection.
      closing.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  } catch {
    // The scope is over whether or not the connector managed to clean it up.
  }
}
