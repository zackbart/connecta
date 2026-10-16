// Until P6b of #837 serves operator contract v2, `GET /ui/api/config` still
// answers v1. Specs that run the real server, and the visual fixtures built
// from it, pass that answer through here to get the maintainer view the
// browser now requires. A v2 body passes through unchanged, so once P6b lands
// every caller already sees the server's own answer and this module is deleted.
import type {
  OperatorConnectorPoolCell,
  OperatorGrant,
  OperatorMember,
  OperatorPoolV2,
  OperatorRunsAs,
  OperatorUiContract,
  OperatorUiContractV2,
} from "../../src/operator-ui/contract.js";

export interface BridgeFacts {
  /** The subject per connector and endpoint; defaults to shared-missing or personal 0 of 0. */
  runsAs?: (connectorId: string, pool: string | null) => OperatorRunsAs | undefined;
  /** Pool members, by pool name. */
  members?: Record<string, OperatorMember[]>;
  /** Humans who may use plain /mcp. */
  maintainers?: OperatorMember[];
}

/** `config.pools[].tools` entries (`connector` or `connector.tool`) as grants. */
function poolGrants(entries: string[]): OperatorGrant[] {
  const grants = new Map<string, OperatorGrant>();
  for (const entry of entries) {
    const dot = entry.indexOf(".");
    const connectorId = dot < 0 ? entry : entry.slice(0, dot);
    const current = grants.get(connectorId);
    if (dot < 0 || current?.tools === "all") {
      grants.set(connectorId, { connectorId, tools: "all" });
      continue;
    }
    const tool = { name: entry.slice(dot + 1), requireReadOnly: false };
    grants.set(connectorId, { connectorId, tools: [...(current?.tools ?? []), tool] });
  }
  return [...grants.values()];
}

export function contractV2(
  body: OperatorUiContract | OperatorUiContractV2,
  facts: BridgeFacts = {},
): OperatorUiContractV2 {
  if (body.schemaVersion === 2) return body;
  const config = body.config;
  const scope = new Map(config.connectors.map((c) => [c.id, c.authScope]));
  const subject = (connectorId: string, pool: string | null): OperatorRunsAs =>
    facts.runsAs?.(connectorId, pool) ??
    (scope.get(connectorId) === "personal"
      ? { kind: "personal", connectedMembers: 0, members: 0 }
      : { kind: "shared", source: "missing", savedAt: null });
  const cells = (grants: OperatorGrant[], pool: string | null): OperatorConnectorPoolCell[] =>
    grants
      .filter((grant) => scope.has(grant.connectorId))
      .map((grant) => ({
        connectorId: grant.connectorId,
        pool,
        tools: grant.tools === "all" ? "all" : grant.tools.map((tool) => tool.name),
        runsAs: subject(grant.connectorId, pool),
      }));
  const pools: OperatorPoolV2[] = config.pools.map((pool) => ({
    name: pool.name,
    humanPath: pool.path,
    agentPath: `/agent/${pool.name}`,
    readOnly: pool.readOnly,
    owner: null,
    tools: poolGrants(pool.tools),
    members: facts.members?.[pool.name] ?? [],
  }));
  return {
    schemaVersion: 2,
    role: "maintainer",
    config,
    configSources: body.configSources ?? null,
    live: body.live,
    root: { path: config.urls.mcpPath, readOnly: body.you.readOnly, maintainers: facts.maintainers ?? [] },
    pools,
    agents: [],
    matrix: [...cells(body.you.grants, null), ...pools.flatMap((pool) => cells(pool.tools, pool.name))],
    connectors: [],
    you: { interactive: body.you.interactive },
  };
}
