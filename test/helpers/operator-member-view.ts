// The member half of operator contract v2 withholds every maintainer fact
// (decisions/0006-pools-are-the-access-model.md). This check reads the
// complete serialized response, so it applies unchanged to fixtures and to
// real `GET /ui/api/config` bodies.
//
// Two layers. The shape layer walks every object with exact keys, closed enums
// and per-kind unions, so no extra key or free text survives. The value layer
// compares every member-visible value against a projection the caller builds
// from config and membership, so a value that reads as a name or label cannot
// smuggle an owner, another principal, an unadmitted pool or an ungranted tool.
// The caller supplies what config cannot show: each personal connector's
// connection in the member's own partition and its exact `manage` value.
// Unordered collections compare as sets and reject duplicates.
import { expect } from "vitest";
import type { DescribedConnector } from "../../src/describe-config.js";
import type {
  OperatorMember,
  OperatorMemberConnector,
  OperatorMemberManage,
  OperatorPoolV2,
  OperatorRole,
} from "../../src/operator-ui/contract.js";
import type { UiProblem } from "../../src/operator-ui/model.js";
import type { ConnectorStatus } from "../../src/types.js";

// Records keyed by the union keep these lists exhaustive and closed.
const STATES = Object.keys({ ok: 1, auth_required: 1, credential_required: 1, error: 1 } satisfies Record<
  ConnectorStatus["state"],
  1
>);
const PROBLEMS = Object.keys({
  connector_unavailable: 1,
  oauth_required: 1,
  credential_required: 1,
  auth_required: 1,
  credential_mismatch: 1,
  catalog_failed: 1,
} satisfies Record<UiProblem, 1>);
type ActionsOf<M> = M extends { actions: Array<infer A> } ? A : never;
const MANAGE_ACTIONS = {
  none: [],
  oauth: ["connect", "restart", "disconnect"],
  credential: ["save", "test", "clear"],
} satisfies { [K in OperatorMemberManage["kind"]]: Array<ActionsOf<Extract<OperatorMemberManage, { kind: K }>>> };

/** The trusted projection a member response must match, value for value. */
export interface MemberViewExpectation {
  pools: Array<Pick<OperatorPoolV2, "name" | "humanPath" | "agentPath" | "readOnly" | "tools">>;
  connectors: OperatorMemberConnector[];
}

/**
 * One personal connector as the tested member's own partition sees it. Both
 * values are trusted inputs, never read from the response under test.
 *
 * P6b must derive `manage` server-side, and test that derivation itself
 * (including a disconnect-only connector and a deployment without a vault),
 * from three facts. The member's permission to manage their own connection
 * gates every action. The connector's hooks: `test` when
 * `credentialTestRule(connector).mode !== null`, which pairs named fields with
 * `testCredentials` and a single credential with `testCredential`; `connect`
 * and `restart` with `startAuth` and `finishAuth`; `disconnect` with
 * `disconnectAuth`. Deployment availability: a vault for `save` and `clear`,
 * and handoff signing for `connect` and `restart`. This helper only compares
 * the derived value; it models none of those rules.
 */
export interface MemberPartition {
  /** The member's own status from the server's status seam. */
  connection: { state: ConnectorStatus["state"]; problem?: UiProblem };
  /** The exact expected value, kind and actions included. */
  manage: OperatorMemberManage;
}

export interface MemberViewSource {
  /** The human whose view this is. */
  member: { namespace: string; id: string };
  /** Every pool, with its declared tools and members. */
  pools: OperatorPoolV2[];
  /** `describeConfig().connectors`. */
  connectors: DescribedConnector[];
  /** The registry's final verdict for every served tool. */
  catalog: Array<{ address: string; classification: "read" | "write" }>;
  /** Every personal connector in the member's pools, keyed by connector id. */
  personal: Record<string, MemberPartition>;
}

/** Build the member projection from config, catalog, membership and partition facts, never from a member response. */
export function memberViewExpectation(source: MemberViewSource): MemberViewExpectation {
  const isMember = (m: OperatorMember) =>
    m.kind === "human" && m.namespace === source.member.namespace && m.id === source.member.id;
  const pools = source.pools.filter((pool) => pool.members.some(isMember));
  const connectors = source.connectors.flatMap((connector): OperatorMemberConnector[] => {
    const grants = pools.flatMap((pool) =>
      pool.tools.filter((grant) => grant.connectorId === connector.id).map((grant) => ({ pool: pool.name, grant })),
    );
    if (grants.length === 0) return [];
    const tools = source.catalog
      .filter((tool) => tool.address.startsWith(`${connector.id}.`))
      .filter(({ address }) =>
        grants.some(
          ({ grant }) => grant.tools === "all" || grant.tools.some((t) => `${connector.id}.${t.name}` === address),
        ),
      )
      .map(({ address, classification }) => ({ address, classification }));
    const visible = {
      id: connector.id,
      title: connector.title ?? connector.id,
      pools: [...new Set(grants.map((g) => g.pool))],
      authScope: connector.authScope,
      tools,
    };
    if (connector.authScope === "shared") return [{ ...visible, connection: null, manage: { kind: "none" } }];
    const partition = source.personal[connector.id];
    if (!partition) throw new Error(`No partition facts for personal connector ${connector.id}`);
    return [
      { ...visible, connection: structuredClone(partition.connection), manage: structuredClone(partition.manage) },
    ];
  });
  return {
    pools: pools.map(({ name, humanPath, agentPath, readOnly, tools }) => ({
      name,
      humanPath,
      agentPath,
      readOnly,
      tools,
    })),
    connectors,
  };
}

type Json = Record<string, unknown>;

function exact(value: unknown, path: string, required: string[], optional: string[] = []): Json {
  expect(value !== null && typeof value === "object" && !Array.isArray(value), `${path} is an object`).toBe(true);
  const keys = Object.keys(value as Json);
  expect(
    keys.filter((key) => !required.includes(key) && !optional.includes(key)),
    `${path} carries unexpected keys`,
  ).toEqual([]);
  expect(
    required.filter((key) => !keys.includes(key)),
    `${path} lacks keys`,
  ).toEqual([]);
  return value as Json;
}

function list(value: unknown, path: string): unknown[] {
  expect(Array.isArray(value), `${path} is an array`).toBe(true);
  return value as unknown[];
}

function oneOf(value: unknown, allowed: readonly unknown[], path: string): void {
  expect(allowed, `${path} is ${JSON.stringify(value)}`).toContain(value);
}

function text(value: unknown, path: string): void {
  expect(typeof value, `${path} is a string`).toBe("string");
}

function unique(values: unknown[], path: string): void {
  expect(new Set(values.map((v) => JSON.stringify(v))).size, `${path} repeats an entry`).toBe(values.length);
}

function grantShape(value: unknown, path: string): void {
  const grant = exact(value, path, ["connectorId", "tools"]);
  text(grant.connectorId, `${path}.connectorId`);
  if (grant.tools === "all") return;
  const tools = list(grant.tools, `${path}.tools`);
  unique(
    tools.map((t) => (t as Json)?.name),
    `${path}.tools`,
  );
  tools.forEach((tool, i) => {
    const entry = exact(tool, `${path}.tools[${i}]`, ["name", "requireReadOnly"]);
    text(entry.name, `${path}.tools[${i}].name`);
    oneOf(entry.requireReadOnly, [true, false], `${path}.tools[${i}].requireReadOnly`);
  });
}

function manageShape(value: unknown, path: string): void {
  const kind = exact(value, path, ["kind"], ["actions", "label", "description", "fields"]).kind;
  oneOf(kind, Object.keys(MANAGE_ACTIONS), `${path}.kind`);
  const manage =
    kind === "none"
      ? exact(value, path, ["kind"])
      : kind === "oauth"
        ? exact(value, path, ["kind", "actions"])
        : exact(value, path, ["kind", "label", "actions"], ["description", "fields"]);
  if (kind === "credential") {
    text(manage.label, `${path}.label`);
    if ("description" in manage) text(manage.description, `${path}.description`);
    if ("fields" in manage) {
      const fields = list(manage.fields, `${path}.fields`);
      unique(
        fields.map((f) => (f as Json)?.name),
        `${path}.fields`,
      );
      fields.forEach((field, i) => {
        const f = exact(field, `${path}.fields[${i}]`, ["name", "label"], ["description"]);
        text(f.name, `${path}.fields[${i}].name`);
        text(f.label, `${path}.fields[${i}].label`);
        if ("description" in f) text(f.description, `${path}.fields[${i}].description`);
      });
    }
  }
  if (kind === "none") return;
  const actions = list(manage.actions, `${path}.actions`);
  unique(actions, `${path}.actions`);
  for (const action of actions) oneOf(action, MANAGE_ACTIONS[kind as keyof typeof MANAGE_ACTIONS], `${path}.actions`);
}

function connectorShape(value: unknown, path: string): Json {
  const connector = exact(value, path, ["id", "title", "pools", "authScope", "tools", "connection", "manage"]);
  text(connector.id, `${path}.id`);
  text(connector.title, `${path}.title`);
  const pools = list(connector.pools, `${path}.pools`);
  unique(pools, `${path}.pools`);
  pools.forEach((pool, i) => text(pool, `${path}.pools[${i}]`));
  oneOf(connector.authScope, ["shared", "personal"], `${path}.authScope`);
  const tools = list(connector.tools, `${path}.tools`);
  unique(
    tools.map((t) => (t as Json)?.address),
    `${path}.tools`,
  );
  tools.forEach((tool, i) => {
    const entry = exact(tool, `${path}.tools[${i}]`, ["address", "classification"]);
    text(entry.address, `${path}.tools[${i}].address`);
    oneOf(entry.classification, ["read", "write"], `${path}.tools[${i}].classification`);
  });
  if (connector.authScope === "shared") {
    expect(connector.connection, `${path}.connection`).toBeNull();
    expect(connector.manage, `${path}.manage`).toEqual({ kind: "none" });
  } else {
    const connection = exact(connector.connection, `${path}.connection`, ["state"], ["problem"]);
    oneOf(connection.state, STATES, `${path}.connection.state`);
    if ("problem" in connection) oneOf(connection.problem, PROBLEMS, `${path}.connection.problem`);
  }
  manageShape(connector.manage, `${path}.manage`);
  return connector;
}

/**
 * Assert a member-role v2 response has exactly the member shape and carries
 * only the values `expected` (from `memberViewExpectation`) predicts.
 */
export function expectMemberViewWithholds(response: unknown, expected: MemberViewExpectation): void {
  // Inspect what crosses the wire, not the in-memory object.
  const body = exact(JSON.parse(JSON.stringify(response)), "response", [
    "schemaVersion",
    "role",
    "config",
    "configSources",
    "live",
    "root",
    "pools",
    "agents",
    "matrix",
    "connectors",
    "you",
  ]);
  expect(body.schemaVersion, "schemaVersion").toBe(2);
  expect(body.role, "role").toBe("member" satisfies OperatorRole);
  expect(body.config, "config").toBeNull();
  expect(body.configSources, "configSources").toBeNull();
  expect(body.root, "root").toBeNull();
  const live = exact(body.live, "live", ["connectors", "activity"]);
  expect(live.connectors, "live.connectors").toEqual([]);
  expect(live.activity, "live.activity").toBe("forbidden");
  expect(body.agents, "agents").toEqual([]);
  expect(body.matrix, "matrix").toEqual([]);
  oneOf(exact(body.you, "you", ["interactive"]).interactive, [true, false], "you.interactive");

  const pools = list(body.pools, "pools");
  unique(
    pools.map((p) => (p as Json)?.name),
    "pools",
  );
  pools.forEach((value, i) => {
    const pool = exact(value, `pools[${i}]`, [
      "name",
      "humanPath",
      "agentPath",
      "readOnly",
      "owner",
      "tools",
      "members",
    ]);
    expect(pool.owner, `pools[${i}].owner`).toBeNull();
    expect(pool.members, `pools[${i}].members`).toEqual([]);
    oneOf(pool.readOnly, [true, false], `pools[${i}].readOnly`);
    for (const key of ["name", "humanPath", "agentPath"]) text(pool[key], `pools[${i}].${key}`);
    const grants = list(pool.tools, `pools[${i}].tools`);
    unique(
      grants.map((g) => (g as Json)?.connectorId),
      `pools[${i}].tools`,
    );
    grants.forEach((grant, j) => grantShape(grant, `pools[${i}].tools[${j}]`));
  });
  const connectors = list(body.connectors, "connectors");
  unique(
    connectors.map((c) => (c as Json)?.id),
    "connectors",
  );
  connectors.forEach((value, i) => connectorShape(value, `connectors[${i}]`));

  expect(canonicalPools(body.pools), "pools differ from the member's admitted pools").toEqual(
    canonicalPools(expected.pools),
  );
  expect(canonicalConnectors(body.connectors), "connectors differ from the member's projection").toEqual(
    canonicalConnectors(expected.connectors),
  );
}

// Order discloses nothing, and duplicates were refused above, so every
// unordered collection compares as a sorted set.
const sortBy = <T>(values: readonly T[], key: (value: T) => string) =>
  [...values].sort((a, b) => key(a).localeCompare(key(b)));

function canonicalPools(value: unknown): unknown {
  // Owner and members were checked null and empty above; the rest is the projection.
  return sortBy(value as MemberViewExpectation["pools"], (p) => p.name).map(
    ({ name, humanPath, agentPath, readOnly, tools }) => ({
      name,
      humanPath,
      agentPath,
      readOnly,
      tools: sortBy(tools, (g) => g.connectorId).map((grant) => ({
        ...grant,
        tools: grant.tools === "all" ? "all" : sortBy(grant.tools, (t) => t.name),
      })),
    }),
  );
}

function canonicalConnectors(value: unknown): unknown {
  return sortBy(value as OperatorMemberConnector[], (c) => c.id).map((connector) => ({
    ...connector,
    pools: [...connector.pools].sort(),
    tools: sortBy(connector.tools, (t) => t.address),
    manage:
      connector.manage.kind === "none"
        ? connector.manage
        : {
            ...connector.manage,
            actions: [...connector.manage.actions].sort(),
            ...("fields" in connector.manage && connector.manage.fields
              ? { fields: sortBy(connector.manage.fields, (f) => f.name) }
              : {}),
          },
  }));
}
