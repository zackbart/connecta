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
// The member's own connection state and manage actions are the only values
// the projection cannot predict; the shape layer pins both to closed enums.
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

type ExpectedManage =
  | { kind: "none" }
  | { kind: "oauth" }
  | Omit<Extract<OperatorMemberManage, { kind: "credential" }>, "actions">;

/** The trusted projection a member response must match, value for value. */
export interface MemberViewExpectation {
  pools: Array<Pick<OperatorPoolV2, "name" | "humanPath" | "agentPath" | "readOnly" | "tools">>;
  connectors: Array<Omit<OperatorMemberConnector, "connection" | "manage"> & { manage: ExpectedManage }>;
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
  /** Whether the member may manage their own connection; every personal connector by default. */
  canManage?: (connectorId: string) => boolean;
}

/** Build the member projection from config, catalog and membership, never from a member response. */
export function memberViewExpectation(source: MemberViewSource): MemberViewExpectation {
  const isMember = (m: OperatorMember) =>
    m.kind === "human" && m.namespace === source.member.namespace && m.id === source.member.id;
  const pools = source.pools.filter((pool) => pool.members.some(isMember));
  const connectors = source.connectors.flatMap((connector) => {
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
    return [
      {
        id: connector.id,
        title: connector.title ?? connector.id,
        pools: [...new Set(grants.map((g) => g.pool))],
        authScope: connector.authScope,
        tools,
        manage: expectedManage(connector, source.canManage?.(connector.id) ?? true),
      },
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

function expectedManage(connector: DescribedConnector, permitted: boolean): ExpectedManage {
  if (connector.authScope === "shared" || !permitted) return { kind: "none" };
  if (connector.credential) {
    const { label, description, fields } = connector.credential;
    return {
      kind: "credential",
      label,
      ...(description === undefined ? {} : { description }),
      ...(fields === undefined
        ? {}
        : {
            fields: fields.map(({ name, label, description }) => ({
              name,
              label,
              ...(description === undefined ? {} : { description }),
            })),
          }),
    };
  }
  return connector.auth?.mode === "oauth" ? { kind: "oauth" } : { kind: "none" };
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

function grantShape(value: unknown, path: string): void {
  const grant = exact(value, path, ["connectorId", "tools"]);
  text(grant.connectorId, `${path}.connectorId`);
  if (grant.tools === "all") return;
  list(grant.tools, `${path}.tools`).forEach((tool, i) => {
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
      list(manage.fields, `${path}.fields`).forEach((field, i) => {
        const f = exact(field, `${path}.fields[${i}]`, ["name", "label"], ["description"]);
        text(f.name, `${path}.fields[${i}].name`);
        text(f.label, `${path}.fields[${i}].label`);
        if ("description" in f) text(f.description, `${path}.fields[${i}].description`);
      });
    }
  }
  if (kind === "none") return;
  const actions = list(manage.actions, `${path}.actions`);
  expect(new Set(actions).size, `${path}.actions repeats an action`).toBe(actions.length);
  for (const action of actions) oneOf(action, MANAGE_ACTIONS[kind as keyof typeof MANAGE_ACTIONS], `${path}.actions`);
}

function connectorShape(value: unknown, path: string): Json {
  const connector = exact(value, path, ["id", "title", "pools", "authScope", "tools", "connection", "manage"]);
  text(connector.id, `${path}.id`);
  text(connector.title, `${path}.title`);
  list(connector.pools, `${path}.pools`).forEach((pool, i) => text(pool, `${path}.pools[${i}]`));
  oneOf(connector.authScope, ["shared", "personal"], `${path}.authScope`);
  list(connector.tools, `${path}.tools`).forEach((tool, i) => {
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

  const pools = list(body.pools, "pools").map((value, i) => {
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
    list(pool.tools, `pools[${i}].tools`).forEach((grant, j) => grantShape(grant, `pools[${i}].tools[${j}]`));
    const { owner: _owner, members: _members, ...visible } = pool;
    return visible;
  });
  const connectors = list(body.connectors, "connectors").map((value, i) => {
    const { connection: _connection, manage, ...visible } = connectorShape(value, `connectors[${i}]`);
    const { actions: _actions, ...declared } = manage as Json;
    return { ...visible, manage: declared };
  });

  // Order discloses nothing, so compare as sets keyed by name and id.
  const by = (key: string) => (a: object, b: object) =>
    String((a as Json)[key]).localeCompare(String((b as Json)[key]));
  const byName = by("name");
  const byId = by("id");
  expect(pools.sort(byName), "pools differ from the member's admitted pools").toEqual([...expected.pools].sort(byName));
  expect(connectors.sort(byId), "connectors differ from the member's projection").toEqual(
    [...expected.connectors].sort(byId),
  );
}
