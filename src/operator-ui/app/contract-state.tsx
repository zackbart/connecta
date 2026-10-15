import type { OperatorState } from "../view.js";
import { LoadFailure, StateBlock } from "./parts.js";
import { retryLoad } from "./store.js";

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
