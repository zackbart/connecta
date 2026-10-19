import type { OperatorConnectorOverlay } from "../contract.js";
import type { ConnectorHealth } from "../health.js";
import { connectorVerdict, type ConnectorVerdict } from "../view.js";
import { followLink, Pill, pillStatus } from "./parts.js";

/** A connector's verdict from what this page knows: its steady live row, and a failed detail read. */
export function verdictFor(id: string, live: OperatorConnectorOverlay, health: ConnectorHealth): ConnectorVerdict {
  return connectorVerdict(live, Object.hasOwn(health.signals, id) ? health.signals[id] : undefined);
}

/** The one way forward for a connector that needs attention: a link to its Connection tab. */
export function ProblemAction({ id, name, action }: { id: string; name: string; action: string }) {
  const href = `/connectors/${encodeURIComponent(id)}#connection`;
  return (
    <a
      className="btn sm problem-action"
      href={href}
      aria-label={`${action} ${name}`}
      onClick={(event) => followLink(event, href, "connector")}
    >
      {action}
    </a>
  );
}

/**
 * One badge per connector, and at most one way forward beside it. Fix prompts
 * and the full account of a problem stay on the connector's Connection tab.
 */
export function ConnectorStatus({
  id,
  name,
  live,
  health,
  compact,
}: {
  id: string;
  name: string;
  live: OperatorConnectorOverlay;
  health: ConnectorHealth;
  /** Only a dot, and only when something needs fixing: the dot is the action's link. */
  compact?: boolean;
}) {
  const verdict = verdictFor(id, live, health);
  const href = `/connectors/${encodeURIComponent(id)}#connection`;
  if (compact) {
    return verdict.action ? (
      <a
        className="status-dot-link"
        href={href}
        title={verdict.label}
        aria-label={`${verdict.action} ${name}`}
        onClick={(event) => followLink(event, href, "connector")}
      >
        <span className={`dot ${verdict.tone}`} aria-hidden="true" />
      </a>
    ) : null;
  }
  return (
    <div className="inline-problems">
      <Pill status={pillStatus(verdict.tone)}>{verdict.label}</Pill>
      {verdict.action ? <ProblemAction id={id} name={name} action={verdict.action} /> : null}
    </div>
  );
}
