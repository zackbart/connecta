import type { OperatorState } from "../view.js";
import { Badge } from "./parts.js";
import { ContractState } from "./contract-state.js";
import { SnapshotTree } from "./snapshot.js";

export function SettingsPage({ state }: { state: OperatorState }) {
  return (
    <section id="settingsView">
      <div className="page-heading">
        <div>
          <h1 id="settingsHeading" tabIndex={-1}>
            Settings
          </h1>
          <p className="meta">Read-only snapshot, defined in code.</p>
        </div>
      </div>
      {!state.contract?.config ? (
        <ContractState state={state} />
      ) : (
        <>
          <section className="section" aria-labelledby="inboundHeading">
            <h2 id="inboundHeading">Inbound auth</h2>
            <div className="rows">
              {state.contract.config.auth.map((provider, index) => (
                <div className="attention-row" key={`${provider.kind}-${index}`}>
                  <span>{provider.kind}</span>
                  <Badge>{provider.interactive ? "Interactive" : "Machine"}</Badge>
                </div>
              ))}
            </div>
            <p className="meta">
              {state.contract.config.hasGrant
                ? "Root endpoint grant configured in code."
                : "No root grant configured; every caller admitted by auth may use /mcp."}
            </p>
          </section>
          <section className="section" aria-labelledby="snapshotHeading">
            <h2 id="snapshotHeading">Configuration</h2>
            <div className="facts-row">
              <Badge>config</Badge>
              <span className="meta">Supplied by deployment code</span>
              <Badge>default</Badge>
              <span className="meta">Resolved default or built-in value</span>
            </div>
            <SnapshotTree value={state.contract.config} sources={state.contract.configSources ?? undefined} />
          </section>
        </>
      )}
    </section>
  );
}
