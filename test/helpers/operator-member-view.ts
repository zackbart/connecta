// The member half of operator contract v2 withholds every maintainer fact
// (decisions/0006-pools-are-the-access-model.md). This check reads the
// complete serialized response, so it applies unchanged to fixtures and to
// real `GET /ui/api/config` bodies.
import { expect } from "vitest";
import type { OperatorMemberManage, OperatorRole } from "../../src/operator-ui/contract.js";

// Every key path a member response may carry; `[]` stands for any array index.
// An allowlist rather than a denylist: a credential value, suffix, digest,
// catalog age or last call fails here whatever it is named.
const MEMBER_PATHS = new Set([
  "schemaVersion",
  "role",
  "config",
  "configSources",
  "live",
  "live.connectors",
  "live.activity",
  "root",
  "pools",
  "pools[]",
  "pools[].name",
  "pools[].humanPath",
  "pools[].agentPath",
  "pools[].readOnly",
  "pools[].owner",
  "pools[].tools",
  "pools[].tools[]",
  "pools[].tools[].connectorId",
  "pools[].tools[].tools",
  "pools[].tools[].tools[]",
  "pools[].tools[].tools[].name",
  "pools[].tools[].tools[].requireReadOnly",
  "pools[].members",
  "agents",
  "matrix",
  "connectors",
  "connectors[]",
  "connectors[].id",
  "connectors[].title",
  "connectors[].pools",
  "connectors[].pools[]",
  "connectors[].authScope",
  "connectors[].tools",
  "connectors[].tools[]",
  "connectors[].tools[].address",
  "connectors[].tools[].classification",
  "connectors[].connection",
  "connectors[].connection.state",
  "connectors[].connection.problem",
  "connectors[].manage",
  "connectors[].manage.kind",
  "connectors[].manage.actions",
  "connectors[].manage.actions[]",
  "connectors[].manage.label",
  "connectors[].manage.description",
  "connectors[].manage.fields",
  "connectors[].manage.fields[]",
  "connectors[].manage.fields[].name",
  "connectors[].manage.fields[].label",
  "connectors[].manage.fields[].description",
  "you",
  "you.interactive",
]);

const MEMBER_ROLE: OperatorRole = "member";
const MANAGE_ACTIONS: { [K in OperatorMemberManage["kind"]]: readonly string[] } = {
  none: [],
  oauth: ["connect", "restart", "disconnect"],
  credential: ["save", "test", "clear"],
};

function keyPaths(value: unknown, prefix: string, out: string[]): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      out.push(`${prefix}[]`);
      keyPaths(item, `${prefix}[]`, out);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      keyPaths(child, path, out);
    }
  }
  return out;
}

/** Assert a member-role v2 response carries none of the facts the member view withholds. */
export function expectMemberViewWithholds(response: unknown): void {
  // Inspect what crosses the wire, not the in-memory object.
  const body = JSON.parse(JSON.stringify(response)) as Record<string, unknown> & {
    live: { connectors: unknown[]; activity: string };
    pools: Array<{ owner: unknown; members: unknown[] }>;
    connectors: Array<{
      authScope: string;
      connection: unknown;
      manage: { kind: OperatorMemberManage["kind"]; actions?: string[] };
    }>;
  };
  const unexpected = [...new Set(keyPaths(body, "", []))].filter((path) => !MEMBER_PATHS.has(path));
  expect(unexpected, "member response carries a key outside the member view").toEqual([]);

  expect(body.schemaVersion).toBe(2);
  expect(body.role).toBe(MEMBER_ROLE);
  expect(body.config).toBeNull();
  expect(body.configSources).toBeNull();
  expect(body.root).toBeNull();
  expect(body.live.connectors).toEqual([]);
  expect(body.live.activity).toBe("forbidden");
  expect(body.agents).toEqual([]);
  expect(body.matrix).toEqual([]);
  for (const pool of body.pools) {
    expect(pool.owner).toBeNull();
    expect(pool.members).toEqual([]);
  }
  for (const connector of body.connectors) {
    if (connector.authScope === "shared") {
      expect(connector.connection).toBeNull();
      expect(connector.manage).toEqual({ kind: "none" });
    } else {
      expect(connector.authScope).toBe("personal");
    }
    const allowed = MANAGE_ACTIONS[connector.manage.kind];
    expect(allowed, `unknown manage kind ${connector.manage.kind}`).toBeDefined();
    for (const action of connector.manage.actions ?? []) expect(allowed).toContain(action);
  }
}
