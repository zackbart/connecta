import { describe, expect, it } from "vitest";
import type { ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";

describe.each(providerFixtures as unknown as ContractFixture[])("$name provider construction", (fixture) => {
  it("INV-2 INV-11: accepts and retains connector readOnly in every provider mode", () => {
    for (const scenario of fixture.cases) {
      for (const readOnly of [true, false]) {
        expect(fixture.create("reader", { ...scenario.options, readOnly }).readOnly).toBe(readOnly);
      }
      expect(() => fixture.create("reader", { ...scenario.options, readOnly: "true" })).toThrow(/readOnly.*boolean/);
    }
  });

  it("INV-11: names the provider and id in construction refusals", () => {
    const factory = fixture.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(() => fixture.create("bad", { purpose: "" })).toThrow(`${factory}("bad") requires `);
  });
});
