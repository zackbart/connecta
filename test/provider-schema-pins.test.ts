import { describe, expect, it } from "vitest";
import { catalogReviewOf, detectCatalogDrift, reviewedCatalog, vettedSchemaDigest } from "../src/catalog-drift.js";
import { hostedCatalog as linearSchemas } from "../src/providers/linear/fixtures.js";
import { hostedSchemaFixtures as mixpanelSchemas } from "../src/providers/mixpanel/fixtures.js";
import remainingMixpanelSchemas from "../src/providers/mixpanel/catalog.fixture.json";
import revenuecatContracts from "../src/providers/revenuecat/contracts.fixture.json";
import { hostedTools as stripeSchemas } from "../src/providers/stripe/fixtures.js";
import type { ToolDef } from "../src/types.js";
import { providerFixtures } from "./providers.generated.js";

// A provider that adds a pin must also capture the complete schemas it reviewed.
// Iterate the generated roster and every construction case so a new provider or
// a non-default hosted implementation cannot silently escape this guard.
const capturedSchemas: Record<string, readonly ToolDef[]> = {
  linear: linearSchemas,
  // Remaining full schemas captured through hosted discovery on 2026-10-19.
  // Every capture must match the existing pin; no baseline is accepted here.
  mixpanel: [...mixpanelSchemas, ...remainingMixpanelSchemas],
  revenuecat: revenuecatContracts.tools,
  stripe: stripeSchemas,
};

describe.each(providerFixtures)("$name schema pins", (fixture) => {
  it("INV-1: verifies every provider pin against captured schemas and rejects input and output changes", async () => {
    const captured = new Map((capturedSchemas[fixture.name] ?? []).map((tool) => [tool.name, tool]));
    const checked = new Set<string>();
    for (const options of [{}, ...fixture.cases.map((entry) => entry.options)]) {
      const catalog = catalogReviewOf(fixture.create("fixture", options as never));
      for (const [name, record] of catalog?.tools ?? []) {
        if (record.schemaDigest === undefined) continue;
        const key = `${name}:${record.schemaDigest}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const tool = captured.get(name);
        expect(tool, `${fixture.name}.${name} needs a complete captured schema`).toBeDefined();
        const review = reviewedCatalog(
          { tools: { [name]: { verdict: "read", schemaDigest: record.schemaDigest } } },
          fixture.name,
        );
        expect((await detectCatalogDrift(review, [tool!])).schemaChanges, name).toBe(0);
        for (const field of ["inputSchema", "outputSchema"] as const) {
          const changed = { ...tool!, [field]: { not: tool![field] ?? {} } };
          expect((await detectCatalogDrift(review, [changed])).schemaChanges, `${name}.${field}`).toBe(1);
        }
      }
    }
  });
});

it.each(["legacy", "sets-v1"] as const)(
  "INV-1: verifies %s provider pins without weakening genuine schema drift detection",
  async (format) => {
    const tool = linearSchemas[0]!;
    const schemaDigest = await vettedSchemaDigest(tool, format);
    const review = reviewedCatalog({ tools: { [tool.name]: { verdict: "read", schemaDigest } } }, "fixture");
    expect((await detectCatalogDrift(review, [tool])).schemaChanges).toBe(0);
    for (const field of ["inputSchema", "outputSchema"] as const) {
      expect((await detectCatalogDrift(review, [{ ...tool, [field]: { not: tool[field] ?? {} } }])).schemaChanges).toBe(
        1,
      );
    }
  },
);
