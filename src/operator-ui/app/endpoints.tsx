import { useRef, useState } from "react";
import { endpointGroups } from "../endpoints.js";
import { driftState, type OperatorState } from "../view.js";
import { clientServerName, clientSetupCommands } from "../setup-commands.js";
import { mcpUrl } from "./config.js";
import { Badge, CopyButton, StateBlock } from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { ContractState } from "./contract-state.js";
import { ConnectorProblems } from "./problems.js";

type Endpoint = {
  label: string;
  path: string;
  url: string;
  readOnly: boolean;
  groups: ReturnType<typeof endpointGroups>;
  name: string;
};
function EndpointLine({ url, label }: { url: string; label: string }) {
  return (
    <div className="endpoint">
      <code>{url}</code>
      <CopyButton value={url} label="Copy URL" ariaLabel={`Copy URL for ${label}`} />
    </div>
  );
}

export function EndpointsPage({ state }: { state: OperatorState }) {
  const [setup, setSetup] = useState<Endpoint | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const contract = state.contract;
  const endpoints: Endpoint[] = contract
    ? [
        {
          label: "Default",
          path: "/mcp",
          url: mcpUrl,
          readOnly: contract.you.readOnly,
          groups: endpointGroups(contract, contract.you.grants, contract.you.readOnly),
          name: clientServerName(contract.config.server.name),
        },
        ...contract.you.pools.map((pool) => ({
          label: pool.name,
          path: pool.path,
          url: new URL(pool.path, mcpUrl).href,
          readOnly: pool.readOnly,
          groups: endpointGroups(contract, pool.grants, pool.readOnly, pool.name),
          name: clientServerName(contract.config.server.name, pool.name),
        })),
      ]
    : [];
  return (
    <section id="endpointsView">
      <div className="page-heading">
        <div>
          <h1 id="endpointsHeading" tabIndex={-1}>
            Endpoints
          </h1>
          <p className="meta">Endpoints visible to your session. Defined in deployment code.</p>
        </div>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : (
        <div className="endpoint-table" aria-label="Endpoints">
          <div className="endpoint-columns endpoint-labels" aria-hidden="true">
            <span>Endpoint</span>
            <span>Tools</span>
            <span>Mode</span>
            <span>Client</span>
          </div>
          {endpoints.map((endpoint) => (
            <section className="endpoint-entry" key={endpoint.path} aria-label={endpoint.path}>
              <div className="endpoint-columns">
                <div className="endpoint-name">
                  <code>{endpoint.path}</code>
                  <span className="meta">{endpoint.label}</span>
                  <EndpointLine url={endpoint.url} label={endpoint.label} />
                </div>
                <span className="endpoint-count">
                  <span className="visually-hidden">Tools: </span>
                  {endpoint.groups.reduce((n, g) => n + g.tools.length, 0)}
                </span>
                <Badge tone={endpoint.readOnly ? "accent" : "neutral"}>{endpoint.readOnly ? "read-only" : "rw"}</Badge>
                <Button
                  onClick={(event) => {
                    returnFocus.current = event.currentTarget;
                    setSetup(endpoint);
                  }}
                  aria-label={`Client setup for ${endpoint.label}`}
                >
                  Client setup
                </Button>
              </div>
              <details className="endpoint-details">
                <summary>Tools by connector</summary>
                <div className="endpoint-breakdown">
                  {endpoint.groups.length ? (
                    endpoint.groups.map(({ config, live, tools }) => (
                      <div className="endpoint-connector" key={config.id}>
                        <div>
                          <a href={`/connectors/${encodeURIComponent(config.id)}#tools`}>{config.title ?? config.id}</a>
                          <ConnectorProblems id={config.id} live={live} state={state} />
                        </div>
                        <div className="endpoint-tools">
                          {tools.length ? (
                            tools.map((tool) => (
                              <a
                                className={`tool-chip ${tool.classification}`}
                                key={tool.address}
                                href={`/connectors/${encodeURIComponent(config.id)}#tools`}
                              >
                                {tool.name}
                                <span>{tool.classification}</span>
                              </a>
                            ))
                          ) : (
                            <span className="meta">No tools available</span>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <StateBlock>No connectors are visible on this endpoint.</StateBlock>
                  )}
                </div>
              </details>
              <div className="endpoint-problems">
                {endpoint.groups
                  .filter(
                    ({ live, config }) =>
                      live.status !== "ok" ||
                      live.problem ||
                      driftState(state.data?.connectors.find((c) => c.id === config.id)?.catalogDrift) === "warning" ||
                      state.connectorFailures[config.id],
                  )
                  .map(({ config, live }) => (
                    <ConnectorProblems
                      key={config.id}
                      id={config.id}
                      live={live}
                      state={state}
                      name={config.title ?? config.id}
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}
      <Dialog
        drawer
        returnFocusTo={returnFocus}
        open={setup !== null}
        onOpenChange={(open) => {
          if (!open) setSetup(null);
        }}
        title="Client setup"
        description="Connect your MCP client to this endpoint."
      >
        {setup ? (
          <section className="setup-list">
            <h3>{setup.path}</h3>
            <EndpointLine url={setup.url} label={setup.label} />
            {clientSetupCommands(setup.name, setup.url).map((command) => (
              <div className="setup-item" key={command.id} data-setup={command.id}>
                <div className="setup-head">
                  <span>{command.label}</span>
                  <CopyButton
                    value={command.text}
                    label="Copy"
                    ariaLabel={`Copy ${command.label} setup for ${setup.label}`}
                  />
                </div>
                <pre className="setup-code">{command.text}</pre>
              </div>
            ))}
          </section>
        ) : null}
        <p className="meta">No token is included. Use your deployment's inbound sign-in or an issued client token.</p>
      </Dialog>
    </section>
  );
}
