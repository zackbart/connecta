import { reviewedClassification, type VettedCatalog } from "../../src/catalog-drift.js";
import type { Connector, ToolVerdict } from "../../src/types.js";

/** A custom connector fixture declaring its review through the public field. */
export function reviewedFixture(connector: Connector, catalog: VettedCatalog): Connector {
  const verdicts: Record<string, ToolVerdict> = {
    "read-only": "read", additive: "write", destructive: "destructive",
  };
  return {
    ...connector,
    classification: reviewedClassification({
      tools: Object.fromEntries([...catalog.tools].map(([name, record]) => [name, {
        verdict: verdicts[record.verdict]!,
        ...(record.schemaDigest ? { schemaDigest: record.schemaDigest } : {}),
      }])),
    }, "fixture"),
  };
}
