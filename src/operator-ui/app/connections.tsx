import { CredentialCard } from "./credentials.js";
import { filterUiConnectors, type UiConnector } from "../model.js";
import {
  authScopeLabel,
  connectorStatusLabel,
  connectorStatusTone,
  driftCounts,
  driftState,
  driftSummary,
  formatDate,
  permissionLabel,
  safeHttpHref,
  summarizeConnectors,
  toolCountLabel,
  type OperatorState,
} from "../view.js";
import { mcpUrl, productName, productOperatorLabel } from "./config.js";
import { Badge, CopyButton, Empty, NoticeLine, Stat } from "./parts.js";
import { oauthAction, refreshConnector, setConnectorFilter } from "./store.js";

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
      <p class="meta">{driftSummary(drift)}</p>
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

/**
 * One connector, as a single line until an operator asks for more. The closed
 * row carries only what is true at a glance — state, tool count, who owns the
 * authentication — and everything that needs reading or acting on lives in the
 * body. A list of twenty connectors should still be one screen.
 *
 * The disclosure is a native `<details>` rather than store state on purpose:
 * open rows are a browser concern, and keeping them out of the store means an
 * identity change cannot leave one connector's panel open over another's data.
 */
function ConnectorRow({
  connector,
  tools,
  expanded,
  oauthManagement,
  busy,
  state,
}: {
  connector: UiConnector;
  tools: UiConnector["tools"];
  expanded: boolean;
  oauthManagement: boolean;
  busy: boolean;
  state: OperatorState;
}) {
  const name = connector.title || connector.id;
  const authorization = safeHttpHref(connector.authorizationUrl);
  const drift = driftState(connector.catalogDrift);
  return (
    <details class="conn" open={expanded}>
      <summary class="conn-head">
        <span class="conn-main">
          <span class={`dot ${connector.status}`} aria-hidden="true" />
          <h2 class="conn-name">{name}</h2>
          {connector.title ? (
            <span class="conn-id mono">{connector.id}</span>
          ) : null}
        </span>
        <span class="conn-badges">
          {drift === "warning" ? <Badge tone="warn">drift</Badge> : null}
          <Badge>{authScopeLabel(connector.authScope)}</Badge>
          <Badge>
            {connector.status === "loading"
              ? "tools not loaded"
              : toolCountLabel(connector.toolCount)}
          </Badge>
          <Badge tone={connectorStatusTone(connector.status)}>
            {connectorStatusLabel(connector.status)}
          </Badge>
          <span class="conn-caret" aria-hidden="true" />
        </span>
      </summary>
      <div class="conn-body">
        {connector.description ? (
          <p class="conn-note">{connector.description}</p>
        ) : null}
        {connector.message ? <p class="msg">{connector.message}</p> : null}
        {connector.authorizationUrl && !authorization ? (
          <p class="meta">Authorization URL: {connector.authorizationUrl}</p>
        ) : null}
        <p class="meta">{permissionLabel(connector)}</p>
        <div class="actions">
          {authorization ? (
            <a class="btn primary" href={authorization} target="_blank" rel="noopener">
              Authorize connector
            </a>
          ) : null}
          {connector.oauth && oauthManagement ? (
            <>
              <button
                type="button"
                class="btn"
                aria-label={`${
                  connector.status === "ok"
                    ? "Reconnect OAuth for"
                    : "Restart authorization for"
                } ${name}`}
                disabled={busy}
                onClick={() => void oauthAction(connector.id, "reconnect")}
              >
                {connector.status === "ok" ? "Reconnect OAuth" : "Connect account"}
              </button>
              {connector.status === "ok" ? (
                <button
                  type="button"
                  class="btn danger"
                  aria-label={`Disconnect OAuth for ${name}`}
                  disabled={busy}
                  onClick={() => void oauthAction(connector.id, "disconnect")}
                >
                  Disconnect OAuth
                </button>
              ) : null}
            </>
          ) : null}
          <button
            class="btn quiet"
            type="button"
            aria-label={`Refresh ${name}`}
            disabled={connector.status === "loading"}
            onClick={() => void refreshConnector(connector.id)}
          >
            Refresh
          </button>
        </div>
        {connector.credential ? (
          <CredentialCard
            connector={connector}
            credential={connector.credential}
            editing={state.credentialEditing === connector.id}
            busy={state.credentialBusy === connector.id}
          />
        ) : null}
        {tools.length ? (
          <details open={expanded}>
            <summary class="disclosure">Tools ({tools.length})</summary>
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
        <details>
          <summary class="disclosure">Diagnostics</summary>
          <div class="subcard">
            <DriftPanel connector={connector} />
            {connector.catalogAccess ? (
              <p class="meta">
                Last agent catalog read · {connector.catalogAccess.state} ·{" "}
                {formatDate(connector.catalogAccess.observedAt)}
              </p>
            ) : null}
          </div>
        </details>
      </div>
    </details>
  );
}

/**
 * The deployment's state above the list it summarizes. Zeros are still shown:
 * "nothing needs attention" is the answer an operator opened this page for, and
 * hiding the tile would make its absence mean either that or a bug.
 */
function SummaryStrip({ connectors }: { connectors: UiConnector[] }) {
  const summary = summarizeConnectors(connectors);
  return (
    <div class="stats" id="connectorSummary">
      <Stat value={summary.connected} label="Connected" tone="ok" />
      <Stat
        value={summary.attention}
        label="Need authorization"
        tone={summary.attention > 0 ? "warn" : "neutral"}
      />
      <Stat
        value={summary.unavailable}
        label="Unavailable"
        tone={summary.unavailable > 0 ? "danger" : "neutral"}
      />
      <Stat value={summary.tools} label="Tools available" />
    </div>
  );
}

export function ConnectionsPage({ state }: { state: OperatorState }) {
  const data = state.data;
  const query = state.connectorFilter.trim();
  const filtered = data ? filterUiConnectors(data.connectors, query) : [];
  return (
    <section id="connectionsView">
      <div class="lead">
        <h1 id="connectionsHeading" tabIndex={-1}>
          Connections
        </h1>
        <div class="lead-copy">
          <p>Point an MCP client at this endpoint to reach the tools below.</p>
          <div class="endpoint">
            <code id="mcpUrl" class="mono">
              {mcpUrl}
            </code>
            <CopyButton value={mcpUrl} label="Copy URL" />
          </div>
          <p class="cap" id="serverInfo">
            {data
              ? `${data.serverInfo?.name || productName} v${data.connectaVersion || "?"}`
              : productOperatorLabel}
          </p>
          <NoticeLine id="oauthNotice" notice={state.oauthNotice} />
          <NoticeLine id="credentialNotice" notice={state.credentialNotice} />
        </div>
      </div>
      {data ? <SummaryStrip connectors={data.connectors} /> : null}
      <section class="section" aria-labelledby="connectorLedgerHeading">
        <div class="section-head">
          <h2 id="connectorLedgerHeading">Connectors</h2>
          <input
            id="filter"
            type="search"
            class="filter"
            placeholder="Filter connectors or tools…"
            aria-label="Filter connectors or tools"
            value={state.connectorFilter}
            onInput={(event) => setConnectorFilter(event.currentTarget.value)}
          />
        </div>
        <div
          id="list"
          class={!data || filtered.length === 0 ? "" : "rows"}
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
              <ConnectorRow
                key={connector.id}
                connector={connector}
                tools={tools}
                expanded={Boolean(query)}
                oauthManagement={Boolean(
                  connector.permissions?.manageSharedAuth ||
                    connector.permissions?.connectPersonal,
                )}
                state={state}
                busy={state.oauthBusy === connector.id}
              />
            ))
          )}
        </div>
      </section>
    </section>
  );
}
