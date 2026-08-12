import { filterUiConnectors, type UiConnector } from "../model.js";
import {
  connectorStatusLabel,
  safeHttpHref,
  toolCountLabel,
  type OperatorState,
} from "../view.js";
import { mcpUrl, productName, productOperatorLabel } from "./config.js";
import { CopyButton, Empty, NoticeLine, PageLink } from "./parts.js";
import { oauthAction, setConnectorFilter } from "./store.js";

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
