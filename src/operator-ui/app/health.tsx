import { useMemo } from "react";
import { shownHealth, type ConnectorHealth } from "../health.js";
import type { OperatorState } from "../view.js";
import { steadyHealthOf } from "./bridge.js";
import { maintainerContract } from "./components/contract-state.js";

export function useConnectorHealth(state: OperatorState): ConnectorHealth {
  const contract = maintainerContract(state);
  const health = steadyHealthOf(state);
  return useMemo(() => shownHealth(contract, health), [contract, health]);
}
