import { useRef, useState } from "react";
import { endpointGroups } from "../endpoints.js";
import { connectorStatusLabel, connectorStatusTone, driftState, type OperatorState } from "../view.js";
import { clientServerName, clientSetupCommands } from "../setup-commands.js";
import { mcpUrl } from "./config.js";
import { Badge, CopyButton, StateBlock } from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { ContractState } from "./contract-state.js";

type Endpoint = {
  label: string;
  path: string;
  url: string;
  readOnly: boolean;
  groups: ReturnType<typeof endpointGroups>;
  name: string;
};
type Group = Endpoint["groups"][number];

function EndpointLine({ url, label }: { url: string; label: string }) {
  return (
    <div className="endpoint">
      <code>{url}</code>
      <CopyButton value={url} label="Copy URL" icon ariaLabel={`Copy URL for ${label}`} />
    </div>
  );
}

/**
 * Connector health lives on Connectors. Here a connector that is not fine
 * gets a dot and a link to its Connection tab; a healthy one gets neither.
 */
function ConnectorName({ group, state }: { group: Group; state: OperatorState }) {
  const { config, live } = group;
  const local = state.connectorFailures[config.id];
  const drift = driftState(state.data?.connectors.find((c) => c.id === config.id)?.catalogDrift) === "warning";
  const problem = local
    ? "Couldn't load"
    : live.status !== "ok" || live.problem
      ? connectorStatusLabel(live.status, live.problem)
      : drift
        ? "Catalog drift"
        : null;
  const tone = local || drift ? "warn" : connectorStatusTone(live.status);
  const id = encodeURIComponent(config.id);
  return (
    <a className="endpoint-connector-name" href={`/connectors/${id}#${problem ? "connection" : "tools"}`}>
      {problem ? <span className={`dot ${tone}`} title={problem} aria-hidden="true" /> : null}
      {config.title ?? config.id}
      {problem ? <span className="visually-hidden"> ({problem})</span> : null}
    </a>
  );
}

function EndpointTools({ endpoint, state }: { endpoint: Endpoint; state: OperatorState }) {
  if (!endpoint.groups.length) return <StateBlock>No connectors are visible on this endpoint.</StateBlock>;
  return (
    <table className="endpoint-breakdown" aria-label={`Tools on ${endpoint.path}`}>
      <thead>
        <tr>
          <th scope="col">Connector</th>
          <th scope="col">Runs as</th>
          <th scope="col">Tools</th>
        </tr>
      </thead>
      <tbody>
        {endpoint.groups.map((group) => (
          <tr key={group.config.id}>
            <td>
              <ConnectorName group={group} state={state} />
            </td>
            <td className="endpoint-runs-as">{group.config.authScope === "personal" ? "Personal" : "Shared"}</td>
            <td>
              {group.tools.length ? (
                <ul className="endpoint-tools">
                  {group.tools.map((tool) => (
                    <li key={tool.address} className={`tool-chip ${tool.classification}`}>
                      {tool.name}
                      {tool.classification === "write" ? <span className="tool-chip-mark"> · write</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="meta">No tools available</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function EndpointsPage({ state }: { state: OperatorState }) {
  const [setup, setSetup] = useState<Endpoint | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
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
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <section id="endpointsView">
      <div className="page-heading">
        <div>
          <h1 id="endpointsHeading" tabIndex={-1}>
            Endpoints
          </h1>
          <p className="meta">
            {contract
              ? `${endpoints.length} ${endpoints.length === 1 ? "endpoint" : "endpoints"}, defined in code.`
              : "Defined in code."}
          </p>
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
          </div>
          {endpoints.map((endpoint, index) => {
            const expanded = open.has(endpoint.path);
            const panel = `endpoint-tools-${index}`;
            return (
              <section
                className={expanded ? "endpoint-entry open" : "endpoint-entry"}
                key={endpoint.path}
                aria-label={endpoint.path}
              >
                <div className="endpoint-columns">
                  <div className="endpoint-name">
                    {/* The toggle's hit area stretches over the whole row; the
                        copy and setup buttons sit above it. */}
                    <button
                      type="button"
                      className="endpoint-toggle"
                      aria-expanded={expanded}
                      aria-controls={panel}
                      onClick={() => toggle(endpoint.path)}
                    >
                      <code>{endpoint.path}</code>
                      <span className="meta">{endpoint.label}</span>
                    </button>
                    <EndpointLine url={endpoint.url} label={endpoint.label} />
                  </div>
                  <span className="endpoint-count">
                    <span className="visually-hidden">Tools: </span>
                    {endpoint.groups.reduce((n, g) => n + g.tools.length, 0)}
                  </span>
                  <Badge tone={endpoint.readOnly ? "accent" : "neutral"}>
                    {endpoint.readOnly ? "read-only" : "rw"}
                  </Badge>
                  <Button
                    variant="quiet"
                    className="endpoint-setup"
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setSetup(endpoint);
                    }}
                    aria-label={`Client setup for ${endpoint.label}`}
                  >
                    Client setup
                  </Button>
                  <span className="conn-caret" aria-hidden="true" />
                </div>
                <div id={panel} className="endpoint-details" hidden={!expanded}>
                  {expanded ? <EndpointTools endpoint={endpoint} state={state} /> : null}
                </div>
              </section>
            );
          })}
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
