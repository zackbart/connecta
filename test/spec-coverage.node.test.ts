// Node-only: reads the MCP coverage record from the checkout.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

// Snapshot of the 2026-07-28 specification's component inventory and official
// extensions, linked in coverage.sources. Update with a spec revision, not just
// when deleting an inconvenient row. Deprecated features remain explicit.
const FEATURES = [
  "json-rpc",
  "version-negotiation",
  "request-metadata",
  "stateless-requests",
  "icons",
  "server-discovery",
  "streamable-http",
  "stdio",
  "authorization",
  "authorization-server-discovery",
  "client-registration",
  "authorization-security",
  "tools-list",
  "tools-call",
  "tool-annotations",
  "tool-input-schema",
  "tool-output-schema",
  "tool-content",
  "resources",
  "prompts",
  "elicitation",
  "multi-round-trip-requests",
  "subscriptions",
  "cancellation",
  "progress",
  "caching",
  "pagination",
  "completion",
  "json-schema",
  "trace-context",
  "sampling",
  "roots",
  "logging",
  "legacy-lifecycle",
  "io.modelcontextprotocol/ui",
  "io.modelcontextprotocol/skills",
  "io.modelcontextprotocol/tasks",
  "io.modelcontextprotocol/oauth-client-credentials",
  "io.modelcontextprotocol/enterprise-managed-authorization",
];

describe("MCP specification coverage", () => {
  it("records every core component and official extension once for the target revision", () => {
    expect(coverage.revision).toBe("2026-07-28");
    expect(coverage.features.map(({ id }) => id).sort()).toEqual([...FEATURES].sort());
  });

  it("requires test evidence for implemented claims and decision references for future choices", () => {
    for (const feature of coverage.features) {
      expect(["supported", "partial", "planned", "declined"], feature.id).toContain(feature.status);
      expect(feature.spec, feature.id).toMatch(/^https:\/\/modelcontextprotocol\.io\//);
      expect(feature.notes.trim().length, feature.id).toBeGreaterThan(0);
      if (["supported", "partial"].includes(feature.status)) {
        expect(feature.tests?.length ?? 0, feature.id).toBeGreaterThan(0);
      } else {
        expect(feature.issue ?? feature.decision, feature.id).toMatch(
          /^https:\/\/github\.com\/zackbart\/connecta\/(?:issues|pull)\/\d+(?:#.*)?$/,
        );
      }
      // The end-of-run reporter checks these against passing runner cases.
      for (const reference of feature.tests ?? []) {
        expect(reference.file, feature.id).toMatch(/^test\/.*\.test\.ts$/);
        expect(reference.title.trim().length, feature.id).toBeGreaterThan(0);
      }
    }
  });

  it("records the 0.29.0 Deferred row as declined rather than planned", () => {
    for (const id of ["prompts", "subscriptions", "io.modelcontextprotocol/ui", "io.modelcontextprotocol/tasks"]) {
      const feature = coverage.features.find((feature) => feature.id === id)!;
      expect(feature.status, id).toBe("declined");
      expect(feature.decision, id).toBe("https://github.com/zackbart/connecta/issues/703");
      expect(feature.notes, id).toContain("Deferred row");
      expect(feature.notes, id).toContain("0.29.0");
    }
  });
});
