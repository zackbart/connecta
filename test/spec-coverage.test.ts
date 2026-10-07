import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repositoryTitles } from "./fixtures/test-titles.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const coverage = JSON.parse(readFileSync(new URL("../spec/coverage.json", import.meta.url), "utf8")) as {
  revision: string;
  features: Array<{
    id: string;
    status: string;
    spec: string;
    notes: string;
    issue?: string;
    decision?: string;
    tests?: Array<{ file: string; title: string }>;
  }>;
};
const titles = repositoryTitles(ROOT).filter(({ kind, disabled }) => kind === "test" && !disabled);

// Snapshot of the 2026-07-28 specification's component inventory and official
// extensions, linked in coverage.sources. Update with a spec revision, not just
// when deleting an inconvenient row. Deprecated features remain explicit.
const FEATURES = [
  "json-rpc", "version-negotiation", "request-metadata", "stateless-requests",
  "icons", "server-discovery", "streamable-http", "stdio", "authorization",
  "authorization-server-discovery", "client-registration", "authorization-security",
  "tools-list", "tools-call", "tool-annotations", "tool-input-schema",
  "tool-output-schema", "tool-content", "resources", "prompts", "elicitation",
  "multi-round-trip-requests", "subscriptions", "cancellation", "progress",
  "caching", "pagination", "completion", "json-schema", "trace-context",
  "sampling", "roots", "logging", "legacy-lifecycle",
  "io.modelcontextprotocol/ui", "io.modelcontextprotocol/skills",
  "io.modelcontextprotocol/tasks", "io.modelcontextprotocol/oauth-client-credentials",
  "io.modelcontextprotocol/enterprise-managed-authorization",
];

describe("MCP specification coverage", () => {
  it("records every core component and official extension once for the target revision", () => {
    expect(coverage.revision).toBe("2026-07-28");
    expect(coverage.features.map(({ id }) => id).sort()).toEqual([...FEATURES].sort());
  });

  it("backs implemented claims with exact existing test titles and future choices with references", () => {
    for (const feature of coverage.features) {
      expect(["supported", "partial", "planned", "declined"], feature.id).toContain(feature.status);
      expect(feature.spec, feature.id).toMatch(/^https:\/\/modelcontextprotocol\.io\//);
      expect(feature.notes.trim().length, feature.id).toBeGreaterThan(0);
      if (["supported", "partial"].includes(feature.status)) {
        expect(feature.tests?.length ?? 0, feature.id).toBeGreaterThan(0);
      } else {
        expect(feature.issue ?? feature.decision, feature.id)
          .toMatch(/^https:\/\/github\.com\/zackbart\/connecta\/(?:issues|pull)\/\d+(?:#.*)?$/);
      }
      for (const reference of feature.tests ?? []) {
        expect(titles.some(({ file, title }) => file === reference.file && title === reference.title),
          `${feature.id}: ${reference.file}: ${reference.title}`).toBe(true);
      }
    }
  });
});
