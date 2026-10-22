import { describe, expect, it, vi } from "vitest";
import { detectCatalogDrift, reviewedCatalog, vettedSchemaDigest } from "../src/catalog-drift.js";
import { driftState, driftSummary } from "../src/operator-ui/view.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, ToolClassification, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
function registry(connector: Connector) {
  return new Registry([connector], { storage: memoryStorage(), logger: silentLogger, toolCacheTtlSeconds: 0 });
}
const tool = (inputSchema: Record<string, unknown> = { type: "object" }): ToolDef => ({ name: "list", inputSchema });
const reviewed = (tools: ToolClassification["tools"]) => reviewedCatalog({ tools }, "test");

describe("catalog drift correctness", () => {
  it("INV-1: normalizes schema set arrays while retaining tuple and data array order", async () => {
    const schema = (reverse: boolean) => ({
      type: "object",
      required: reverse ? ["b", "a"] : ["a", "b"],
      properties: {
        a: {
          type: reverse ? ["string", "null"] : ["null", "string"],
          enum: reverse ? [{ x: [1, 2] }, "a"] : ["a", { x: [1, 2] }],
        },
      },
    });
    const digest = await vettedSchemaDigest(tool(schema(false)));
    expect(digest).toMatch(/^sha256-sets-v1:/);
    expect(
      await detectCatalogDrift(reviewed({ list: { verdict: "read", schemaDigest: digest } }), [tool(schema(true))]),
    ).toMatchObject({ schemaChanges: 0 });
    for (const keyword of ["prefixItems", "default", "examples", "const"]) {
      expect(await vettedSchemaDigest(tool({ [keyword]: [1, 2] }))).not.toBe(
        await vettedSchemaDigest(tool({ [keyword]: [2, 1] })),
      );
    }
    // These are data/property names, not schema keywords at this location.
    for (const keyword of ["default", "const", "properties"]) {
      expect(await vettedSchemaDigest(tool({ [keyword]: { required: ["a", "b"] } }))).not.toBe(
        await vettedSchemaDigest(tool({ [keyword]: { required: ["b", "a"] } })),
      );
    }
  });

  it("INV-1: preserves legacy provider pins and checks their complete schema", async () => {
    const definition = tool({ type: "object", required: ["b", "a"] });
    const schemaDigest = await vettedSchemaDigest(definition, "legacy");
    const catalog = reviewed({ list: { verdict: "read", schemaDigest } });
    expect((await detectCatalogDrift(catalog, [definition])).schemaChanges).toBe(0);
    expect((await detectCatalogDrift(catalog, [tool({ type: "object", required: ["b"] })])).schemaChanges).toBe(1);
    expect(schemaDigest).toMatch(/^sha256:/);
  });

  it("INV-1: tolerates explicitly gated absence but still checks a present optional tool", async () => {
    const catalog = reviewed({ list: "read", gated: { verdict: "read", optional: true } });
    expect((await detectCatalogDrift(catalog, [tool()])).unservedTools).toBe(0);
    expect(
      (await detectCatalogDrift(catalog, [tool(), { name: "gated", annotations: { readOnlyHint: false } }]))
        .annotationConflicts,
    ).toBe(1);
    expect((await detectCatalogDrift(catalog, [])).unservedTools).toBe(1);
  });

  it("INV-6: reports unpinned and partial schema coverage without claiming a clean comparison", async () => {
    const connector = {
      ...connectorWith({ id: "crm", tools: [tool(), { name: "get" }] }),
      classification: { tools: { list: "read", get: "read" } },
    } as Connector;
    const status = await registry(connector).statusFor("crm", BASE);
    expect(status.catalogDrift).toMatchObject({
      reviewedBaseline: true,
      verification: "complete",
      schemaCoverage: { pinned: 0, unpinned: 2 },
    });
    expect(driftState(status.catalogDrift)).toBe("unavailable");
    expect(driftSummary(status.catalogDrift)).toContain("Schemas not pinned");
    const partial = (
      await registry({
        ...connector,
        classification: {
          tools: {
            list: { verdict: "read", schemaDigest: await vettedSchemaDigest(tool()) },
            get: "read",
          },
        },
      }).statusFor("crm", BASE)
    ).catalogDrift!;
    expect(partial.schemaCoverage).toEqual({ pinned: 1, unpinned: 1 });
    expect(driftState(partial)).toBe("unavailable");
    expect(driftSummary(partial)).toContain("Partial schema coverage");
    expect(driftState({ ...partial, schemaCoverage: { pinned: 2, unpinned: 0 } })).toBe("clean");
  });

  it("INV-1 INV-6: replaces an earlier clean report when digest verification fails and recovers later", async () => {
    const schemaDigest = await vettedSchemaDigest(tool());
    const app = registry({
      ...connectorWith({ id: "crm", tools: [tool()], status: async () => ({ state: "ok" }) }),
      classification: { tools: { list: { verdict: "read", schemaDigest } } },
    });
    await app.getTools("crm", BASE);
    expect(driftState((await app.statusFor("crm", BASE)).catalogDrift)).toBe("clean");
    const original = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (new TextDecoder().decode(data as Uint8Array).startsWith('{"inputSchema"'))
        throw new Error("private downstream detail");
      return original(algorithm, data);
    });
    try {
      expect((await app.getTools("crm", BASE))[0]?.classification).not.toBe("read");
      const report = (await app.statusFor("crm", BASE)).catalogDrift;
      expect(report).toMatchObject({ verification: "unavailable" });
      expect(driftState(report)).toBe("unavailable");
      expect(driftSummary(report)).toContain("Schema verification unavailable");
      expect(JSON.stringify(report)).not.toContain("private downstream detail");
    } finally {
      spy.mockRestore();
    }
    await app.getTools("crm", BASE);
    expect(driftState((await app.statusFor("crm", BASE)).catalogDrift)).toBe("clean");
  });

  it.each(["personal", "shared"] as const)(
    "INV-4 INV-6: isolates %s observations by subject and deployment registry",
    async (authScope) => {
      let listing = [tool()];
      const connector: Connector = {
        ...connectorWith({ id: "crm", authScope, tools: async () => listing, status: async () => ({ state: "ok" }) }),
        classification: { tools: { list: "read" } },
      };
      const root = registry(connector);
      const alice = root.scoped({ principalKey: "alice", subjectKey: "alice", connectorIds: ["crm"] });
      const bob = root.scoped({ principalKey: "bob", subjectKey: "bob", connectorIds: ["crm"] });
      await alice.getTools("crm", BASE);
      listing = [tool(), { name: "extra" }, { name: "bad\u0000name" }];
      await bob.getTools("crm", BASE);
      expect((await alice.statusFor("crm", BASE)).catalogDrift).toMatchObject({ unclassifiedTools: 0 });
      expect((await alice.statusFor("crm", BASE)).catalogDrift?.droppedTools).toBeUndefined();
      expect((await bob.statusFor("crm", BASE)).catalogDrift).toMatchObject({ unclassifiedTools: 1, droppedTools: 1 });
      expect((await root.statusFor("crm", BASE)).catalogDrift).toBeUndefined();
      expect((await registry(connector).statusFor("crm", BASE)).catalogDrift).toBeUndefined();
    },
  );
});
