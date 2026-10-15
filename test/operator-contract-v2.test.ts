import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperatorMemberManage, OperatorRunsAs, OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import {
  OPERATOR_V2_MAINTAINER,
  OPERATOR_V2_MEMBER,
  OPERATOR_V2_MEMBER_EXPECTED,
} from "./fixtures/operator-contract-v2.js";
import { expectMemberViewWithholds, memberViewExpectation } from "./helpers/operator-member-view.js";

type View = OperatorUiContractV2;
const connector = (view: View, id: string) => view.connectors.find((c) => c.id === id)!;
const credential = (view: View) =>
  connector(view, "notion").manage as Extract<OperatorMemberManage, { kind: "credential" }>;
const pool = (view: View, name: string) => view.pools.find((p) => p.name === name)!;

function expectRejected(mutate: (view: View) => void): void {
  const view: View = structuredClone(OPERATOR_V2_MEMBER);
  mutate(view);
  expect(() => expectMemberViewWithholds(view, OPERATOR_V2_MEMBER_EXPECTED)).toThrow();
}

// No route serves v2 yet; these fixtures freeze the shape the UI builds against.
describe("operator contract v2 fixtures", () => {
  it("type-checks both roles against OperatorUiContractV2", () => {
    expectTypeOf(OPERATOR_V2_MAINTAINER).toExtend<OperatorUiContractV2>();
    expectTypeOf(OPERATOR_V2_MEMBER).toExtend<OperatorUiContractV2>();
    expect(JSON.parse(JSON.stringify(OPERATOR_V2_MAINTAINER))).toEqual(OPERATOR_V2_MAINTAINER);
    expect(JSON.parse(JSON.stringify(OPERATOR_V2_MEMBER))).toEqual(OPERATOR_V2_MEMBER);
  });

  it("covers every maintainer fact the UI renders, including each runsAs variant and plain /mcp", () => {
    const { root, pools, agents, matrix, live, config, configSources } = OPERATOR_V2_MAINTAINER;
    expect(Object.keys(configSources).length).toBeGreaterThan(0);
    expect(root.maintainers.map((m) => m.kind === "human" && m.label)).toEqual(["Ada Lovelace", null]);
    expect(pools.some((p) => p.owner && p.members.some((m) => m.kind === "agent"))).toBe(true);
    expect(pools.some((p) => p.readOnly)).toBe(true);
    expect(pools.some((p) => p.owner === null)).toBe(true);
    expect(agents.map((a) => a.token.state)).toEqual(["issued", "none"]);
    expect(agents.find((a) => a.token.state === "issued")?.lastSeenAt).not.toBeNull();
    const kinds: Record<OperatorRunsAs["kind"], boolean> = {
      shared: false,
      personal: false,
      workspace: false,
      workspaceFixed: false,
    };
    for (const cell of matrix) kinds[cell.runsAs.kind] = true;
    expect(Object.values(kinds).every(Boolean)).toBe(true);
    // Plain /mcp serves the whole catalog, so its column has a cell per connector.
    const catalog = config.connectors.map((c) => c.id).sort();
    expect(live.connectors.map((c) => c.id).sort()).toEqual(catalog);
    expect(
      matrix
        .filter((cell) => cell.pool === null)
        .map((cell) => cell.connectorId)
        .sort(),
    ).toEqual(catalog);
    for (const cell of matrix) {
      expect(catalog).toContain(cell.connectorId);
      if (cell.pool !== null) expect(pools.map((p) => p.name)).toContain(cell.pool);
      if (cell.pool === null && cell.runsAs.kind === "workspace") expect(cell.runsAs.agents).toBeNull();
    }
    expect(OPERATOR_V2_MAINTAINER.connectors).toEqual([]);
  });

  it("INV-4 INV-5: the member fixture matches the projection built from config and membership", () => {
    expect(OPERATOR_V2_MEMBER_EXPECTED.pools.map((p) => p.name)).toEqual(["support", "team"]);
    expect(OPERATOR_V2_MEMBER_EXPECTED.connectors.map((c) => c.id)).toEqual(["github", "drive", "slack", "notion"]);
    expectMemberViewWithholds(OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED);
    const kinds = OPERATOR_V2_MEMBER.connectors.map((c) => `${c.authScope}:${c.manage.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["personal:oauth", "personal:credential", "shared:none"]));
  });

  it("INV-4: builds the projection from membership and manage permission only", () => {
    const source = {
      pools: OPERATOR_V2_MAINTAINER.pools,
      connectors: OPERATOR_V2_MAINTAINER.config.connectors,
      catalog: OPERATOR_V2_MAINTAINER.live.connectors.flatMap((c) => c.tools),
    };
    expect(
      memberViewExpectation({ ...source, member: { namespace: "https://other.example", id: "user_lin" } }),
    ).toEqual({ pools: [], connectors: [] });
    const ada = memberViewExpectation({
      ...source,
      member: { namespace: "https://clerk.example.test", id: "user_ada" },
    });
    expect(ada.pools.map((p) => p.name)).toEqual(["ada", "team"]);
    // A name grant admits that tool only, not the connector's whole catalog.
    expect(ada.connectors.find((c) => c.id === "github")?.tools).toEqual([
      { address: "github.read", classification: "read" },
    ]);
    const unmanaged = memberViewExpectation({
      ...source,
      member: { namespace: "https://clerk.example.test", id: "user_lin" },
      canManage: () => false,
    });
    expect(unmanaged.connectors.map((c) => c.manage)).toEqual(unmanaged.connectors.map(() => ({ kind: "none" })));
  });

  it.each<[string, (view: View) => void]>([
    [
      "raw downstream text in connection.problem",
      (view) => Object.assign(connector(view, "slack").connection!, { problem: "connect ECONNREFUSED 10.0.0.7:443" }),
    ],
    [
      "a credential digest in connection.state",
      (view) => Object.assign(connector(view, "slack").connection!, { state: "sha256:9f86d081884c7d65" }),
    ],
    [
      "a top-level key named like a nested path",
      (view) => Object.assign(view, { "connectors[].connection.problem": "oauth_required" }),
    ],
    [
      "an extra key on a connection",
      (view) => Object.assign(connector(view, "notion").connection!, { lastFour: "1234" }),
    ],
    ["an extra key on a credential field", (view) => Object.assign(credential(view).fields![1]!, { value: "secret" })],
    [
      "a catalog fact on a connector",
      (view) =>
        Object.assign(connector(view, "slack"), { lastCall: { at: "2026-10-08T12:00:00.000Z", outcome: "success" } }),
    ],
    ["actions on a none manage", (view) => Object.assign(connector(view, "github").manage, { actions: ["connect"] })],
    [
      "a credential label on an oauth manage",
      (view) => Object.assign(connector(view, "slack").manage, { label: "Token" }),
    ],
    ["an oauth action on a credential manage", (view) => credential(view).actions.push("disconnect" as "save")],
    ["a repeated action", (view) => credential(view).actions.push("save")],
    ["an unknown manage kind", (view) => Object.assign(connector(view, "slack").manage, { kind: "admin" })],
    ["a missing connection on a personal connector", (view) => (connector(view, "slack").connection = null)],
    ["an extra key on a pool grant", (view) => Object.assign(pool(view, "team").tools[0]!, { owner: "x" })],
    ["an extra key on you", (view) => Object.assign(view.you, { id: "user_lin" })],
  ])("INV-6: the member-view shape check rejects %s", (_name, mutate) => expectRejected(mutate));

  it.each<[string, (view: View) => void]>([
    ["config", (view) => (view.config = OPERATOR_V2_MAINTAINER.config)],
    ["configSources", (view) => (view.configSources = {})],
    ["the root endpoint", (view) => (view.root = OPERATOR_V2_MAINTAINER.root)],
    ["live connector overlays", (view) => (view.live.connectors = OPERATOR_V2_MAINTAINER.live.connectors)],
    ["activity", (view) => (view.live.activity = "available")],
    ["agents", (view) => (view.agents = OPERATOR_V2_MAINTAINER.agents)],
    ["the matrix", (view) => (view.matrix = OPERATOR_V2_MAINTAINER.matrix)],
    ["a pool owner", (view) => (pool(view, "support").owner = "support@workspace.example")],
    ["pool members", (view) => (pool(view, "support").members = OPERATOR_V2_MAINTAINER.pools[1]!.members)],
    ["a shared connection", (view) => (connector(view, "github").connection = { state: "ok" })],
    ["shared management", (view) => (connector(view, "github").manage = { kind: "oauth", actions: ["connect"] })],
    ["a credential suffix in a field label", (view) => (credential(view).fields![1]!.label = "Token ••••1234")],
    ["an owner address in a pool name", (view) => (pool(view, "support").name = "support@workspace.example")],
    [
      "an owner address in a connector title",
      (view) => (connector(view, "drive").title = "Drive (support@workspace.example)"),
    ],
    [
      "activity serialized into problem",
      (view) =>
        Object.assign(connector(view, "slack").connection!, {
          problem: JSON.stringify({ at: "2026-10-08T12:00:00.000Z", address: "slack.post", outcome: "success" }),
        }),
    ],
    ["another member's id", (view) => (credential(view).fields![0]!.description = "Shared with user_ada")],
    ["an agent name in a description", (view) => (credential(view).description = "Used by agent triage")],
    [
      "an unadmitted pool",
      (view) => view.pools.push({ ...OPERATOR_V2_MAINTAINER.pools[0]!, owner: null, members: [] }),
    ],
    ["an unadmitted pool on a connector", (view) => connector(view, "github").pools.push("ada")],
    [
      "an ungranted tool",
      (view) => connector(view, "github").tools.push({ address: "github.write", classification: "write" }),
    ],
    ["a widened pool grant", (view) => (pool(view, "support").tools[0]!.tools = "all")],
    ["a reclassified tool", (view) => (connector(view, "slack").tools[1]!.classification = "read")],
    [
      "an unadmitted connector",
      (view) => view.connectors.push({ ...connector(view, "github"), id: "gmail", title: "Gmail" }),
    ],
  ])("INV-4 INV-5: the member-view value check rejects %s", (_name, mutate) => expectRejected(mutate));
});
