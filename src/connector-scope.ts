import type { Connector, ConnectorContext } from "./types.js";
import { sleep } from "./timeout.js";

/** Enough for local transport abort/close without letting cleanup own latency. */
const CONNECTOR_SCOPE_CLOSE_BUDGET_MS = 100;

/**
 * Bound on cleanup continued after the caller-facing window expires.
 *
 * `remoteMcp` spends at most one second asking the downstream to terminate its
 * session, leaving another second for the local close. Custom hooks still get a
 * finite background window: handing a never-settling promise to a Worker's
 * `waitUntil` would otherwise keep the invocation alive until the platform cap.
 */
const CONNECTOR_SCOPE_DEFER_BUDGET_MS = 2_000;

/** Runtime hook for work that may safely continue after a response is ready. */
export type DeferredWork = (promise: Promise<unknown>) => void;

/** Resolve when `work` settles or `budgetMs` expires; never reject. */
function waitAtMost(work: Promise<void>, budgetMs: number): Promise<void> {
  return Promise.race([work, sleep(budgetMs)]).then(() => {});
}

/**
 * Tell a connector that a scope owned by the core has ended.
 *
 * Scope teardown is deliberately best-effort: a missing hook is a no-op and a
 * rejected hook is swallowed so cleanup can never replace the probe result that
 * caused it. The hook gets a small, fixed completion window so edge runtimes do
 * not cut off a real close as the response ends. When the runtime supplies
 * `defer`, the bounded tail is handed to it without extending the caller-facing
 * window. Callers own the at-most-once guarantee and must not use the scope
 * again after this returns.
 */
export async function closeConnectorScope(
  connector: Connector,
  ctx: ConnectorContext,
  defer?: DeferredWork,
): Promise<void> {
  try {
    const closing = connector.closeScope?.(ctx);
    if (!closing) return;
    // Attach both handlers before either timer can win, so a late rejection is
    // consumed rather than becoming an unhandled rejection.
    const settled = closing.then(
      () => {},
      () => {},
    );
    if (defer) {
      try {
        defer(waitAtMost(settled, CONNECTOR_SCOPE_DEFER_BUDGET_MS));
      } catch {
        // A runtime hook is best-effort too; the caller cap still applies.
      }
    }
    await waitAtMost(settled, CONNECTOR_SCOPE_CLOSE_BUDGET_MS);
  } catch {
    // The scope is over whether or not the connector managed to clean it up.
  }
}
