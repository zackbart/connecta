import { Predicate, Schema, Stream } from "effect";
import {
  activityAllowed,
  activityReadable,
  displayRole,
  OPERATOR_PAGES,
  type OperatorPage,
  type OperatorState,
} from "../../view.js";
import { OperatorController, type OperatorControllerShape } from "../services/controller.js";

export interface OperatorView {
  readonly state: OperatorState;
  readonly navHint: { readonly activity: boolean };
  readonly account: string | null;
  readonly sessionPresumed: boolean;
  readonly clerkSignedIn: boolean;
}

export const OperatorView = Schema.declare<OperatorView>(
  (input): input is OperatorView => Predicate.isObject(input) && Predicate.isObject(input.state),
);

const viewOf = (controller: OperatorControllerShape, state = controller.state()): OperatorView => ({
  state,
  navHint: controller.navHint(),
  account: controller.accountLabel(),
  sessionPresumed: controller.sessionPresumed(),
  clerkSignedIn: controller.clerkSignedIn(),
});

export const currentView = OperatorController.useSync((controller) => viewOf(controller));

export const viewChanges = Stream.unwrap(
  OperatorController.useSync((controller) => Stream.map(controller.changes, (state) => viewOf(controller, state))),
);

export function visiblePages(state: OperatorState, navHint: { readonly activity: boolean }): OperatorPage[] {
  if (displayRole(state) !== "maintainer") return [];
  const activity = state.data ? activityReadable(state) : navHint.activity && activityAllowed(state);
  return OPERATOR_PAGES.filter((page) => {
    if (page === "tokens")
      return (
        state.data?.accessTokenManagement === "available" ||
        (state.contract?.role === "maintainer" && state.contract.agents.length > 0)
      );
    if (page === "activity") return activity;
    return true;
  });
}
