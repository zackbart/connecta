import type { OperatorUiContractV2 } from "../contract.js";
import { useEffect } from "react";
import { contractRecovering, type OperatorState } from "../view.js";
import { LoadFailure, StateBlock } from "./parts.js";
import { retryLoad } from "./store.js";

/**
 * The maintainer contract once `/ui/data` has answered too. Maintainer pages
 * render from it and show `ContractState` while it is null, so a failed
 * `/ui/data` read shows its own retry rather than half a page.
 */
export function maintainerContract(state: OperatorState): OperatorUiContractV2 | null {
  return state.contract?.role === "maintainer" && state.data ? state.contract : null;
}

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
  if (contractRecovering(state)) return <StateBlock busy>Waiting for the configuration to load again.</StateBlock>;
  if (state.loadFailure) return <LoadFailure state={state} />;
  return (
    <StateBlock
      busy={state.contractPhase !== "error"}
      {...(state.contractPhase === "error" ? { title: "Configuration couldn't be loaded" } : {})}
      {...(state.contractPhase === "error" || state.recoveryPending
        ? { action: { label: "Retry", onClick: () => void retryLoad() } }
        : {})}
    >
      {state.contractPhase === "error"
        ? "Retry to read the configuration visible to your session."
        : "Loading configuration…"}
    </StateBlock>
  );
}
