import { useEffect } from "react";
import { contractRecovering, displayRole, pageDescription, PAGE_META, type OperatorState } from "../view.js";
import { productDescription } from "./config.js";
import { ConnectorsPage } from "./connectors.js";
import { SettingsPage } from "./config-page.js";
import { EndpointsPage } from "./endpoints.js";
import { OverviewPage } from "./overview.js";
import { TokensPage } from "./tokens.js";
import { ActivityPage } from "./activity.js";
import { ConnectorDetailPage } from "./connector-detail.js";
import { MemberPage } from "./member.js";
import { ContractState, contractLoading } from "./contract-state.js";
import { PageSkeleton } from "./skeletons.js";
import { HealthProvider } from "./health.js";
import { accountLabel, focusHandled, navHint, sessionPresumed, useOperatorState } from "./bridge.js";
import { ShellControls } from "./shell.js";
import { islandOwnsFocus, visiblePages } from "./shell/operator-view.js";

function RolePending({ state }: { state: OperatorState }) {
  if (contractLoading(state) && state.page === "overview") return <OverviewPage state={state} />;
  if (contractLoading(state) && state.page === "connections") return <ConnectorsPage state={state} />;
  return (
    <section id="rolePending" aria-busy={contractLoading(state) ? "true" : "false"}>
      <div className="page-heading">
        <div>
          <h1 id={`${state.page}Heading`} tabIndex={-1}>
            {PAGE_META[state.page].label}
          </h1>
          <p className="meta">{pageDescription(state.page, productDescription)}</p>
        </div>
      </div>
      {contractLoading(state) ? <PageSkeleton /> : <ContractState state={state} />}
    </section>
  );
}

function CurrentPage({ state }: { state: OperatorState }) {
  const role = displayRole(state);
  if (role === "member" || state.role === "member") return <MemberPage state={state} account={accountLabel()} />;
  if (role !== "maintainer") return <RolePending state={state} />;
  if (state.page === "settings") return <SettingsPage state={state} />;
  if (state.page === "connector") return <ConnectorDetailPage state={state} />;
  if (state.page === "connections") return <ConnectorsPage state={state} />;
  if (state.page === "endpoints") return <EndpointsPage state={state} />;
  if (state.page === "tokens") return <TokensPage state={state} />;
  if (state.page === "activity") return <ActivityPage state={state} />;
  return <OverviewPage state={state} />;
}

function useSpendFocus(state: OperatorState): void {
  const recovering = state.session === "ready" && contractRecovering(state);
  const owned = islandOwnsFocus(state, sessionPresumed());
  useEffect(() => {
    if (!owned || (!state.pendingFocus && !state.focusIfLost)) return;
    if (state.pendingFocus) {
      const target = document.getElementById(state.pendingFocus);
      if (target?.closest("[inert]")) return;
      target?.focus();
    } else if (state.focusIfLost) {
      const active = document.activeElement;
      const lost =
        !active || active === document.body || !active.isConnected || (active as HTMLButtonElement).disabled === true;
      if (lost) document.getElementById(state.focusIfLost)?.focus();
    }
    focusHandled();
  }, [state.pendingFocus, state.focusIfLost, recovering, owned]);
}

export function PageIsland() {
  const state = useOperatorState();
  useSpendFocus(state);
  return state.session === "ready" ? (
    <HealthProvider state={state}>
      <CurrentPage state={state} />
    </HealthProvider>
  ) : (
    <RolePending state={state} />
  );
}

export function ControlsIsland() {
  const state = useOperatorState();
  return state.session === "ready" ? <ShellControls state={state} pages={visiblePages(state, navHint())} /> : null;
}
