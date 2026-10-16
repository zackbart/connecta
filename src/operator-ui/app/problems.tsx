import type { OperatorConnectorOverlay } from "../contract.js";
import { connectorVerdict, driftState, type OperatorState } from "../view.js";
import { followLink, Pill, pillStatus } from "./parts.js";

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
  const verdict = connectorVerdict(live, {
    failed: Boolean(state.connectorFailures[id]),
    drift: driftState(state.data?.connectors.find((c) => c.id === id)?.catalogDrift) === "warning",
  });
  const href = `/connectors/${encodeURIComponent(id)}#connection`;
  return (
    <div className="inline-problems">
      <Pill status={pillStatus(verdict.tone)}>{verdict.label}</Pill>
      {verdict.action ? (
        <a
          className="btn sm problem-action"
          href={href}
          aria-label={`${verdict.action} ${name}`}
          onClick={(event) => followLink(event, href, "connector")}
        >
          {verdict.action}
        </a>
      ) : null}
    </div>
  );
}
