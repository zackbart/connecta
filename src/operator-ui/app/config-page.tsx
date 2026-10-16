import type { OperatorState } from "../view.js";
import { Badge } from "./parts.js";
import { Card } from "./primitives.js";
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
          <Card
            className="section"
            aria-labelledby="inboundHeading"
            titleId="inboundHeading"
            title="Inbound auth"
            description={rootAccessSentence(contract.root)}
          >
            <ul className="list-rows">
              {contract.config.auth.map((provider, index) => (
                <li className="attention-row" key={`${provider.kind}-${index}`}>
                  <span>{provider.kind}</span>
                  <Badge>{provider.interactive ? "Interactive" : "Machine"}</Badge>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            className="section"
            aria-labelledby="snapshotHeading"
            titleId="snapshotHeading"
            title="Configuration"
            actions={
              <div className="facts-row source-legend">
                <Badge>config</Badge>
                <span className="meta">Set in deployment code</span>
                <Badge>default</Badge>
                <span className="meta">Built-in default</span>
              </div>
            }
          >
            <SnapshotTree value={contract.config} sources={contract.configSources ?? undefined} />
          </Card>
        </>
      )}
    </section>
  );
}
