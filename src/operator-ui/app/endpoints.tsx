import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "@tanstack/react-router";
import { endpointFromHash } from "../connection-map.js";
import {
  endpointRows,
  runsAsLabel,
  toolSplit,
  visibleChips,
  type AccessChip,
  type EndpointGroup,
  type EndpointRow,
} from "../endpoints.js";
import type { ConnectorHealth } from "../health.js";
import { connectorVerdict, type OperatorState, type Tone } from "../view.js";
import { clientServerName, clientSetupCommands, type ClientSetupCommand } from "../setup-commands.js";
import { mcpUrl } from "./config.js";
import { CopyButton, MemberMark, Pill, StateBlock } from "./parts.js";
import { Button, Dialog, SegmentedControl } from "./primitives.js";
import { ContractState, useCloseOnRecovery } from "./contract-state.js";
import { useConnectorHealth } from "./health.js";
import { Icon } from "./icons.js";
import { Monogram, SplitBar } from "./marks.js";

/** What the client setup drawer needs: a path, its absolute URL, and the name a client files it under. */
export interface SetupTarget {
  label: string;
  path: string;
  url: string;
  name: string;
}

export function EndpointLine({ url, label, kind }: { url: string; label: string; kind?: "people" | "agents" }) {
  return (
    <div className={kind === "agents" ? "endpoint endpoint-agent" : "endpoint"}>
      {kind ? <span className="endpoint-kind">{kind === "agents" ? "Agents" : "People"}</span> : null}
      <code>{breakable(url)}</code>
      <CopyButton
        value={url}
        label="Copy URL"
        icon
        ariaLabel={kind === "agents" ? `Copy agent URL for ${label}` : `Copy URL for ${label}`}
      />
    </div>
  );
}

/** A URL that wraps only after a slash, never inside a word. */
function breakable(url: string): ReactNode[] {
  return url.split(/(?<=\/)(?!\/)/).map((part, index) => (
    <Fragment key={index}>
      {index ? <wbr /> : null}
      {part}
    </Fragment>
  ));
}

/** Absolute URL for an endpoint path, on the deployment's own origin. */
export function endpointUrl(path: string): string {
  return new URL(path, mcpUrl).href;
}

const CLIENT_LABELS: Record<ClientSetupCommand["id"], string> = {
  claude: "Claude Code",
  codex: "Codex",
  json: "JSON",
};

export function ClientSetupDialog({
  target,
  onClose,
  returnFocus,
}: {
  target: SetupTarget | null;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [client, setClient] = useState<ClientSetupCommand["id"]>("claude");
  const commands = target ? clientSetupCommands(target.name, target.url) : [];
  const command = commands.find((candidate) => candidate.id === client) ?? commands[0];
  return (
    <Dialog
      drawer
      returnFocusTo={returnFocus}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Client setup"
      description={target?.path ?? ""}
    >
      {target && command ? (
        <section className="setup-list">
          <EndpointLine url={target.url} label={target.label} />
          <SegmentedControl
            label="Client"
            value={command.id}
            options={commands.map((candidate) => ({ value: candidate.id, label: CLIENT_LABELS[candidate.id] }))}
            onChange={setClient}
          />
          <div className="setup-item" data-setup={command.id}>
            <pre className="setup-code">{command.text}</pre>
            <CopyButton
              value={command.text}
              label="Copy"
              icon
              className="btn sm copy-btn setup-copy"
              ariaLabel={`Copy ${command.label} setup for ${target.label}`}
            />
          </div>
        </section>
      ) : null}
    </Dialog>
  );
}

/**
 * Connector health lives on Connectors. Here a connector that is not fine
 * gets a dot and a link to its Connection tab; a healthy one gets neither.
 */
function connectorProblem(group: EndpointGroup, health: ConnectorHealth): { label: string; tone: Tone } | null {
  const { config, live } = group;
  const verdict = connectorVerdict(live, health.signals[config.id]);
  return verdict.tone === "ok" ? null : { label: verdict.label, tone: verdict.tone };
}

function ConnectorName({ group, health }: { group: EndpointGroup; health: ConnectorHealth }) {
  const { config } = group;
  const problem = connectorProblem(group, health);
  const id = encodeURIComponent(config.id);
  const title = config.title ?? config.id;
  return (
    <a className="endpoint-connector-name" href={`/connectors/${id}#${problem ? "connection" : "tools"}`}>
      <Monogram id={config.id} title={title} size="sm" />
      {title}
      {problem ? <span className={`dot ${problem.tone}`} title={problem.label} aria-hidden="true" /> : null}
      {problem ? <span className="visually-hidden"> ({problem.label})</span> : null}
    </a>
  );
}

/** A person by avatar, or an agent by its mark; the name shows on hover and to a screen reader. */
function Chip({ chip }: { chip: AccessChip }) {
  return (
    <li className={`access-chip ${chip.kind}`} title={chip.text}>
      <MemberMark chip={chip} />
      {chip.kind === "agent" ? <span className="visually-hidden">Agent </span> : null}
      <span className="access-chip-text visually-hidden">{chip.text}</span>
    </li>
  );
}

/**
 * Who can use one endpoint, as an avatar stack. A long list shows its first
 * few and a "+N" button; expanding it is one-way for the row, so focus moves
 * to the list it revealed rather than to a button that is gone.
 */
function WhoCanUse({ endpoint }: { endpoint: EndpointRow }) {
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLUListElement | null>(null);
  const { shown, hidden } = visibleChips(endpoint.access, expanded);
  const label = `Who can use ${endpoint.path}`;
  if (!endpoint.access.length) {
    return (
      <div className="endpoint-access" aria-label={label} role="group">
        <span className="meta">Nobody</span>
      </div>
    );
  }
  return (
    <div className="endpoint-access" aria-label={label} role="group">
      <ul className={expanded ? "access-chips stack all" : "access-chips stack"} ref={list} tabIndex={-1}>
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
          +{hidden}
        </button>
      ) : null}
    </div>
  );
}

/** How many connectors the row shows as monograms before "+N". */
const MONOGRAM_LIMIT = 4;

function ConnectorMarks({ endpoint, health }: { endpoint: EndpointRow; health: ConnectorHealth }) {
  if (!endpoint.groups.length) return <span className="endpoint-monograms meta">None</span>;
  const shown = endpoint.groups.slice(0, MONOGRAM_LIMIT);
  const rest = endpoint.groups.length - shown.length;
  return (
    <ul className="endpoint-monograms" aria-label={`Connectors on ${endpoint.path}`}>
      {shown.map((group) => {
        const title = group.config.title ?? group.config.id;
        const problem = connectorProblem(group, health);
        return (
          <li key={group.config.id} title={problem ? `${title} · ${problem.label}` : title}>
            <Monogram id={group.config.id} title={title} />
            {problem ? <span className={`monogram-dot ${problem.tone}`} aria-hidden="true" /> : null}
            <span className="visually-hidden">
              {title}
              {problem ? ` (${problem.label})` : ""}
            </span>
          </li>
        );
      })}
      {rest ? (
        <li className="monogram-more" title={`${rest} more`}>
          +{rest}
          <span className="visually-hidden"> more</span>
        </li>
      ) : null}
    </ul>
  );
}

function ToolSummary({ endpoint }: { endpoint: EndpointRow }) {
  const split = toolSplit(endpoint.groups.flatMap((group) => group.tools));
  return (
    <div className="endpoint-tool-summary" title={`${split.read} read · ${split.write} write`}>
      <span className="endpoint-count">
        <span className="visually-hidden">Tools: </span>
        {endpoint.toolCount}
      </span>
      <SplitBar read={split.read} write={split.write} />
      <span className="visually-hidden">
        , {split.read} read, {split.write} write
      </span>
    </div>
  );
}

/** A runs-as label with its kind ("Shared", "Personal", …) set apart from the detail, when it has one. */
export function RunsAs({ label }: { label: string }) {
  const at = label.indexOf(" · ");
  if (at < 0) return <>{label}</>;
  return (
    <>
      <span className="runs-as-kind">{label.slice(0, at)}</span>
      {label.slice(at)}
    </>
  );
}

function EndpointTools({ endpoint, health }: { endpoint: EndpointRow; health: ConnectorHealth }) {
  return (
    <>
      {endpoint.access.length ? (
        <ul className="endpoint-members" aria-label={`Members of ${endpoint.path}`}>
          {endpoint.access.map((chip) => (
            <li key={chip.key} className={`member-chip ${chip.kind}`}>
              <MemberMark chip={chip} />
              {chip.text}
            </li>
          ))}
        </ul>
      ) : null}
      {endpoint.groups.length ? (
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
                  <ConnectorName group={group} health={health} />
                </td>
                <td className="endpoint-runs-as">
                  <RunsAs
                    label={
                      group.runsAs
                        ? runsAsLabel(group.runsAs)
                        : group.config.authScope === "personal"
                          ? "Personal"
                          : "Shared"
                    }
                  />
                </td>
                <td>
                  {group.tools.length ? (
                    <ul className="endpoint-tools">
                      {group.tools.map((tool) => (
                        <li key={tool.address} className={`tool-chip ${tool.classification}`}>
                          {tool.classification === "write" ? <Icon name="pencil" size={11} /> : null}
                          {tool.name}
                          {tool.classification === "write" ? <span className="visually-hidden"> · write</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="meta">No tools</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <StateBlock>No connectors</StateBlock>
      )}
    </>
  );
}

export function EndpointsPage({ state }: { state: OperatorState }) {
  const [setup, setSetup] = useState<SetupTarget | null>(null);
  useCloseOnRecovery(state, () => setSetup(null));
  // The Overview map links to one endpoint as `#mcp/<pool>`: that row opens.
  const linked = endpointFromHash(useLocation().hash);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(linked ? [linked] : []));
  const returnFocus = useRef<HTMLElement | null>(null);
  const health = useConnectorHealth(state);
  const contract = health.contract;
  const endpoints = contract ? endpointRows(contract) : [];
  const linkedReady = Boolean(linked && endpoints.some((endpoint) => endpoint.path === linked));
  useEffect(() => {
    if (!linkedReady) return;
    setOpen((current) => (current.has(linked!) ? current : new Set([...current, linked!])));
    document.querySelector(`[data-endpoint="${CSS.escape(linked!)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [linked, linkedReady]);
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
            {contract ? `${endpoints.length} ${endpoints.length === 1 ? "endpoint" : "endpoints"}` : "Defined in code"}
          </p>
        </div>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : (
        <div className="endpoint-table" aria-label="Endpoints">
          <div className="endpoint-columns endpoint-labels" aria-hidden="true">
            <span className="endpoint-label-name">Endpoint</span>
            <span className="endpoint-label-who">Access</span>
            <span className="endpoint-label-conn">Connectors</span>
            <span className="endpoint-label-tools">Tools</span>
          </div>
          {endpoints.map((endpoint, index) => {
            const expanded = open.has(endpoint.path);
            const panel = `endpoint-tools-${index}`;
            const url = endpointUrl(endpoint.path);
            return (
              <section
                className={expanded ? "endpoint-entry open" : "endpoint-entry"}
                key={endpoint.path}
                data-endpoint={endpoint.path}
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
                      <span className="endpoint-chevron">
                        <Icon name="chevron" size={14} />
                      </span>
                      <code>{endpoint.path}</code>
                      {endpoint.pool === null ? <span className="meta">{endpoint.label}</span> : null}
                    </button>
                    {endpoint.readOnly ? <Pill status="info">read-only</Pill> : null}
                  </div>
                  <div className="endpoint-urls">
                    <EndpointLine
                      url={url}
                      label={endpoint.label}
                      {...(endpoint.agentPath ? { kind: "people" } : {})}
                    />
                    {endpoint.agentPath ? (
                      <EndpointLine url={endpointUrl(endpoint.agentPath)} label={endpoint.label} kind="agents" />
                    ) : null}
                  </div>
                  <WhoCanUse endpoint={endpoint} />
                  <ConnectorMarks endpoint={endpoint} health={health} />
                  <ToolSummary endpoint={endpoint} />
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
                    <Icon name="terminal" size={14} />
                    Setup
                  </Button>
                </div>
                <div id={panel} className="endpoint-details" hidden={!expanded}>
                  {expanded ? <EndpointTools endpoint={endpoint} health={health} /> : null}
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
