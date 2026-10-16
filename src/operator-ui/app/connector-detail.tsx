import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { OperatorState } from "../view.js";
import { activityReadable, connectorSourceLabel, connectorVerdict, driftState, formatDate } from "../view.js";
import { Pill, pillStatus, StateBlock, SummaryRow } from "./parts.js";
import { Button, Card, Tabs } from "./primitives.js";
import { Icon } from "./icons.js";
import { ContractState, maintainerContract } from "./contract-state.js";
import { SnapshotTree } from "./snapshot.js";
import { Catalog } from "./catalog.js";
import { ConnectorAuth, ConnectorDiagnostics } from "./connections.js";
import { ActivityPage } from "./activity.js";
import { loadOperatorContract, stopConnectorReads } from "./store.js";

const TABS = ["tools", "connection", "activity"];
export function ConnectorDetailPage({ state }: { state: OperatorState }) {
  const location = useLocation();
  const go = useNavigate();
  const id = location.pathname.split("/").pop() ?? "";
  useEffect(() => () => stopConnectorReads(id), [id]);
  const tab = TABS.includes(location.hash) ? location.hash : "tools";
  const contract = maintainerContract(state);
  const config = contract?.config?.connectors.find((c) => c.id === id);
  const live = contract?.live.connectors.find((c) => c.id === id);
  // Auth permissions come from the connector's own /ui/data detail.
  const rawAuth = state.data?.connectors.find((c) => c.id === id);
  const auth = rawAuth ? { ...rawAuth } : undefined;
  if (auth && !auth.permissions?.manageSharedAuth && !auth.permissions?.connectPersonal) delete auth.credential;
  const verdict = live
    ? connectorVerdict(live, {
        failed: Boolean(state.connectorFailures[id]),
        drift: driftState(rawAuth?.catalogDrift) === "warning",
      })
    : null;
  return (
    <section id="connectorView">
      <a href="/connectors" className="back-link">
        <Icon name="back" size={14} />
        All connectors
      </a>
      <div className="page-heading">
        <h1 id="connectorHeading" tabIndex={-1}>
          {config?.title ?? "Connector"}
        </h1>
        <Button onClick={() => void loadOperatorContract()} disabled={state.contractPhase === "loading"}>
          Refresh catalog
        </Button>
      </div>
      {!contract ? (
        <ContractState state={state} />
      ) : !config || !live ? (
        <StateBlock title="Connector unavailable">This connector is not visible to your session.</StateBlock>
      ) : (
        <>
          <div className="facts-row conn-head">
            <code>{id}</code>
            <Pill status={pillStatus(verdict!.tone)}>{verdict!.label}</Pill>
            <span className="meta">{config.authScope === "personal" ? "Personal" : "Shared"} auth</span>
            <span className="meta">{live.tools.length} tools</span>
          </div>
          {config.description ? <p className="meta catalog-description">{config.description}</p> : null}
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
                      <SummaryRow
                        items={[
                          {
                            label: "Catalog age",
                            value:
                              live.catalogAgeMs === null
                                ? "Not observed"
                                : `${Math.round(live.catalogAgeMs / 1000)} seconds`,
                          },
                          {
                            label: "Last call",
                            value: live.lastCall
                              ? `${formatDate(live.lastCall.at)} · ${live.lastCall.outcome}`
                              : "Not observed",
                          },
                        ]}
                      />
                      {auth ? (
                        <ConnectorDiagnostics connector={auth} />
                      ) : (
                        <StateBlock busy>Diagnostics are loading.</StateBlock>
                      )}
                    </Card>
                    <Card
                      aria-label="Connector configuration"
                      title="Configuration"
                      description={`Source: ${connectorSourceLabel(config.source)}. Defined in deployment code.`}
                    >
                      <SnapshotTree
                        value={config}
                        path={`config.connectors.${id}`}
                        sources={contract.configSources ?? undefined}
                      />
                    </Card>
                  </div>
                ),
              },
              {
                value: "activity",
                label: "Activity",
                content: activityReadable(state) ? (
                  <ActivityPage state={state} connectorId={id} />
                ) : (
                  <StateBlock>Activity is not available to this session.</StateBlock>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
