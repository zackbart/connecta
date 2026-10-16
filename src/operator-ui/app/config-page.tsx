import type { OperatorState } from "../view.js";
import { Badge } from "./parts.js";
import { ContractState, maintainerContract } from "./contract-state.js";
import { rootAccessSentence } from "../endpoints.js";
import { SnapshotTree } from "./snapshot.js";

export function SettingsPage({ state }: { state: OperatorState }) {
  const contract = maintainerContract(state);
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
      {!contract?.config || !contract.root ? (
        <ContractState state={state} />
      ) : (
        <>
          <section className="section" aria-labelledby="inboundHeading">
            <h2 id="inboundHeading">Inbound auth</h2>
            <div className="rows">
              {contract.config.auth.map((provider, index) => (
                <div className="attention-row" key={`${provider.kind}-${index}`}>
                  <span>{provider.kind}</span>
                  <Badge>{provider.interactive ? "Interactive" : "Machine"}</Badge>
                </div>
              ))}
            </div>
            <p className="meta">{rootAccessSentence(contract.root)}</p>
          </section>
          <section className="section" aria-labelledby="snapshotHeading">
            <h2 id="snapshotHeading">Configuration</h2>
            <div className="facts-row">
              <Badge>config</Badge>
              <span className="meta">Supplied by deployment code</span>
              <Badge>default</Badge>
              <span className="meta">Resolved default or built-in value</span>
            </div>
            <SnapshotTree value={contract.config} sources={contract.configSources ?? undefined} />
          </section>
        </>
      )}
    </section>
  );
}
