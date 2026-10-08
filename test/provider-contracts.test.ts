import { describe, expect, it } from "vitest";
import hosted from "./fixtures/hosted-presets-abc0d176.json";
import before from "./fixtures/providers-before-5b.json";
import trustChanges from "./fixtures/providers-p2-item1-contract-changes.json";
import { providerContract, type ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";

// Captured from 919c149 before moving modules, using the same fixtures and
// registry path. Each SHA-256 covers the complete serialized field, including
// every describe() schema, rather than a partial match or a selected subset.
// Phase 2 item 1 removes classifications from raw connector descriptions and
// revises Breeze/Cloudflare write routing guides. Keep those explicit changes
// separate so the original migration baseline still guards every other field.
// Converted hosted providers have their subsequent baseline in hosted-presets.test.ts.
describe.each(providerFixtures.filter((fixture) => !Object.hasOwn(hosted.providers, fixture.name)) as unknown as ContractFixture[])("$name provider contract", (fixture) => {
  it("INV-1: preserves provider contracts with explicit classifier and trust changes", async () => {
    const actual = await providerContract(fixture);
    const snapshot = await Promise.all(actual.map(async (row) => Object.fromEntries(await Promise.all(
      Object.entries(JSON.parse(JSON.stringify(row)) as Record<string, unknown>).map(async ([key, value]) => {
        if (key === "label") return [key, value];
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        return [key, [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")];
      }),
    ))));
    const changes = trustChanges as Record<string, Record<string, Record<string, string>>>;
    const expected = before[fixture.name as keyof typeof before].map((row) => ({
      ...row, ...changes[fixture.name]?.[row.label],
    }));
    expect(snapshot).toEqual(expected);
  });
  it("INV-11: names the provider and id in construction refusals", () => {
    const factory = fixture.name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    expect(() => fixture.create("bad", { purpose: "" })).toThrow(`${factory}("bad") requires `);
  });
});
