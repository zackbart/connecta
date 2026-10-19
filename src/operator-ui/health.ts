import type { OperatorConnectorOverlay, OperatorUiContractV2 } from "./contract.js";
import type { ConnectorSignals, OperatorState } from "./view.js";

/**
 * Connector health as the page shows it, steadied across detail reads. A
 * connector whose `/ui/data` row is `loading` is being read again; until that
 * read settles, every view keeps the verdict it last showed for that
 * connector instead of an intermediate one. Other connectors update as their
 * own reads settle, so one slow read never holds back the rest. Pure, so a
 * test steps through a refresh without a browser.
 */

/** What one connector's verdict is read from: its live row and a failed detail read on this page. */
interface HealthEvidence {
  live: OperatorConnectorOverlay;
  failed: boolean;
}

/** The evidence each view shows, for one signed-in identity. */
export interface SteadyHealth {
  generation: number;
  rows: Readonly<Record<string, HealthEvidence>>;
}

/** The health inputs a view reads: the contract with steadied live rows, and failed-read signals. */
export interface ConnectorHealth {
  contract: OperatorUiContractV2 | null;
  signals: Readonly<Record<string, ConnectorSignals>>;
}

type HealthState = Pick<OperatorState, "generation" | "contract" | "data" | "connectorFailures">;

/**
 * The next steady evidence. A settled connector takes its current row; one
 * being read again keeps its previous evidence when this identity has any.
 * Returns `previous` itself when nothing changed, so it can live in React
 * state. A new identity starts empty.
 */
export function steadyHealth(state: HealthState, previous: SteadyHealth | null): SteadyHealth {
  const same = previous?.generation === state.generation ? previous : null;
  const contract = state.contract?.role === "maintainer" && state.data ? state.contract : null;
  // No contract on screen: keep what was shown until the next one arrives.
  if (!contract || !state.data) return same ?? { generation: state.generation, rows: Object.create(null) };
  const reading = new Set(state.data.connectors.filter((c) => c.status === "loading").map((c) => c.id));
  const held: Readonly<Record<string, HealthEvidence>> = same?.rows ?? Object.create(null);
  const rows: Record<string, HealthEvidence> = Object.create(null);
  let changed = !same || Object.keys(held).length !== contract.live.connectors.length;
  for (const live of contract.live.connectors) {
    const before = Object.hasOwn(held, live.id) ? held[live.id] : undefined;
    if (before && reading.has(live.id)) {
      rows[live.id] = before;
      continue;
    }
    const failed = Object.hasOwn(state.connectorFailures, live.id) && Boolean(state.connectorFailures[live.id]);
    if (before?.live === live && before.failed === failed) rows[live.id] = before;
    else {
      rows[live.id] = { live, failed };
      changed = true;
    }
  }
  return changed ? { generation: state.generation, rows } : same!;
}

/** The contract each view renders health from, with every live row replaced by its steady evidence. */
export function shownHealth(contract: OperatorUiContractV2 | null, health: SteadyHealth): ConnectorHealth {
  const signals: Record<string, ConnectorSignals> = Object.create(null);
  if (!contract) return { contract, signals };
  let replaced = false;
  const connectors = contract.live.connectors.map((live) => {
    const row = Object.hasOwn(health.rows, live.id) ? health.rows[live.id] : undefined;
    if (row?.failed) signals[live.id] = { failed: true };
    if (!row || row.live === live) return live;
    replaced = true;
    return row.live;
  });
  return {
    contract: replaced ? { ...contract, live: { ...contract.live, connectors } } : contract,
    signals,
  };
}
