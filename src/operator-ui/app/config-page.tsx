import type { OperatorState } from "../view.js";
import { Badge } from "./parts.js";
import { ContractState } from "./overview.js";
import { SnapshotTree } from "./snapshot.js";

export function ConfigPage({ state }: { state: OperatorState }) {
  return (
    <section id="configView">
      <h1 id="configHeading" tabIndex={-1}>
        Config
      </h1>
      <p className="meta">The deployment snapshot visible to your session. Change configuration in code.</p>
      <div className="facts-row">
        <Badge>config</Badge>
        <span className="meta">Supplied by deployment code</span>
        <Badge>default</Badge>
        <span className="meta">Resolved default or built-in value</span>
      </div>
      <section className="section">
        {state.contract ? (
          <SnapshotTree value={state.contract.config} sources={state.contract.configSources} />
        ) : (
          <ContractState state={state} />
        )}
      </section>
    </section>
  );
}
