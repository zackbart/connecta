import { Schema, Stream } from "effect";
import {
  activityAllowed,
  activityReadable,
  contractRecovering,
  displayRole,
  OPERATOR_PAGES,
  operatorRole,
  type OperatorPage,
  type OperatorState,
} from "../../view.js";
import { contractLoading } from "../components/contract-state.js";
import { OperatorController, type OperatorControllerShape } from "../services/controller.js";

const Page = Schema.Literals(OPERATOR_PAGES);

const CONTENT_OWNERS = [
  "gate",
  "denied",
  "overview",
  "connectors",
  "connector",
  "endpoints",
  "tokens",
  "activity",
  "settings",
  "island",
] as const;
export type ContentOwner = (typeof CONTENT_OWNERS)[number];

export const OperatorView = Schema.Struct({
  session: Schema.Literals(["loading", "gated", "ready", "denied"]),
  role: Schema.NullOr(Schema.Literals(["maintainer", "member"])),
  page: Page,
  gate: Schema.NullOr(Schema.Struct({ message: Schema.String, tone: Schema.Literals(["info", "error"]) })),
  focusRequested: Schema.Boolean,
  content: Schema.Literals(CONTENT_OWNERS),
  islandOwnsFocus: Schema.Boolean,
  recovering: Schema.Boolean,
  recoveryFailed: Schema.Boolean,
  pages: Schema.Array(Page),
  deploymentName: Schema.NullOr(Schema.String),
  collectionsWanted: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  sessionPresumed: Schema.Boolean,
  clerkSignedIn: Schema.Boolean,
});
export type OperatorView = typeof OperatorView.Type;

const collectionsWanted = (state: OperatorState) =>
  state.session === "ready" &&
  ((state.page === "tokens" &&
    operatorRole(state) === "maintainer" &&
    state.data?.accessTokenManagement === "available" &&
    state.tokenPhase === "idle") ||
    ((state.page === "activity" || state.page === "connector") &&
      activityReadable(state) &&
      state.activityPhase === "idle"));

const ownerWhilePending = (state: OperatorState): ContentOwner =>
  contractLoading(state) && state.page === "overview"
    ? "overview"
    : contractLoading(state) && state.page === "connections"
      ? "connectors"
      : "island";

const MAINTAINER_PAGES: Partial<Record<OperatorPage, ContentOwner>> = {
  overview: "overview",
  connections: "connectors",
  connector: "connector",
  endpoints: "endpoints",
  tokens: "tokens",
  activity: "activity",
  settings: "settings",
};

function contentOwner(state: OperatorState, sessionPresumed: boolean): ContentOwner {
  if (state.session === "denied") return "denied";
  if (state.session !== "ready")
    return state.session === "loading" && sessionPresumed ? ownerWhilePending(state) : "gate";
  const role = displayRole(state);
  if (role === "member" || state.role === "member") return "island";
  if (role !== "maintainer") return ownerWhilePending(state);
  return MAINTAINER_PAGES[state.page] ?? "island";
}

export const islandOwnsFocus = (state: OperatorState, sessionPresumed: boolean): boolean =>
  contentOwner(state, sessionPresumed) === "island";

export function projectView(
  state: OperatorState,
  shell: {
    readonly navHint: { readonly activity: boolean };
    readonly account: string | null;
    readonly sessionPresumed: boolean;
    readonly clerkSignedIn: boolean;
  },
): OperatorView {
  const name = state.contract?.role === "maintainer" ? (state.contract.config?.server.name ?? null) : null;
  return {
    session: state.session,
    role: state.role,
    page: state.page,
    gate: state.gate ? { message: state.gate.message, tone: state.gate.tone } : null,
    focusRequested: state.pendingFocus !== null || state.focusIfLost !== null,
    content: contentOwner(state, shell.sessionPresumed),
    islandOwnsFocus: islandOwnsFocus(state, shell.sessionPresumed),
    recovering: state.session === "ready" && contractRecovering(state),
    recoveryFailed: state.contractPhase === "error" || state.loadFailure !== null,
    pages: state.session === "ready" ? visiblePages(state, shell.navHint) : [],
    deploymentName: name,
    collectionsWanted: collectionsWanted(state),
    account: shell.account,
    sessionPresumed: shell.sessionPresumed,
    clerkSignedIn: shell.clerkSignedIn,
  };
}

export const viewOf = (controller: OperatorControllerShape, state = controller.state()): OperatorView =>
  projectView(state, {
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
