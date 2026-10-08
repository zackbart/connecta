import type { OperatorState } from "../view.js";
import { Catalog } from "./catalog.js";
import { ContractState } from "./overview.js";

export function ToolsPage({ state }: { state: OperatorState }) {
  return (
    <section id="toolsView">
      <h1 id="toolsHeading" tabIndex={-1}>
        Tools
      </h1>
      <p className="meta">
        The live catalog visible to your session. Reads and writes use the deployment's resolved classification.
      </p>
      <section className="section">
        {state.contract ? (
          <Catalog
            tools={state.contract.live.connectors.flatMap((c) => c.tools.map((t) => ({ ...t, connectorId: c.id })))}
          />
        ) : (
          <ContractState state={state} />
        )}
      </section>
    </section>
  );
}
