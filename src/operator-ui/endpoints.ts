import type { OperatorGrant, OperatorUiContract } from "./contract.js";

/** Intersect code-declared pools, admitted grants, and final live verdicts. */
export function endpointGroups(
  contract: OperatorUiContract,
  grants: OperatorGrant[],
  readOnly: boolean,
  poolName?: string,
) {
  const pool = poolName === undefined ? undefined : contract.config.pools.find((p) => p.name === poolName);
  return contract.config.connectors.flatMap((config) => {
    const live = contract.live.connectors.find((c) => c.id === config.id);
    const grant = grants.find((g) => g.connectorId === config.id);
    if (!live || !grant || (poolName !== undefined && !pool)) return [];
    const tools = live.tools.filter((tool) => {
      if (readOnly && tool.classification !== "read") return false;
      if (pool && !pool.tools.some((entry) => entry === config.id || entry === tool.address)) return false;
      return (
        grant.tools === "all" ||
        grant.tools.some((g) => g.name === tool.name && (!g.requireReadOnly || tool.classification === "read"))
      );
    });
    // A granted connector with no complete catalog still needs a visible fix.
    return [{ config, live, tools }];
  });
}
