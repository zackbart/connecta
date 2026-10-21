import { describe, expect, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import { connectionMap } from "../src/operator-ui/connection-map.js";
import { OPERATOR_V2_MAINTAINER, OPERATOR_V2_MEMBER } from "./fixtures/operator-contract-v2.js";

const maintainer = () => structuredClone(OPERATOR_V2_MAINTAINER) as OperatorUiContractV2;
const node = (map: ReturnType<typeof connectionMap>, id: string) => map.nodes.find((n) => n.id === id)!;
const ADA = "person:https://clerk.example.test:user_ada";
const GRACE = "person:https://clerk.example.test:user_grace";

describe("connection map layout", () => {
  it("counts no tools for a connector whose catalog is unknown, and zero for a known empty one", () => {
    const contract = maintainer();
    contract.live.connectors = contract.live.connectors.map((c) =>
      c.id === "github"
        ? { ...c, tools: [], problem: "catalog_failed" }
        : c.id === "gmail"
          ? { ...c, tools: [], status: "error" }
          : c.id === "drive"
            ? { ...c, tools: [], status: "ok" }
            : c,
    );
    const map = connectionMap(contract);
    expect(node(map, "connector:github").tools).toBeNull();
    expect(node(map, "connector:gmail").tools).toBeNull();
    expect(node(map, "connector:drive").tools).toEqual({ read: 0, write: 0 });
    // The box keeps its place in the column, so the layout does not shift.
    expect(node(map, "connector:github").toolsBox).not.toBeNull();
  });

  it("INV-4: keeps an empty deployment drawable and draws nothing from a member's contract", () => {
    const contract = maintainer();
    contract.config!.connectors = [];
    contract.live.connectors = [];
    contract.matrix = [];
    contract.pools = [];
    contract.agents = [];
    const map = connectionMap(contract);
    expect(map.nodes.map((entry) => entry.id)).toEqual([ADA, GRACE, "endpoint:/mcp"]);
    expect(node(map, "endpoint:/mcp").summary).toBe("/mcp serves 2 maintainers. It has no connectors.");
    expect(map.height).toBeGreaterThan(0);
    const member = connectionMap(structuredClone(OPERATOR_V2_MEMBER) as OperatorUiContractV2);
    expect(member.nodes).toEqual([]);
    expect(member.edges).toEqual([]);
  });
});
