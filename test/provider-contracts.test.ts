import { describe, expect, it } from "vitest";
import before from "./fixtures/providers-before-5b.json";
import { providerContract, type ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";

// Captured from 919c149 before moving modules, using the same fixtures and
// registry path. Each SHA-256 covers the complete serialized field, including
// every describe() schema, rather than a partial match or a selected subset.
describe.each(providerFixtures as unknown as ContractFixture[])("$name provider move", (fixture) => {
  it("INV-1: preserves metadata, guide, registry classifications, and describe() byte for byte", async () => {
    const actual = await providerContract(fixture);
    const snapshot = await Promise.all(actual.map(async (row) => Object.fromEntries(await Promise.all(
      Object.entries(JSON.parse(JSON.stringify(row)) as Record<string, unknown>).map(async ([key, value]) => {
        if (key === "label") return [key, value];
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return [key, [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")];
      }),
    ))));
    expect(snapshot).toEqual(before[fixture.name as keyof typeof before]);
  });
  it("INV-11: names the provider and id in construction refusals", () => {
    const factory = fixture.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(() => fixture.create("bad", { purpose: "" })).toThrow(`${factory}("bad") requires `);
  });
});
