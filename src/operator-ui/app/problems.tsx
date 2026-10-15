import type { OperatorConnectorOverlay } from "../contract.js";
import { connectorStatusLabel, connectorStatusTone, driftState, type OperatorState } from "../view.js";
import { Badge, FixPromptButton } from "./parts.js";

/** Only typed problem facts appear here; auth actions remain on Connection. */
export function ConnectorProblems({
  id,
  live,
  state,
  name,
}: {
  id: string;
  live: OperatorConnectorOverlay;
  state: OperatorState;
  name?: string;
}) {
  const raw = state.data?.connectors.find((c) => c.id === id);
  const drift = driftState(raw?.catalogDrift) === "warning";
  const local = state.connectorFailures[id];
  return (
    <div className="inline-problems">
      {name ? <span>{name}</span> : null}
      <Badge tone={local ? "warn" : connectorStatusTone(live.status)}>
        {local ? "Couldn't load" : connectorStatusLabel(live.status, live.problem)}
      </Badge>
      {live.status !== "ok" || live.problem || local ? (
        <a className="problem-action" href={`/connectors/${encodeURIComponent(id)}#connection`}>
          {live.status === "auth_required" || live.status === "credential_required"
            ? "Connect / fix"
            : "Inspect connection"}
        </a>
      ) : null}
      {live.problem ? <FixPromptButton kind={live.problem} connectorId={id} /> : null}
      {drift ? (
        <>
          <Badge tone="warn">Catalog drift</Badge>
          <FixPromptButton kind="catalog_drift" connectorId={id} />
        </>
      ) : null}
    </div>
  );
}
