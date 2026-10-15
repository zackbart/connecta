import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperatorRunsAs, OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";
import { expectMemberViewWithholds } from "./helpers/operator-member-view.js";

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
    expect(config).not.toBeNull();
    expect(Object.keys(configSources).length).toBeGreaterThan(0);
    expect(root.maintainers.map((m) => m.kind === "human" && m.label)).toEqual(["Ada Lovelace", null]);
    expect(pools.some((p) => p.owner && p.members.some((m) => m.kind === "agent"))).toBe(true);
    expect(pools.some((p) => p.readOnly)).toBe(true);
    expect(pools.some((p) => p.owner === null)).toBe(true);
    expect(agents.map((a) => a.token.state)).toEqual(["issued", "none"]);
    expect(agents.find((a) => a.token.state === "issued")?.lastSeenAt).not.toBeNull();
    expect(matrix.some((cell) => cell.pool === null)).toBe(true);
    const kinds: Record<OperatorRunsAs["kind"], boolean> = {
      shared: false,
      personal: false,
      workspace: false,
      workspaceFixed: false,
    };
    for (const cell of matrix) kinds[cell.runsAs.kind] = true;
    expect(Object.values(kinds).every(Boolean)).toBe(true);
    const ids = live.connectors.map((c) => c.id);
    for (const cell of matrix) {
      expect(ids).toContain(cell.connectorId);
      if (cell.pool !== null) expect(pools.map((p) => p.name)).toContain(cell.pool);
    }
    expect(OPERATOR_V2_MAINTAINER.connectors).toEqual([]);
  });

  it("INV-4 INV-5: the member fixture's serialized view withholds every maintainer fact", () => {
    expectMemberViewWithholds(OPERATOR_V2_MEMBER);
    const kinds = OPERATOR_V2_MEMBER.connectors.map((c) => `${c.authScope}:${c.manage.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(["personal:oauth", "personal:credential", "shared:none"]));
    for (const pool of OPERATOR_V2_MEMBER.pools) {
      for (const grant of pool.tools) {
        expect(OPERATOR_V2_MEMBER.connectors.find((c) => c.id === grant.connectorId)?.pools).toContain(pool.name);
      }
    }
  });

  it("INV-4 INV-5: the member-view check rejects each leaked maintainer fact", () => {
    const leaks: Array<(view: OperatorUiContractV2) => void> = [
      (view) => (view.config = OPERATOR_V2_MAINTAINER.config),
      (view) => (view.configSources = {}),
      (view) => (view.root = OPERATOR_V2_MAINTAINER.root),
      (view) => (view.live.connectors = OPERATOR_V2_MAINTAINER.live.connectors),
      (view) => (view.live.activity = "available"),
      (view) => (view.agents = OPERATOR_V2_MAINTAINER.agents),
      (view) => (view.matrix = OPERATOR_V2_MAINTAINER.matrix),
      (view) => (view.pools[0]!.owner = "support@workspace.example"),
      (view) => (view.pools[0]!.members = OPERATOR_V2_MAINTAINER.pools[1]!.members),
      (view) => (view.connectors[0]!.connection = { state: "ok" }),
      (view) => (view.connectors[0]!.manage = { kind: "oauth", actions: ["connect"] }),
      (view) => Object.assign(view.connectors[3]!.manage, { lastFour: "1234" }),
      (view) => Object.assign((view.connectors[3]!.manage as { fields: object[] }).fields[1]!, { value: "secret" }),
      (view) =>
        Object.assign(view.connectors[2]!, { lastCall: { at: "2026-10-08T12:00:00.000Z", outcome: "success" } }),
    ];
    for (const leak of leaks) {
      const view: OperatorUiContractV2 = structuredClone(OPERATOR_V2_MEMBER);
      leak(view);
      expect(() => expectMemberViewWithholds(view), leak.toString()).toThrow();
    }
  });
});
