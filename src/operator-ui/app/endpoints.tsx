import { useRef, useState, type RefObject } from "react";
import {
  endpointRows,
  runsAsLabel,
  visibleChips,
  type AccessChip,
  type EndpointGroup,
  type EndpointRow,
} from "../endpoints.js";
import { connectorStatusLabel, connectorStatusTone, driftState, type OperatorState } from "../view.js";
import { clientServerName, clientSetupCommands } from "../setup-commands.js";
import { mcpUrl } from "./config.js";
import { Badge, CopyButton, StateBlock } from "./parts.js";
import { Button, Dialog } from "./primitives.js";
import { ContractState, maintainerContract, useCloseOnRecovery } from "./contract-state.js";

/** What the client setup drawer needs: a path, its absolute URL, and the name a client files it under. */
export interface SetupTarget {
  label: string;
  path: string;
  url: string;
  name: string;
}

export function EndpointLine({ url, label, kind }: { url: string; label: string; kind?: "agents" }) {
  return (
    <div className={kind ? "endpoint endpoint-agent" : "endpoint"}>
      {kind ? <span className="endpoint-kind">Agents</span> : null}
      <code>{url}</code>
      <CopyButton
        value={url}
        label="Copy URL"
        icon
        ariaLabel={kind ? `Copy agent URL for ${label}` : `Copy URL for ${label}`}
      />
    </div>
  );
}

/** Absolute URL for an endpoint path, on the deployment's own origin. */
export function endpointUrl(path: string): string {
  return new URL(path, mcpUrl).href;
}

export function ClientSetupDialog({
  target,
  onClose,
  returnFocus,
}: {
  target: SetupTarget | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog
      drawer
      returnFocusTo={returnFocus}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Client setup"
      description="Connect your MCP client to this endpoint."
    >
      {target ? (
        <section className="setup-list">
          <h3>{target.path}</h3>
          <EndpointLine url={target.url} label={target.label} />
          {clientSetupCommands(target.name, target.url).map((command) => (
            <div className="setup-item" key={command.id} data-setup={command.id}>
              <div className="setup-head">
                <span>{command.label}</span>
                <CopyButton
                  value={command.text}
                  label="Copy"
                  ariaLabel={`Copy ${command.label} setup for ${target.label}`}
                />
              </div>
              <pre className="setup-code">{command.text}</pre>
            </div>
          ))}
        </section>
      ) : null}
      <p className="meta">No token is included. Use your deployment's inbound sign-in or an issued client token.</p>
    </Dialog>
  );
}

/**
 * Connector health lives on Connectors. Here a connector that is not fine
 * gets a dot and a link to its Connection tab; a healthy one gets neither.
 */
function ConnectorName({ group, state }: { group: EndpointGroup; state: OperatorState }) {
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

/** A person by avatar and name, or an agent with its token mark. */
function Chip({ chip }: { chip: AccessChip }) {
  return (
    <li className={`access-chip ${chip.kind}`}>
      {chip.kind === "agent" ? (
        <span className="agent-mark" aria-hidden="true" />
      ) : (
        <span className={`avatar hue-${chip.hue}`} aria-hidden="true">
          {chip.initials}
        </span>
      )}
      <span className="access-chip-text">{chip.text}</span>
    </li>
  );
}

/**
 * Who can use one endpoint. A long list shows its first few and a "+N more"
 * button; expanding it is one-way for the row, so focus moves to the first
 * chip it revealed rather than to a button that is gone.
 */
function WhoCanUse({ endpoint }: { endpoint: EndpointRow }) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLUListElement | null>(null);
  const { shown, hidden } = visibleChips(endpoint.access, expanded);
  const label = `Who can use ${endpoint.path}`;
  if (!endpoint.access.length) {
    return (
      <div className="endpoint-access" aria-label={label} role="group">
        <span className="meta">{endpoint.pool === null ? "No maintainers listed" : "No members"}</span>
      </div>
    );
  }
  return (
    <div className="endpoint-access" aria-label={label} role="group">
      <ul className="access-chips" ref={list} tabIndex={-1}>
        {shown.map((chip) => (
          <Chip key={chip.key} chip={chip} />
        ))}
      </ul>
      {hidden ? (
        <button
          type="button"
          className="access-more"
          aria-label={`Show ${hidden} more who can use ${endpoint.path}`}
          onClick={() => {
            setExpanded(true);
            // The revealed chips are plain text; the list takes focus so a
            // screen reader continues from where the button was.
            requestAnimationFrame(() => list.current?.focus());
          }}
        >
          +{hidden} more
        </button>
      ) : null}
    </div>
  );
}

function EndpointTools({ endpoint, state }: { endpoint: EndpointRow; state: OperatorState }) {
  if (!endpoint.groups.length) return <StateBlock>No connectors are granted on this endpoint.</StateBlock>;
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
            <td className="endpoint-runs-as">
              {group.runsAs ? runsAsLabel(group.runsAs) : group.config.authScope === "personal" ? "Personal" : "Shared"}
            </td>
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
  const [setup, setSetup] = useState<SetupTarget | null>(null);
  useCloseOnRecovery(state, () => setSetup(null));
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const returnFocus = useRef<HTMLElement | null>(null);
  const contract = maintainerContract(state);
  const endpoints = contract ? endpointRows(contract) : [];
  const serverName = contract?.config?.server.name;
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
            <span>Who can use it</span>
            <span>Tools</span>
            <span>Mode</span>
          </div>
          {endpoints.map((endpoint, index) => {
            const expanded = open.has(endpoint.path);
            const panel = `endpoint-tools-${index}`;
            const url = endpointUrl(endpoint.path);
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
                    <EndpointLine url={url} label={endpoint.label} />
                    {endpoint.agentPath ? (
                      <EndpointLine url={endpointUrl(endpoint.agentPath)} label={endpoint.label} kind="agents" />
                    ) : null}
                  </div>
                  <WhoCanUse endpoint={endpoint} />
                  <span className="endpoint-count">
                    <span className="visually-hidden">Tools: </span>
                    {endpoint.toolCount}
                  </span>
                  <Badge tone={endpoint.readOnly ? "accent" : "neutral"}>
                    {endpoint.readOnly ? "read-only" : "rw"}
                  </Badge>
                  <Button
                    size="sm"
                    className="endpoint-setup"
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget;
                      setSetup({
                        label: endpoint.label,
                        path: endpoint.path,
                        url,
                        name: clientServerName(serverName, endpoint.pool ?? undefined),
                      });
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
      <ClientSetupDialog target={setup} onClose={() => setSetup(null)} returnFocus={returnFocus} />
    </section>
  );
}
