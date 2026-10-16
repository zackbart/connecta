import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OperatorMemberManage,
  OperatorRunsAs,
  OperatorSharedSource,
  OperatorUiContractV2,
} from "../src/operator-ui/contract.js";
import {
  OPERATOR_V2_MAINTAINER,
  OPERATOR_V2_MEMBER,
  OPERATOR_V2_MEMBER_EXPECTED,
  OPERATOR_V2_PARTITIONS,
  operatorV2MemberSource,
} from "./fixtures/operator-contract-v2.js";
import {
  expectMemberViewWithholds,
  memberViewExpectation,
  type MemberViewExpectation,
  type MemberViewSource,
} from "./helpers/operator-member-view.js";

type View = OperatorUiContractV2;
const connector = (view: View, id: string) => view.connectors.find((c) => c.id === id)!;
const credential = (view: View) =>
  connector(view, "notion").manage as Extract<OperatorMemberManage, { kind: "credential" }>;
const pool = (view: View, name: string) => view.pools.find((p) => p.name === name)!;

function linView(mutate: (view: View) => void = () => {}): View {
  const view: View = structuredClone(OPERATOR_V2_MEMBER);
  mutate(view);
  return view;
}

function expectRejected(mutate: (view: View) => void, expected = OPERATOR_V2_MEMBER_EXPECTED): void {
  const view = linView(mutate);
  expect(() => expectMemberViewWithholds(view, expected)).toThrow();
}

/** Lin's projection with one trusted input changed. */
function linExpectation(change: (source: MemberViewSource) => void): MemberViewExpectation {
  const source = operatorV2MemberSource("user_lin");
  change(source);
  return memberViewExpectation(source);
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
    // The described config names the same maintainers and members, resolved
    // and unlabelled (#837); grant facts are gone.
    const ref = (m: (typeof root.maintainers)[number]) =>
      m.kind === "agent" ? { kind: "agent", name: m.name } : { kind: "human", namespace: m.namespace, id: m.id };
    expect(config.maintainers.map((m) => ({ kind: "human", ...m }))).toEqual(root.maintainers.map(ref));
    expect(config.pools.map((p) => [p.name, p.members])).toEqual(pools.map((p) => [p.name, p.members.map(ref)]));
    expect(config).not.toHaveProperty("hasGrant");
  });

  it("INV-4 INV-5: the member fixture matches the projection built from config and membership", () => {
    expect(OPERATOR_V2_MEMBER_EXPECTED.pools.map((p) => p.name)).toEqual(["support", "team"]);
    expect(OPERATOR_V2_MEMBER_EXPECTED.connectors.map((c) => c.id)).toEqual([
      "github",
      "drive",
      "slack",
      "calendar",
      "notion",
    ]);
    expectMemberViewWithholds(OPERATOR_V2_MEMBER, OPERATOR_V2_MEMBER_EXPECTED);
    const kinds = OPERATOR_V2_MEMBER.connectors.map((c) => `${c.authScope}:${c.manage.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["personal:oauth", "personal:credential", "shared:none"]));
  });

  it("INV-4: builds the projection from membership and caller-supplied partition facts only", () => {
    expect(linExpectation((source) => (source.member.namespace = "https://other.example"))).toEqual({
      pools: [],
      connectors: [],
    });
    const ada = memberViewExpectation(operatorV2MemberSource("user_ada"));
    expect(ada.pools.map((p) => p.name)).toEqual(["ada", "team"]);
    // A name grant admits that tool only, not the connector's whole catalog.
    expect(ada.connectors.find((c) => c.id === "github")?.tools).toEqual([
      { address: "github.read", classification: "read" },
    ]);
    expect(ada.connectors.find((c) => c.id === "slack")?.connection).toEqual(OPERATOR_V2_PARTITIONS.user_ada.slack);
    // Shared connectors are always "none", whatever partition facts a caller passes.
    const shared = linExpectation(
      (source) =>
        (source.personal.github = { connection: { state: "ok" }, manage: { kind: "oauth", actions: ["connect"] } }),
    );
    expect(shared.connectors.find((c) => c.id === "github")).toMatchObject({
      connection: null,
      manage: { kind: "none" },
    });
    expect(() => linExpectation((source) => delete source.personal.slack)).toThrow(/slack/);
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

  describe("member partitions", () => {
    it("INV-4 INV-5: Lin's view carrying Ada's partition status fails", () => {
      expect(OPERATOR_V2_PARTITIONS.user_ada.slack).not.toEqual(OPERATOR_V2_PARTITIONS.user_lin.slack);
      expect(OPERATOR_V2_PARTITIONS.user_ada.notion).not.toEqual(OPERATOR_V2_PARTITIONS.user_lin.notion);
      expectMemberViewWithholds(linView(), OPERATOR_V2_MEMBER_EXPECTED);
      expectRejected((view) => (connector(view, "slack").connection = { ...OPERATOR_V2_PARTITIONS.user_ada.slack }));
      expectRejected((view) => (connector(view, "notion").connection = { ...OPERATOR_V2_PARTITIONS.user_ada.notion }));
      // Ada's own view carries her state, so the same values pass against her projection.
      const ada = memberViewExpectation(operatorV2MemberSource("user_ada"));
      expect(ada.connectors.find((c) => c.id === "notion")?.connection).toEqual({ state: "ok" });
    });

    it("INV-5: a dropped or added problem code fails", () => {
      expectRejected((view) => (connector(view, "notion").connection = { state: "credential_required" }));
      expectRejected((view) => (connector(view, "slack").connection = { state: "ok", problem: "catalog_failed" }));
    });
  });

  describe("manage matches the trusted value exactly", () => {
    const withManage = (id: string, manage: OperatorMemberManage) =>
      linExpectation((source) => (source.personal[id]!.manage = manage));

    it("INV-4: an action the trusted value omits fails", () => {
      // A credential connector whose hooks cannot test it. (Without a vault, every credential action is gone.)
      const noTest = withManage("notion", { ...credential(linView()), actions: ["save", "clear"] });
      expectRejected(() => {}, noTest);
      expectMemberViewWithholds(
        linView((view) => (credential(view).actions = ["save", "clear"])),
        noTest,
      );
      expectRejected(() => {}, withManage("slack", { kind: "oauth", actions: ["disconnect"] }));
    });

    it("INV-4: an action the trusted value names cannot go missing", () => {
      expectRejected((view) => (connector(view, "slack").manage = { kind: "oauth", actions: ["connect", "restart"] }));
      expectRejected((view) => credential(view).actions.splice(1, 1));
    });

    it("INV-4: a member without manage permission must see none", () => {
      expectRejected(() => {}, withManage("slack", { kind: "none" }));
    });

    it("INV-4: a disconnect-only connector advertises disconnect alone", () => {
      expect(connector(linView(), "calendar").manage).toEqual({ kind: "oauth", actions: ["disconnect"] });
      expectRejected(
        (view) =>
          (connector(view, "calendar").manage = { kind: "oauth", actions: ["connect", "restart", "disconnect"] }),
      );
      expectRejected((view) => (connector(view, "calendar").manage = { kind: "oauth", actions: [] }));
    });

    it("INV-4: shared connectors must manage none", () => {
      expectRejected((view) => (connector(view, "github").manage = { kind: "oauth", actions: ["connect"] }));
    });

    it("INV-6: the kind's allowed actions bound even a trusted value", () => {
      const bogus = withManage("slack", { kind: "oauth", actions: ["save"] as unknown as ["connect"] });
      expectRejected(
        (view) => (connector(view, "slack").manage = { kind: "oauth", actions: ["save"] as unknown as ["connect"] }),
        bogus,
      );
    });
  });

  describe("unordered collections compare as sets", () => {
    it("accepts a connector admitted through two pools in either order", () => {
      expect(connector(linView(), "github").pools).toEqual(["support", "team"]);
      expectMemberViewWithholds(
        linView((view) => connector(view, "github").pools.reverse()),
        OPERATOR_V2_MEMBER_EXPECTED,
      );
    });

    it("accepts every unordered collection reversed", () => {
      const view = linView((view) => {
        view.pools.reverse();
        view.connectors.reverse();
        for (const pool of view.pools) {
          pool.tools.reverse();
          for (const grant of pool.tools) if (grant.tools !== "all") grant.tools.reverse();
        }
        for (const c of view.connectors) {
          c.pools.reverse();
          c.tools.reverse();
          if (c.manage.kind !== "none") c.manage.actions.reverse();
          if (c.manage.kind === "credential") c.manage.fields?.reverse();
        }
      });
      expectMemberViewWithholds(view, OPERATOR_V2_MEMBER_EXPECTED);
    });

    it.each<[string, (view: View) => void]>([
      ["a repeated pool", (view) => view.pools.push(structuredClone(pool(view, "team")))],
      ["a repeated connector", (view) => view.connectors.push(structuredClone(connector(view, "drive")))],
      ["a repeated connector pool", (view) => connector(view, "github").pools.push("team")],
      [
        "a repeated tool",
        (view) => connector(view, "slack").tools.push({ address: "slack.post", classification: "write" }),
      ],
      ["a repeated grant", (view) => pool(view, "team").tools.push({ connectorId: "slack", tools: "all" })],
      ["a repeated field", (view) => credential(view).fields!.push({ name: "token", label: "Token" })],
    ])("INV-4: rejects %s", (_name, mutate) => expectRejected(mutate));
  });
});

describe("shared runsAs source", () => {
  it("names every credential origin, with savedAt only where the server knows a save time", () => {
    const sources = {
      vault: true,
      missing: true,
      oauth: true,
      config: true,
      unauthenticated: true,
    } as const satisfies Record<OperatorSharedSource, true>;
    expect(Object.keys(sources).sort()).toEqual(["config", "missing", "oauth", "unauthenticated", "vault"]);
    const cells: Array<Extract<OperatorRunsAs, { kind: "shared" }>> = [
      { kind: "shared", source: "vault", savedAt: "2026-10-01T00:00:00.000Z" },
      { kind: "shared", source: "oauth", savedAt: "2026-10-01T00:00:00.000Z" },
      { kind: "shared", source: "missing", savedAt: null },
      { kind: "shared", source: "config", savedAt: null },
      { kind: "shared", source: "unauthenticated", savedAt: null },
    ];
    expect(cells.map((cell) => cell.source).sort()).toEqual(Object.keys(sources).sort());
  });
});
