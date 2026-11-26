import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
import { Schema } from "effect";
import type { OperatorUiContractV2 } from "../../contract.js";
import { contractRecovering, loadFailureCopy, type OperatorState } from "../../view.js";
import { productName } from "../config.js";
import { StateBlock } from "./parts.js";

export function maintainerContract(state: OperatorState): OperatorUiContractV2 | null {
  return state.contract?.role === "maintainer" && state.data ? state.contract : null;
}

export function contractLoading(state: OperatorState): boolean {
  return !contractRecovering(state) && !state.loadFailure && !state.recoveryPending && state.contractPhase !== "error";
}

export const ContractStateView = UiSchema.TaggedEnum({
  Recovering: {},
  LoadFailure: { title: Schema.String, body: Schema.String },
  Waiting: { failed: Schema.Boolean, retry: Schema.Boolean },
});
export type ContractStateView = typeof ContractStateView.Type;

export function contractStateView(state: OperatorState): ContractStateView {
  if (contractRecovering(state)) return ContractStateView.Recovering();
  if (state.loadFailure) return ContractStateView.LoadFailure(loadFailureCopy(state.loadFailure, productName));
  const failed = state.contractPhase === "error";
  return ContractStateView.Waiting({ failed, retry: failed || state.recoveryPending });
}

export const ContractState = <M>(h: Html.H<M>, view: ContractStateView, retry: M) =>
  ContractStateView.match(view, {
    Recovering: () => StateBlock(h, { busy: true, copy: "Reloading configuration…" }),
    LoadFailure: ({ title, body }) =>
      StateBlock(h, {
        id: "loadFailure",
        tone: "error",
        title,
        copy: body,
        action: { label: "Retry", message: retry, id: "retryLoad" },
      }),
    Waiting: ({ failed, retry: offered }) =>
      StateBlock(h, {
        busy: !failed,
        ...(failed ? { title: "Couldn't load configuration" } : {}),
        copy: failed ? null : "Loading configuration…",
        ...(offered ? { action: { label: "Retry", message: retry } } : {}),
      }),
  });
