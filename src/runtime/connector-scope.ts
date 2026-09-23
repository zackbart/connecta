// The Effect face of connector scope teardown (src/connector-scope.ts).
//
// closeConnectorScope() is the Promise shell over closeScope() below. An
// Effect caller that owns a Scope registers the close as that scope's
// finalizer instead, so teardown runs however the work inside it ends.

import { Duration, Effect, type Scope } from "effect";
import type { DeferredWork } from "../connector-scope.js";
import type { Connector, ConnectorContext } from "../types.js";
import { detach } from "./run.js";

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

/**
 * Succeed when `work` settles or `budgetMs` expires, whichever is first; never
 * fail. The loser is interrupted, so a close that finishes early leaves no
 * timer behind. Interrupting the wait leaves `work` running: nothing here can
 * cancel a connector's close, only stop waiting for it.
 */
function waitAtMost(work: Promise<void>, budgetMs: number): Effect.Effect<void> {
  return Effect.raceAllFirst([
    Effect.promise(() => work),
    Effect.sleep(Duration.millis(budgetMs)),
  ]);
}

/**
 * Tell a connector that a scope owned by the core has ended, with the contract
 * closeConnectorScope() documents: best-effort, never failing, waited on for a
 * small fixed window, with a bounded tail handed to `defer` when the runtime
 * has one. The hook is called when the effect runs, not when it is built.
 */
export function closeScope(
  connector: Connector,
  ctx: ConnectorContext,
  defer?: DeferredWork,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    let settled: Promise<void>;
    try {
      const closing = connector.closeScope?.(ctx);
      if (!closing) return Effect.void;
      // Attach both handlers before either timer can win, so a late rejection
      // is consumed rather than becoming an unhandled rejection.
      settled = closing.then(
        () => {},
        () => {},
      );
    } catch {
      // The scope is over whether or not the connector managed to clean it up.
      return Effect.void;
    }
    if (defer) {
      try {
        detach(waitAtMost(settled, CONNECTOR_SCOPE_DEFER_BUDGET_MS), {
          waitUntil: defer,
        });
      } catch {
        // A runtime hook is best-effort too; the caller cap still applies.
      }
    }
    return waitAtMost(settled, CONNECTOR_SCOPE_CLOSE_BUDGET_MS);
  });
}

/**
 * Close the connector scope when the enclosing Scope closes — on success,
 * failure, or interruption alike. Callers still own the at-most-once
 * guarantee: register the finalizer once per connector scope.
 */
export function closeScopeOnExit(
  connector: Connector,
  ctx: ConnectorContext,
  defer?: DeferredWork,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.addFinalizer(() => closeScope(connector, ctx, defer));
}
