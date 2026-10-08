import { useLocation, useNavigate } from "@tanstack/react-router";
import type { OperatorState } from "../view.js";
import { connectorStatusLabel, connectorStatusTone, formatDate } from "../view.js";
import { Badge, StateBlock } from "./parts.js";
import { Button, Tabs } from "./primitives.js";
import { ContractState } from "./overview.js";
import { SnapshotTree } from "./snapshot.js";
import { Catalog } from "./catalog.js";
import { ConnectorAuth, ConnectorDiagnostics } from "./connections.js";
import { ActivityPage } from "./activity.js";
import { loadOperatorContract } from "./store.js";

const TABS = ["config", "tools", "auth", "activity", "diagnostics"];
export function ConnectorDetailPage({ state }: { state: OperatorState }) {
  const location = useLocation();
  const go = useNavigate();
  const id = location.pathname.split("/").pop() ?? "";
  const tab = TABS.includes(location.hash) ? location.hash : "config";
  const contract = state.contract;
  const config = contract?.config.connectors.find((c) => c.id === id);
  const live = contract?.live.connectors.find((c) => c.id === id);
  const rawAuth = state.data?.connectors.find((c) => c.id === id);
  const permission = contract?.you.permissions.connectors.find((c) => c.id === id);
  const auth = rawAuth && permission ? { ...rawAuth, permissions: permission } : undefined;
  if (auth && !permission?.manageSharedAuth && !permission?.connectPersonal) delete auth.credential;
  return (
    <section id="connectorView">
      <a href="/connectors" className="meta">
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
            <Badge tone={state.connectorFailures[id] ? "warn" : connectorStatusTone(live.status)}>
              {state.connectorFailures[id] ? "Couldn't load" : connectorStatusLabel(live.status, live.problem)}
            </Badge>
            <Badge>{config.authScope} auth</Badge>
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
                value: "config",
                label: "Config",
                content: (
                  <>
                    <p className="meta">Defined in deployment code.</p>
                    <SnapshotTree value={config} path={`config.connectors.${id}`} sources={contract.configSources} />
                  </>
                ),
              },
              {
                value: "tools",
                label: "Tools",
                content: <Catalog tools={live.tools.map((tool) => ({ ...tool, connectorId: id }))} />,
              },
              {
                value: "auth",
                label: "Auth",
                content: (
                  <section id={`auth-${id}`} tabIndex={-1}>
                    {auth ? (
                      <ConnectorAuth connector={auth} state={state} />
                    ) : (
                      <StateBlock>Authentication details are loading.</StateBlock>
                    )}
                  </section>
                ),
              },
              {
                value: "activity",
                label: "Activity",
                content: contract.you.permissions.activity ? (
                  <ActivityPage state={state} connectorId={id} />
                ) : (
                  <StateBlock>Activity is not available to this session.</StateBlock>
                ),
              },
              {
                value: "diagnostics",
                label: "Diagnostics",
                content: (
                  <div className="collection">
                    <div className="facts-row">
                      <span>
                        {"Catalog age: "}
                        {live.catalogAgeMs === null
                          ? "Not observed"
                          : `${Math.round(live.catalogAgeMs / 1000)} seconds`}
                      </span>
                      <span>
                        {"Last call: "}
                        {live.lastCall ? `${formatDate(live.lastCall.at)} · ${live.lastCall.outcome}` : "Not observed"}
                      </span>
                    </div>
                    {auth ? (
                      <ConnectorDiagnostics connector={auth} state={state} />
                    ) : (
                      <StateBlock>Diagnostics are loading.</StateBlock>
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
