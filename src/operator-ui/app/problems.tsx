import type { OperatorConnectorOverlay } from "../contract.js";
import { connectorStatusLabel, connectorStatusTone, driftState, type OperatorState } from "../view.js";
import { Badge } from "./parts.js";
import { navigate } from "./store.js";

/**
 * One badge per connector, and at most one way forward beside it. Fix prompts
 * and the full account of a problem stay on the connector's Connection tab.
 */
export function ConnectorStatus({
  id,
  name,
  live,
  state,
}: {
  id: string;
  name: string;
  live: OperatorConnectorOverlay;
  state: OperatorState;
}) {
  const local = state.connectorFailures[id];
  const drift = driftState(state.data?.connectors.find((c) => c.id === id)?.catalogDrift) === "warning";
  const failing = live.status !== "ok" || Boolean(live.problem);
  const label = local
    ? "Couldn't load"
    : failing
      ? connectorStatusLabel(live.status, live.problem)
      : drift
        ? "Catalog drift"
        : connectorStatusLabel(live.status);
  const tone = local || (!failing && drift) ? "warn" : connectorStatusTone(live.status);
  const action = local || failing || drift ? statusAction(live) : null;
  const href = `/connectors/${encodeURIComponent(id)}#connection`;
  return (
    <div className="inline-problems">
      <Badge tone={tone}>{label}</Badge>
      {action ? (
        <a
          className="btn quiet problem-action"
          href={href}
          aria-label={`${action} ${name}`}
          onClick={(event) => {
            if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            navigate("connector", href);
          }}
        >
          {action}
        </a>
      ) : null}
    </div>
  );
}

function statusAction(live: OperatorConnectorOverlay): string {
  if (live.problem === "credential_mismatch") return "Replace key";
  if (
    live.status === "auth_required" ||
    live.status === "credential_required" ||
    live.problem === "oauth_required" ||
    live.problem === "credential_required" ||
    live.problem === "auth_required"
  ) {
    return "Connect";
  }
  return "Inspect";
}
