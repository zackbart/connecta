import { CredentialCard } from "./credentials.js";
import { filterUiConnectors, type UiConnector } from "../model.js";
import {
  authScopeLabel,
  connectorStatusLabel,
  connectorStatusTone,
  connectorSummaryParts,
  driftCounts,
  driftState,
  driftSummary,
  formatDate,
  permissionLabel,
  problemCopy,
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
import { Badge, CopyButton, Empty, FixPrompt, NoticeLine } from "./parts.js";
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
    <>
    {/* Kept outside the counted panel, so the panel stays counts only. */}
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
    <span class="tool-safety" title={badge.title} data-safety={safety}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </span>
  );
}

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
    <div class="endpoint-block" data-endpoint={name}>
      <div class="endpoint">
        {label ? <span class="endpoint-label cap">{label}</span> : null}
        <code {...(primary ? { id: "mcpUrl" } : {})} class="mono">
          {url}
        </code>
        <CopyButton
          value={url}
          label="Copy URL"
          {...(label ? { ariaLabel: `Copy URL for ${label}` } : {})}
        />
      </div>
      <details class="setup">
        <summary class="disclosure">
          Client setup{label ? ` · ${label}` : ""}
        </summary>
        <div class="setup-list">
          {clientSetupCommands(name, url).map((command) => (
            <div class="setup-item" key={command.id} data-setup={command.id}>
              <div class="setup-head">
                <span class="cap">{command.label}</span>
                <CopyButton
                  value={command.text}
                  label="Copy"
                  class="btn quiet"
                  ariaLabel={`Copy ${command.label} setup${label ? ` for ${label}` : ""}`}
                />
              </div>
              <pre class="setup-code">{command.text}</pre>
            </div>
          ))}
          <p class="meta">
            No token is included. Clients sign in through this deployment's inbound auth.
          </p>
        </div>
      </details>
    </div>
  );
}

/**
 * One connector as a single line until an operator asks for more. The closed
 * row shows state, tool count, and who owns the authentication; everything
 * that needs reading or acting on is in the body, which keeps a twenty-
 * connector deployment to one screen.
 *
 * The disclosure is a native `<details>` and not store state, so an identity
 * change cannot leave one connector's panel open over another's data.
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
  // A connector being refreshed has no settled problem yet; the last one would
  // describe a state the page is no longer showing.
  const problem =
    connector.status === "loading" ? null : problemCopy(connector.problem);
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
        {/* Fixed copy keyed by the server's classification — never a status
            message, which can quote a downstream error body (see PROBLEM_COPY). */}
        {problem ? (
          <p class="msg" data-problem={connector.problem}>{problem}</p>
        ) : null}
        {/* A credential mismatch is also on the credential card; one prompt is enough. */}
        {problem && connector.problem &&
        connector.problem !== connector.credential?.problem ? (
          <FixPrompt kind={connector.problem} connectorId={connector.id} name={name} />
        ) : null}
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
              {tools.some((tool) => tool.safety) ? (
                <p class="meta tool-legend">
                  Read-only tools run inside execute_code programs. Everything
                  else asks the host first: a program pauses for
                  resume_execution, and a direct call goes through
                  call_destructive_tool — unless this deployment's config
                  exempts the tool, in which case programs call it unasked.
                </p>
              ) : null}
              {tools.map((tool) => (
                <div class="tool" key={tool.address}>
                  <div class="tool-head">
                    <code>{tool.address}</code>
                    <SafetyBadge safety={tool.safety} />
                  </div>
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
    <div class="endpoints">
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
    <p class="summary" id="connectorSummary">
      {parts.map((part, index) => (
        <span key={part.text}>
          {index > 0 ? <span class="sep"> · </span> : null}
          <span class={part.tone === "neutral" ? "" : part.tone}>{part.text}</span>
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
      <div class="lead">
        <h1 id="connectionsHeading" tabIndex={-1}>
          Connections
        </h1>
        <div class="lead-copy">
          <p>Point an MCP client at this endpoint to reach the tools below.</p>
          <Endpoints pools={data?.pools ?? []} serverName={data?.serverInfo?.name} />
          <p class="cap" id="serverInfo">
            {data
              ? `${data.serverInfo?.name || productName} v${data.connectaVersion || "?"}`
              : productOperatorLabel}
          </p>
          {data ? <SummaryLine connectors={data.connectors} /> : null}
          <NoticeLine id="oauthNotice" notice={state.oauthNotice} />
          <NoticeLine id="credentialNotice" notice={state.credentialNotice} />
        </div>
      </div>
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
