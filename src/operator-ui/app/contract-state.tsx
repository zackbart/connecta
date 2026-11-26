import { useEffect } from "react";
import { contractRecovering, type OperatorState } from "../view.js";
import { LoadFailure, StateBlock } from "./parts.js";
import { retryLoad } from "./bridge.js";

/**
 * Close a page-owned dialog, drawer or popover the moment the page's contract
 * starts recovering. A portaled overlay escapes the page's `inert`, and a
 * modal one would keep focus trapped away from the recovery banner's Retry.
 */
export function useCloseOnRecovery(state: OperatorState, close: () => void): void {
  const recovering = contractRecovering(state);
  useEffect(() => {
    // Only the transition matters; `close` is a fresh closure every render.
    if (recovering) close();
  }, [recovering]);
}

export function ContractState({ state }: { state: OperatorState }) {
  // The shell's recovery banner owns Retry while a mounted page is stale.
  if (contractRecovering(state)) return <StateBlock busy>Reloading configuration…</StateBlock>;
  if (state.loadFailure) return <LoadFailure state={state} />;
  return (
    <StateBlock
      busy={state.contractPhase !== "error"}
      {...(state.contractPhase === "error" ? { title: "Couldn't load configuration" } : {})}
      {...(state.contractPhase === "error" || state.recoveryPending
        ? { action: { label: "Retry", onClick: () => void retryLoad() } }
        : {})}
    >
      {state.contractPhase === "error" ? null : "Loading configuration…"}
    </StateBlock>
  );
}
