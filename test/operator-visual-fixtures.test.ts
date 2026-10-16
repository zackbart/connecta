import { describe, expect, expectTypeOf, it } from "vitest";
import type { OperatorUiContractV2 } from "../src/operator-ui/contract.js";
import type { UiData } from "../src/operator-ui/model.js";
import { OPERATOR_V2_MEMBER_EXPECTED } from "./fixtures/operator-contract-v2.js";
import { expectMemberViewWithholds } from "./helpers/operator-member-view.js";
import {
  createOperatorVisualFixture,
  VISUAL_STATES,
  VISUAL_VARIANTS,
  operatorVisualVariant,
} from "./fixtures/operator-visual.js";

// These fixtures pass through the current config/data/detail routes at creation.
// Validate the relationships the browser relies on as well as their TS contract:
// a matching shape with mismatched IDs/grants would still produce misleading UI.
describe("operator visual fixture contract", () => {
  it.each(VISUAL_STATES)("INV-4 INV-6: validates the %s fixture against the server contract", async (state) => {
    const fixture = await createOperatorVisualFixture(state);
    expectTypeOf(fixture.contract).toEqualTypeOf<OperatorUiContractV2>();
    expectTypeOf(fixture.data).toEqualTypeOf<UiData>();
    const { contract, data } = fixture;
    expect(contract.schemaVersion).toBe(2);
    // Only fixed metadata reaches these records; test fixture tokens and the
    // vault key must not become server-produced contract or detail facts.
    expect(JSON.stringify({ contract, data })).not.toContain("visual-operator");
    expect(JSON.stringify({ contract, data })).not.toContain("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=");
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture);
    if (state === "restricted") {
      // The restricted viewer is a pool member: the complete body withholds every maintainer fact.
      expect(contract.role).toBe("member");
      expectMemberViewWithholds(JSON.parse(JSON.stringify(contract)), OPERATOR_V2_MEMBER_EXPECTED);
      return;
    }
    expect(contract.role).toBe("maintainer");
    const config = contract.config!;
    expect(config.schemaVersion).toBe(1);
    expect(config.hasGrant).toBe(state !== "empty");
    expect(contract.configSources?.["config.hasGrant"]).toBe(state === "empty" ? "default" : "config");
    expect(contract.configSources?.["config.limits.calls.maxResultBytes"]).toBe("config");
    const ids = config.connectors.map((c) => c.id);
    expect(contract.live.connectors.map((c) => c.id)).toEqual(ids);
    expect(data.connectors.map((c) => c.id)).toEqual(ids);
    expect(data.connectaVersion).toBe(config.connectaVersion);
    for (const live of contract.live.connectors) {
      const detail = data.connectors.find((c) => c.id === live.id)!;
      expect(detail.status).toBe(live.status);
      expect(detail.tools.map((t) => t.address)).toEqual(live.tools.map((t) => t.address));
      for (const tool of live.tools) {
        expect(tool.address).toBe(`${live.id}.${tool.name}`);
        expect(["read", "write"]).toContain(tool.classification);
        expect(detail.tools.find((t) => t.address === tool.address)?.safety).toBe(
          tool.classification === "read" ? "runs_in_programs" : "needs_approval",
        );
      }
    }
    expect(contract.pools.map((p) => p.name)).toEqual(config.pools.map((p) => p.name));
    for (const pool of contract.pools) {
      expect(config.pools.find((p) => p.name === pool.name)?.readOnly).toBe(pool.readOnly);
      for (const grant of pool.tools) expect(ids).toContain(grant.connectorId);
    }
    // Every matrix cell names a configured connector and a served endpoint.
    for (const cell of contract.matrix) {
      expect(ids).toContain(cell.connectorId);
      if (cell.pool !== null) expect(contract.pools.map((p) => p.name)).toContain(cell.pool);
    }
    if (state === "empty") {
      expect(ids).toEqual([]);
      expect(contract.matrix).toEqual([]);
      expect(data.connectors).toEqual([]);
    } else {
      expect(contract.live.connectors.find((c) => c.id === "slot")?.status).toBe("credential_required");
    }
  });
  it("validates detail variants against the same contract and declared credential fields", async () => {
    const base = await createOperatorVisualFixture("populated");
    for (const variant of VISUAL_VARIANTS) {
      const { contract, data } = operatorVisualVariant(base, variant);
      for (const detail of data.connectors) {
        const live = contract.live.connectors.find((c) => c.id === detail.id)!;
        expect(detail.status, variant).toBe(live.status);
        expect(detail.registrationPath, variant).toBe(live.auth?.registrationPath);
        if (detail.credential?.fields) {
          const configured = contract.config?.connectors.find((c) => c.id === detail.id)?.credential?.fields;
          expect(
            detail.credential.fields.map((f) => ({ name: f.name, label: f.label })),
            variant,
          ).toEqual(configured?.map((f) => ({ name: f.name, label: f.label })));
        }
      }
      expect(JSON.parse(JSON.stringify({ contract, data }))).toEqual({ contract, data });
    }
  });
});
