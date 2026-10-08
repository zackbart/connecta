import { DataTable } from "./primitives.js";
import type { ColumnDef } from "@tanstack/react-table";
import { useState } from "react";
import { CredentialCard } from "./credentials.js";
import { filterUiConnectors, type UiConnector } from "../model.js";
import {
  authScopeLabel,
  confirmCopy,
  connectorLoadFailureCopy,
  connectorStatusLabel,
  connectorStatusTone,
  connectorSummaryParts,
  driftCounts,
  driftState,
  driftSummary,
  formatDate,
  permissionLabel,
  problemCopy,
  problemTone,
  safeHttpHref,
  summarizeConnectors,
  TOOL_SAFETY_BADGE,
  toolCountLabel,
  type OperatorState,
} from "../view.js";
import {
  clientServerName,
  clientSetupCommands,
  poolEndpointUrl,
} from "../setup-commands.js";
import { mcpUrl, productName, productOperatorLabel } from "./config.js";
import {
  Badge,
  ConfirmBar,
  CopyButton,
  Empty,
  FixPrompt,
  FixPromptButton,
  FixPromptPreview,
  focusableId,
  LoadFailure,
  NoticeLine,
} from "./parts.js";
import {
  askConfirm,
  cancelConfirm,
  disconnectOAuth,
  refreshConnector,
  setConnectorFilter,
  startOAuth,
} from "./store.js";

const DRIFT_HEADING: Record<ReturnType<typeof driftState>, string> = {
  clean: "Catalog drift · none",
  warning: "Catalog drift · review",
  unavailable: "Catalog drift · not observed",
};

/**
 * What the last catalog refresh saw, as counts. There is no drill-down and
 * nothing to expand: a tool name or a schema on this panel would turn an
 * operator page into the payload surface the drift model refuses to be
 * ([#343](https://github.com/zackbart/connecta/issues/343)). Absence is its own
 * state — a runtime that has refreshed nothing says so rather than showing four
 * reassuring zeros.
 */
function DriftPanel({ connector }: { connector: UiConnector }) {
  const drift = connector.catalogDrift;
  const state = driftState(drift);
  return (
    <>
    {/* Kept outside the counted panel, so the panel stays counts only. */}
    <div
      id={`drift-${connector.id}`}
      className={`connector-drift ${state}`}
      data-drift={state}
    >
      <p className="cap">{DRIFT_HEADING[state]}</p>
      <p className="meta">{driftSummary(drift)}</p>
      {state === "unavailable" ? null : (
        <ul className="drift-counts">
          {driftCounts(drift).map(({ key, label, count }) => (
            <li key={key} className={count > 0 ? "drift-count flagged" : "drift-count"}>
              <span className="drift-count-value">{count}</span>
              <span className="drift-count-label">{label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
    {state === "warning" ? (
      <FixPrompt
        kind="catalog_drift"
        connectorId={connector.id}
        name={connector.title || connector.id}
      />
    ) : null}
    </>
  );
}

/**
 * A tool's call path as the server classified it. Keyed by the payload's
 * value through `TOOL_SAFETY_BADGE`; an unknown or missing value renders
 * nothing rather than a guess.
 */
function SafetyBadge({ safety }: { safety: UiConnector["tools"][number]["safety"] }) {
  const badge = safety ? TOOL_SAFETY_BADGE[safety] : undefined;
  if (!badge) return null;
  return (
    <span className="tool-safety" title={badge.title} data-safety={safety}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </span>
  );
}

const toolColumns: ColumnDef<UiConnector["tools"][number]>[] = [
  { accessorKey: "address", header: "Tool", cell: ({ row }) => <div className="tool"><div className="tool-head"><code>{row.original.address}</code></div>{row.original.description ? <span className="td">{row.original.description}</span> : null}</div> },
  { accessorKey: "safety", header: "Classification", cell: ({ row }) => <SafetyBadge safety={row.original.safety} /> },
];

/**
 * One MCP endpoint: its URL, a copy button, and the client snippets for it.
 * The deployment's `/mcp` and every pool this identity may open render the
 * same way, so a pool is never a second-class endpoint.
 */
function Endpoint({
  url,
  name,
  label,
  primary,
}: {
  url: string;
  name: string;
  label?: string;
  primary?: boolean;
}) {
  return (
    <div className="endpoint-block" data-endpoint={name}>
      <div className="endpoint">
        {label ? <span className="endpoint-label cap">{label}</span> : null}
        <code {...(primary ? { id: "mcpUrl" } : {})} className="mono">
          {url}
        </code>
        <CopyButton
          value={url}
          label="Copy URL"
          {...(label ? { ariaLabel: `Copy URL for ${label}` } : {})}
        />
      </div>
      <details className="setup">
        <summary className="disclosure">
          Client setup{label ? ` · ${label}` : ""}
        </summary>
        <div className="setup-list">
          {clientSetupCommands(name, url).map((command) => (
            <div className="setup-item" key={command.id} data-setup={command.id}>
              <div className="setup-head">
                <span className="cap">{command.label}</span>
                <CopyButton
                  value={command.text}
                  label="Copy"
                  className="btn quiet"
                  ariaLabel={`Copy ${command.label} setup${label ? ` for ${label}` : ""}`}
                />
              </div>
              <pre className="setup-code">{command.text}</pre>
            </div>
          ))}
          <p className="meta">
            No token is included. Clients sign in through this deployment's inbound auth.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * The row's authentication controls: at most one primary action, chosen by
 * the connector's state. A connector that needs authorizing offers Connect,
 * which asks the route to continue any fresh pending authorization rather
 * than reset it; a healthy one offers Reconnect and Disconnect, each behind
 * an in-page confirm, because each takes a working grant away.
 */
function AuthActions({
  connector,
  name,
  manage,
  state,
}: {
  connector: UiConnector;
  name: string;
  manage: boolean;
  state: OperatorState;
}) {
  const id = connector.id;
  const authorization = safeHttpHref(connector.authorizationUrl);
  const busy = state.oauthBusy === id;
  if (connector.status === "loading") return null;
  // No lifecycle hooks, or no right to use them: a pending link is still the
  // one thing this identity can do.
  if (!connector.oauth || !manage) {
    return authorization && connector.status !== "ok" ? (
      <a className="btn primary" href={authorization} target="_blank" rel="noopener noreferrer">
        Authorize connector
      </a>
    ) : null;
  }
  // The browser refused the new tab; the route answered anyway, so the link
  // it returned is the action.
  if (state.oauthBlocked === id && authorization) {
    return (
      <a
        id={`authorize-${id}`}
        className="btn primary"
        href={authorization}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open authorization page
      </a>
    );
  }
  if (connector.status !== "ok") {
    const needsAuth = connector.status === "auth_required";
    return (
      <button
        type="button"
        id={`connect-${id}`}
        className={needsAuth ? "btn primary" : "btn"}
        aria-label={`${needsAuth ? "Connect" : "Reconnect"} ${name}`}
        disabled={busy}
        onClick={() => void startOAuth(id, "continue")}
      >
        {busy ? "Opening…" : needsAuth ? "Connect account" : "Reconnect"}
      </button>
    );
  }
  const switching = connector.authScope === "personal";
  return (
    <>
      <button
        type="button"
        id={`reconnect-${id}`}
        className="btn"
        aria-label={`${switching ? "Switch account for" : "Reconnect"} ${name}`}
        disabled={busy}
        onClick={() => askConfirm(id, "oauth_restart")}
      >
        {busy ? "Working…" : switching ? "Switch account" : "Reconnect"}
      </button>
      <button
        type="button"
        id={`disconnect-${id}`}
        className="btn danger"
        aria-label={`Disconnect ${name}`}
        disabled={busy}
        onClick={() => askConfirm(id, "oauth_disconnect")}
      >
        Disconnect
      </button>
    </>
  );
}

/**
 * One connector as a single line until an operator asks for more. The closed
 * row shows state, tool count, and who owns the authentication; everything
 * that needs reading or acting on is in the body, which keeps a twenty-
 * connector deployment to one screen.
 *
 * The heading holds a button that toggles the body — the disclosure pattern,
 * rather than a `<summary>`, whose button role would swallow the heading.
 * The open state is this component's own, and the list unmounts on every
 * identity change, so one identity's panel never stays open over another's.
 */
function ConnectorRow({
  connector,
  tools,
  forceOpen,
  state,
}: {
  connector: UiConnector;
  tools: UiConnector["tools"];
  forceOpen: boolean;
  state: OperatorState;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || forceOpen;
  const id = connector.id;
  const name = connector.title || id;
  const drift = driftState(connector.catalogDrift);
  const manage = Boolean(
    connector.permissions?.manageSharedAuth || connector.permissions?.connectPersonal,
  );
  const local = state.connectorFailures[id];
  // A connector being refreshed has no settled problem yet; the last one would
  // describe a state the page is no longer showing.
  const problem =
    connector.status === "loading" || local ? null : problemCopy(connector.problem);
  const confirming = state.confirming?.connectorId === id ? state.confirming : null;
  const oauthConfirm =
    confirming && confirming.action !== "credential_remove" ? confirming : null;
  const statusLabel = local
    ? "Couldn't load"
    : connectorStatusLabel(connector.status, connector.problem);
  // Only a downstream failure has anything for a coding agent to fix; a
  // credential mismatch already offers its prompt on the credential card.
  const fixKind =
    problem && connector.problem &&
    problemTone(connector.problem) === "danger" &&
    connector.problem !== connector.credential?.problem
      ? connector.problem
      : null;
  const statusTone = local ? "warn" : connectorStatusTone(connector.status);
  return (
    <div className={shown ? "conn open" : "conn"} data-connector={id}>
      <div className="conn-head">
        <span className="conn-main">
          <span className={`dot ${local ? "warn" : connector.status}`} aria-hidden="true" />
          <h2 className="conn-name">
            <button
              type="button"
              id={`conn-toggle-${id}`}
              className="conn-toggle"
              aria-expanded={shown ? "true" : "false"}
              aria-controls={`conn-body-${id}`}
              aria-describedby={`conn-state-${id}`}
              onClick={() => setOpen(!shown)}
            >
              {name}
            </button>
          </h2>
          {connector.title ? <span className="conn-id mono">{id}</span> : null}
        </span>
        <span className="conn-badges" id={`conn-state-${id}`}>
          {drift === "warning" ? <Badge tone="warn">drift</Badge> : null}
          <Badge>{authScopeLabel(connector.authScope)}</Badge>
          <Badge>
            {connector.status === "loading"
              ? "tools not loaded"
              : toolCountLabel(connector.toolCount)}
          </Badge>
          <Badge tone={statusTone}>{statusLabel}</Badge>
          <span className="conn-caret" aria-hidden="true" />
        </span>
      </div>
      {/* A plain `hidden`, not `until-found`: WebKit implements the latter
          but still lays out the closed body, and the filter above already
          finds a connector or tool by name. */}
      <div className="conn-body" id={`conn-body-${id}`} hidden={!shown}>
        {connector.description ? (
          <p className="conn-note">{connector.description}</p>
        ) : null}
        {connector.registrationPath ? (
          <p className="meta">OAuth client: {{ cimd: "Client metadata document (CIMD)", dcr: "Dynamic registration (DCR)", static: "Pre-registered client" }[connector.registrationPath]}</p>
        ) : null}
        {/* Fixed copy keyed by the server's classification — never a status
            message, which can quote a downstream error body (see PROBLEM_COPY). */}
        {problem && connector.problem ? (
          <p
            className={problemTone(connector.problem) === "warn" ? "msg warn" : "msg"}
            data-problem={connector.problem}
          >
            {problem}
          </p>
        ) : null}
        {local ? (
          <p className="msg warn" data-load-failure={local}>
            {connectorLoadFailureCopy(local, productName)}
          </p>
        ) : null}
        {connector.authorizationUrl && !safeHttpHref(connector.authorizationUrl) ? (
          <p className="meta">Authorization URL: {connector.authorizationUrl}</p>
        ) : null}
        {manage ? null : <p className="meta">{permissionLabel(connector)}</p>}
        <div className="actions">
          {/* A row that failed on this side of the deployment has one thing to
              try — reading it again — and no authorization to redo. */}
          {local ? null : (
            <AuthActions connector={connector} name={name} manage={manage} state={state} />
          )}
          {fixKind ? <FixPromptButton kind={fixKind} connectorId={id} name={name} /> : null}
          <button
            className={local ? "btn primary" : "btn quiet"}
            type="button"
            aria-label={`Refresh ${name}`}
            disabled={connector.status === "loading"}
            onClick={() => void refreshConnector(id)}
          >
            Refresh
          </button>
        </div>
        {fixKind ? <FixPromptPreview kind={fixKind} connectorId={id} standalone /> : null}
        {oauthConfirm ? (
          <ConfirmBar
            id={id}
            {...confirmCopy(oauthConfirm.action, name)}
            onConfirm={() => {
              if (oauthConfirm.action === "oauth_restart") void startOAuth(id, "restart");
              else void disconnectOAuth(id);
            }}
            onCancel={() =>
              cancelConfirm(
                focusableId(
                  oauthConfirm.action === "oauth_restart" ? `reconnect-${id}` : `disconnect-${id}`,
                  `conn-toggle-${id}`,
                ),
              )
            }
          />
        ) : null}
        <NoticeLine
          id={`oauthNotice-${id}`}
          notice={state.oauthNoticeFor === id ? state.oauthNotice : null}
        />
        {connector.credential ? (
          <CredentialCard
            connector={connector}
            credential={connector.credential}
            editing={state.credentialEditing === id}
            busy={state.credentialBusy === id}
            confirming={confirming?.action === "credential_remove"}
            notice={state.credentialNoticeFor === id ? state.credentialNotice : null}
          />
        ) : null}
        {tools.length ? (
          <details open={forceOpen}>
            <summary className="disclosure">Tools ({tools.length})</summary>
            <div className="tool-list">
              {tools.some((tool) => tool.safety) ? (
                <p className="meta tool-legend">
                  Reads run inside execute_code programs. Writes run in trusted
                  pools, or through call_destructive_tool in read-only pools.
                  Approval belongs to the host.
                </p>
              ) : null}
              <DataTable data={tools} columns={toolColumns} label={`Tools for ${name}`} />
            </div>
          </details>
        ) : null}
        <details>
          <summary className="disclosure">Diagnostics</summary>
          <div className="subcard">
            <DriftPanel connector={connector} />
            {connector.catalogAccess ? (
              <p className="meta">
                Agents last read its catalog{" "}
                {connector.catalogAccess.state === "stale" ? "from a stale cache" : "fresh"}
                {" · "}
                {formatDate(connector.catalogAccess.observedAt)}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}

/**
 * The deployment's endpoint, then one per pool this identity may open. The
 * pool list is what `/ui/data` returned after running each pool's grant, so
 * a pool that would 404 for this reader never appears here.
 */
function Endpoints({
  pools,
  serverName,
}: {
  pools: string[];
  serverName: string | undefined;
}) {
  return (
    <div className="endpoints">
      <Endpoint
        url={mcpUrl}
        name={clientServerName(serverName)}
        primary
        {...(pools.length ? { label: "All tools" } : {})}
      />
      {pools.map((pool) => (
        <Endpoint
          key={pool}
          url={poolEndpointUrl(mcpUrl, pool)}
          name={clientServerName(serverName, pool)}
          label={`Pool · ${pool}`}
        />
      ))}
    </div>
  );
}

/** The deployment's state in one line, above the list it summarizes. */
function SummaryLine({ connectors }: { connectors: UiConnector[] }) {
  const parts = connectorSummaryParts(summarizeConnectors(connectors));
  return (
    <p className="summary" id="connectorSummary">
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 ? <span className="sep"> · </span> : null}
          <span className={part.tone === "neutral" ? "" : part.tone}>{part.text}</span>
        </span>
      ))}
    </p>
  );
}

export function ConnectionsPage({ state }: { state: OperatorState }) {
  const data = state.data;
  const query = state.connectorFilter.trim();
  const filtered = data ? filterUiConnectors(data.connectors, query) : [];
  return (
    <section id="connectionsView">
      <div className="lead">
        <h1 id="connectionsHeading" tabIndex={-1}>
          Connections
        </h1>
        <div className="lead-copy">
          <p>Point an MCP client at this endpoint to reach the tools below.</p>
          <Endpoints pools={data?.pools ?? []} serverName={data?.serverInfo?.name} />
          <p className="cap" id="serverInfo">
            {data
              ? `${data.serverInfo?.name || productName} v${data.connectaVersion || "?"}`
              : productOperatorLabel}
          </p>
          {data ? <SummaryLine connectors={data.connectors} /> : null}
        </div>
      </div>
      <section className="section" aria-labelledby="connectorLedgerHeading">
        <div className="section-head">
          <h2 id="connectorLedgerHeading" tabIndex={-1}>Connectors</h2>
          <input
            id="filter"
            type="search"
            className="filter"
            placeholder="Filter connectors or tools…"
            aria-label="Filter connectors or tools"
            value={state.connectorFilter}
            disabled={!data}
            onInput={(event) => setConnectorFilter(event.currentTarget.value)}
          />
        </div>
        <div
          id="list"
          className={!data || filtered.length === 0 ? "" : "rows"}
          aria-busy={state.refreshing || (!data && !state.loadFailure) ? "true" : "false"}
        >
          {!data ? (
            state.loadFailure ? (
              <LoadFailure state={state} />
            ) : (
              <Empty>Loading connectors…</Empty>
            )
          ) : filtered.length === 0 ? (
            <Empty>
              {query
                ? "No connectors or tools match this filter."
                : "No connectors are declared in this deployment."}
            </Empty>
          ) : (
            filtered.map(({ connector, tools }) => (
              <ConnectorRow
                key={connector.id}
                connector={connector}
                tools={tools}
                forceOpen={Boolean(query)}
                state={state}
              />
            ))
          )}
        </div>
      </section>
    </section>
  );
}
