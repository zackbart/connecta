import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperatorUiContract } from "../src/operator-ui/contract.js";
import type { UiData } from "../src/operator-ui/model.js";
import { createOperatorVisualFixture, VISUAL_STATES } from "./fixtures/operator-visual.js";

// These fixtures pass through the current config/data/detail routes at creation.
// Validate the relationships the browser relies on as well as their TS contract:
// a matching shape with mismatched IDs/grants would still produce misleading UI.
describe("operator visual fixture contract", () => {
  it.each(VISUAL_STATES)("INV-4 INV-6: validates the %s fixture against the server contract", async state => {
    const fixture = await createOperatorVisualFixture(state);
    expectTypeOf(fixture.contract).toEqualTypeOf<OperatorUiContract>();
    expectTypeOf(fixture.data).toEqualTypeOf<UiData>();
    const { contract, data } = fixture;
    expect(contract.schemaVersion).toBe(1);
    expect(contract.config.schemaVersion).toBe(1);
    expect(contract.configSources?.["config.limits.calls.maxResultBytes"]).toBe("config");
    const ids = contract.config.connectors.map(c => c.id);
    expect(contract.live.connectors.map(c => c.id)).toEqual(ids);
    expect(data.connectors.map(c => c.id)).toEqual(ids);
    expect(contract.you.permissions.connectors.map(c => c.id)).toEqual(ids);
    expect(data.connectaVersion).toBe(contract.config.connectaVersion);
    for (const live of contract.live.connectors) {
      const detail = data.connectors.find(c => c.id === live.id)!;
      expect(detail.status).toBe(live.status);
      expect(detail.tools.map(t => t.address)).toEqual(live.tools.map(t => t.address));
      for (const tool of live.tools) {
        expect(tool.address).toBe(`${live.id}.${tool.name}`);
        expect(["read", "write"]).toContain(tool.classification);
        expect(detail.tools.find(t => t.address === tool.address)?.safety).toBe(tool.classification === "read" ? "runs_in_programs" : "needs_approval");
      }
    }
    for (const pool of contract.you.pools) {
      expect(contract.config.pools.find(p => p.name === pool.name)?.trust).toBe(pool.trust);
      for (const grant of pool.grants) expect(ids).toContain(grant.connectorId);
    }
    if (state === "restricted") {
      expect(ids).toEqual(["github", "slot"]);
      expect(contract.you.permissions).toMatchObject({ activity: false, artifacts: false, accessTokenManagement: false });
      expect(contract.you.permissions.connectors.every(p => !p.manageSharedAuth && !p.connectPersonal)).toBe(true);
    } else if (state !== "empty") {
      expect(contract.live.connectors.find(c => c.id === "slot")?.status).toBe("credential_required");
    }
    // Only fixed metadata reaches these records; test fixture tokens and the
    // vault key must not become server-produced contract or detail facts.
    expect(JSON.stringify({ contract, data })).not.toContain("visual-operator");
    expect(JSON.stringify({ contract, data })).not.toContain("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=");
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
  });
});
