import type { OperatorUiContractV2 } from "../contract.js";
import type { OperatorState } from "../view.js";
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

export function ContractState({ state }: { state: OperatorState }) {
  if (state.loadFailure) return <LoadFailure state={state} />;
  return (
    <StateBlock
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
