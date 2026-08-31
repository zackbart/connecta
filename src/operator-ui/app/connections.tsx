import { filterUiConnectors, type UiConnector } from "../model.js";
import {
  connectorStatusLabel,
  driftCounts,
  driftState,
  driftSummary,
  safeHttpHref,
  toolCountLabel,
  type OperatorState,
} from "../view.js";
import { mcpUrl, productName, productOperatorLabel } from "./config.js";
import { CopyButton, Empty, NoticeLine, PageLink } from "./parts.js";
import { oauthAction, setConnectorFilter } from "./store.js";

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
    <div
      id={`drift-${connector.id}`}
      class={`connector-drift ${state}`}
      data-drift={state}
    >
      <p class="cap">{DRIFT_HEADING[state]}</p>
      <p class="meta drift-summary">{driftSummary(drift)}</p>
      {state === "unavailable" ? null : (
        <ul class="drift-counts">
          {driftCounts(drift).map(({ key, label, count }) => (
            <li key={key} class={count > 0 ? "drift-count flagged" : "drift-count"}>
              <span class="drift-count-value">{count}</span>
              <span class="drift-count-label">{label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectorCard({
  connector,
  tools,
  expanded,
  oauthManagement,
  busy,
}: {
  connector: UiConnector;
  tools: UiConnector["tools"];
  expanded: boolean;
  oauthManagement: boolean;
  busy: boolean;
}) {
  const name = connector.title || connector.id;
  const authorization = safeHttpHref(connector.authorizationUrl);
  return (
    <div class="card">
      <div class="connector-head">
        <div>
          <div class="connector-title">
            <span class={`dot ${connector.status}`} aria-hidden="true" />
            <h2>{name}</h2>
          </div>
          {connector.description ? (
            <p class="connector-description meta">{connector.description}</p>
          ) : null}
        </div>
        <div class="connector-state cap">
          {connectorStatusLabel(connector.status)} ·{" "}
          {toolCountLabel(connector.toolCount)}
          <br />
          <span class="mono">{connector.id}</span>
          <br />
          <span>
            {connector.authScope === "personal" ? "personal auth" : "shared auth"}
          </span>
        </div>
      </div>
      {connector.message ? (
        <p class="connector-message msg">{connector.message}</p>
      ) : null}
      {connector.authorizationUrl ? (
        <p class={authorization ? "connector-auth" : "connector-auth meta"}>
          {authorization ? (
            <a
              class="linklike"
              href={authorization}
              target="_blank"
              rel="noopener"
            >
              Authorize connector →
            </a>
          ) : (
            `Authorization URL: ${connector.authorizationUrl}`
          )}
        </p>
      ) : null}
      <DriftPanel connector={connector} />
      {connector.catalogAccess ? (
        <p class="meta">
          Last agent catalog read · {connector.catalogAccess.state} ·{" "}
          {new Date(connector.catalogAccess.observedAt).toLocaleString()}
        </p>
      ) : null}
      {connector.oauth && oauthManagement ? (
        <div class="credential-actions">
          <button
            type="button"
            class="linklike danger"
            aria-label={`Disconnect OAuth for ${name}`}
            disabled={busy}
            onClick={() => void oauthAction(connector.id, "disconnect")}
          >
            Disconnect OAuth
          </button>
          <button
            type="button"
            class="linklike"
            aria-label={`${
              connector.status === "ok"
                ? "Reconnect OAuth for"
                : "Restart authorization for"
            } ${name}`}
            disabled={busy}
            onClick={() => void oauthAction(connector.id, "reconnect")}
          >
            {connector.status === "ok"
              ? "Reconnect OAuth"
              : "Restart authorization"}
          </button>
        </div>
      ) : null}
      {connector.credential ? (
        <p class="connector-auth">
          <PageLink page="credentials" class="linklike">
            Manage credential →
          </PageLink>
        </p>
      ) : null}
      {tools.length ? (
        <details open={expanded}>
          <summary class="linklike">Show tools ({tools.length})</summary>
          <div class="tool-list">
            {tools.map((tool) => (
              <div class="tool" key={tool.address}>
                <code>{tool.address}</code>
                {tool.description ? (
                  <span class="td">{tool.description}</span>
                ) : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

export function ConnectionsPage({ state }: { state: OperatorState }) {
  const data = state.data;
  const query = state.connectorFilter.trim();
  const filtered = data ? filterUiConnectors(data.connectors, query) : [];
  return (
    <section id="connectionsView">
      <div class="lead pgrid">
        <h1 id="connectionsHeading" class="pcap" tabIndex={-1}>
          Connections
        </h1>
        <div class="pbody lead-copy">
          <p>Use this endpoint to give an MCP client access to the tools below.</p>
          <div class="endpoint">
            <div class="endpoint-row">
              <code id="mcpUrl" class="mono">
                {mcpUrl}
              </code>
              <CopyButton value={mcpUrl} label="Copy URL" />
            </div>
          </div>
          <p class="cap" id="serverInfo">
            {data
              ? `${data.serverInfo?.name || productName} v${data.connectaVersion || "?"}`
              : productOperatorLabel}
          </p>
          <NoticeLine id="oauthNotice" notice={state.oauthNotice} />
        </div>
      </div>
      <section class="section pgrid" aria-labelledby="connectorLedgerHeading">
        <h2 class="pcap" id="connectorLedgerHeading">
          Connectors
        </h2>
        <div class="pbody">
          <div class="row toolbar">
            <input
              id="filter"
              type="search"
              placeholder="Filter connectors or tools…"
              aria-label="Filter connectors or tools"
              value={state.connectorFilter}
              onInput={(event) =>
                setConnectorFilter(event.currentTarget.value)
              }
            />
          </div>
          <div
            id="list"
            class="connector-tools"
            aria-busy={state.refreshing || !data ? "true" : "false"}
          >
            {!data ? (
              <Empty>Loading connectors…</Empty>
            ) : filtered.length === 0 ? (
              <Empty>
                {query
                  ? "No connectors or tools match this filter."
                  : "No connectors are declared in this deployment."}
              </Empty>
            ) : (
              filtered.map(({ connector, tools }) => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  tools={tools}
                  expanded={Boolean(query)}
                  oauthManagement={data.oauthManagement}
                  busy={state.oauthBusy === connector.id}
                />
              ))
            )}
          </div>
        </div>
      </section>
    </section>
  );
}
