import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { OperatorState } from "../view.js";
import { activityReadable } from "../view.js";
import { Pill, pillStatus, StateBlock } from "./parts.js";
import { Button, Card, Tabs } from "./primitives.js";
import { Icon } from "./icons.js";
import { ContractState } from "./contract-state.js";
import { useConnectorHealth } from "./health.js";
import { BadgeRow, StatTiles } from "./config-tiles.js";
import { connectorSummary, type ConnectorSummary } from "../config-summary.js";
import { Catalog } from "./catalog.js";
import { ConnectorAuth, ConnectorDiagnostics } from "./connections.js";
import { ActivityPage } from "./activity.js";
import { AuthScopeBadge, ToolSplit } from "./connectors.js";
import { verdictFor } from "./problems.js";
import { refreshConnector, stopConnectorReads } from "./store.js";

const TABS = ["tools", "connection", "activity"];
export function ConnectorDetailPage({ state }: { state: OperatorState }) {
  const location = useLocation();
  const go = useNavigate();
  const id = location.pathname.split("/").pop() ?? "";
  useEffect(() => () => stopConnectorReads(id), [id]);
  const tab = TABS.includes(location.hash) ? location.hash : "tools";
  const health = useConnectorHealth(state);
  const contract = health.contract;
  const config = contract?.config?.connectors.find((c) => c.id === id);
  const live = contract?.live.connectors.find((c) => c.id === id);
  // Auth permissions come from the connector's own /ui/data detail.
  const rawAuth = state.data?.connectors.find((c) => c.id === id);
  const auth = rawAuth ? { ...rawAuth } : undefined;
  if (auth && !auth.permissions?.manageSharedAuth && !auth.permissions?.connectPersonal) delete auth.credential;
  const verdict = live ? verdictFor(id, live, health) : null;
  return (
    <section id="connectorView">
      <a href="/connectors" className="back-link">
        <Icon name="back" size={14} />
        All connectors
      </a>
      <div className="page-heading conn-heading">
        <div className="conn-head">
          <div className="conn-title">
            <h1 id="connectorHeading" tabIndex={-1} title={config?.title ?? "Connector"}>
              {config?.title ?? "Connector"}
            </h1>
            {live ? <Pill status={pillStatus(verdict!.tone)}>{verdict!.label}</Pill> : null}
          </div>
          {config && live ? (
            <div className="conn-badges">
              <code title={id}>{id}</code>
              <AuthScopeBadge scope={config.authScope} />
              <ToolSplit tools={live.tools} />
            </div>
          ) : null}
          {config?.description ? <p className="conn-description">{config.description}</p> : null}
        </div>
        <Button
          onClick={() => void refreshConnector(id)}
          disabled={!state.admissionValid || rawAuth?.status === "loading"}
        >
          Refresh catalog
        </Button>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : !config ? (
        <StateBlock title="Connector unavailable">Not visible to you.</StateBlock>
      ) : !live ? (
        <StateBlock busy title="Loading connection…">
          Waiting for connection details.
        </StateBlock>
      ) : (
        <>
          <Tabs
            label="Connector detail"
            value={tab}
            onValueChange={(value) => {
              void go({ to: location.pathname, search: location.search, hash: value });
            }}
            items={[
              {
                value: "tools",
                label: "Tools",
                content: <Catalog tools={live.tools.map((tool) => ({ ...tool, connectorId: id }))} />,
              },
              {
                value: "connection",
                label: "Connection",
                content: (
                  <div className="collection connection-sections">
                    <Card id={`auth-${id}`} tabIndex={-1} aria-label="Authentication" title="Authentication">
                      {auth ? (
                        <ConnectorAuth connector={auth} state={state} />
                      ) : (
                        <StateBlock busy>Authentication details are loading.</StateBlock>
                      )}
                    </Card>
                    <Card aria-label="Diagnostics" title="Diagnostics">
                      <ConnectorDiagnostics live={live} connector={auth} />
                    </Card>
                    <ConnectorConfigCard
                      summary={connectorSummary(config, contract.configSources ?? {})}
                      name={config.title ?? id}
                    />
                  </div>
                ),
              },
              {
                value: "activity",
                label: "Activity",
                content: (
                  <div className="connector-activity">
                    {activityReadable(state) ? (
                      <ActivityPage state={state} connectorId={id} />
                    ) : (
                      <StateBlock>Activity isn't available.</StateBlock>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}

/** What the connector is and how it signs in, as badges, and its limits as tiles. Defined in code; nothing here edits it. */
function ConnectorConfigCard({ summary, name }: { summary: ConnectorSummary; name: string }) {
  return (
    <Card aria-label="Connector configuration" title="Configuration" className="connector-config">
      <BadgeRow badges={summary.badges} label={`${name} setup`} />
      {summary.auth.length ? <BadgeRow badges={summary.auth} label={`${name} auth`} /> : null}
      <StatTiles tiles={summary.tiles} compact label={`${name} settings`} />
    </Card>
  );
}
