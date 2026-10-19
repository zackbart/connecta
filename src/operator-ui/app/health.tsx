import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { shownHealth, steadyHealth, type ConnectorHealth, type SteadyHealth } from "../health.js";
import type { OperatorState } from "../view.js";
import { maintainerContract } from "./contract-state.js";

const HealthContext = createContext<SteadyHealth | null>(null);

/**
 * Holds the steady connector health above the pages, so it survives
 * navigation: a connector being read again shows the same verdict on every
 * page until its read settles.
 */
export function HealthProvider({ state, children }: { state: OperatorState; children: ReactNode }) {
  const [held, setHeld] = useState<SteadyHealth | null>(null);
  const health = steadyHealth(state, held);
  // Derived from the previous render: React re-renders before committing.
  if (health !== held) setHeld(health);
  return <HealthContext.Provider value={health}>{children}</HealthContext.Provider>;
}

/** The contract and signals a page renders connector health from. */
export function useConnectorHealth(state: OperatorState): ConnectorHealth {
  const held = useContext(HealthContext);
  const contract = maintainerContract(state);
  const health = held ?? steadyHealth(state, null);
  return useMemo(() => shownHealth(contract, health), [contract, health]);
}
