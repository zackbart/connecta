import { describe, expect, it } from "vitest";
import { endpointGroups } from "../src/operator-ui/endpoints.js";
import { createOperatorVisualFixture } from "./fixtures/operator-visual.js";

describe("endpoint tool inventory", () => {
  it("INV-1 INV-2 INV-4: intersects pools and grants with current read verdicts", async () => {
    const { contract } = await createOperatorVisualFixture("populated");
    const root = endpointGroups(contract, contract.you.grants, false);
    expect(root.flatMap((g) => g.tools.map((t) => t.address))).toEqual(["github.read", "github.write"]);
    const support = contract.you.pools.find((p) => p.name === "support")!;
    expect(
      endpointGroups(contract, support.grants, support.readOnly, support.name).flatMap((g) =>
        g.tools.map((t) => t.address),
      ),
    ).toEqual(["github.read"]);
    expect(endpointGroups(contract, contract.you.grants, true).flatMap((g) => g.tools.map((t) => t.address))).toEqual([
      "github.read",
    ]);
    const guarded = [{ connectorId: "github", tools: [{ name: "write", requireReadOnly: true }] }];
    expect(endpointGroups(contract, guarded, false).flatMap((g) => g.tools)).toEqual([]);
    expect(endpointGroups(contract, contract.you.grants, false, "absent")).toEqual([]);
    // A changed live verdict invalidates a guarded tool immediately.
    contract.live.connectors.find((c) => c.id === "github")!.tools[0]!.classification = "write";
    expect(endpointGroups(contract, support.grants, true, support.name).flatMap((g) => g.tools)).toEqual([]);
  });

  it("INV-4 INV-6: restricted endpoint rows contain only admitted connectors and tools", async () => {
    const { contract } = await createOperatorVisualFixture("restricted");
    expect(
      endpointGroups(contract, contract.you.grants, contract.you.readOnly).flatMap((g) =>
        g.tools.map((t) => t.address),
      ),
    ).toEqual(["github.read"]);
    expect(endpointGroups(contract, [], false)).toEqual([]);
  });
});
