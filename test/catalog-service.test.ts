// The request-scoped catalog cache and the discovery probes above it
// (P1-S11). Ranking, rendering, and the wire shapes are guarded by
// catalog.test.ts, meta-tools-search.test.ts, and execute.test.ts; this suite
// guards ownership of catalog snapshots across consumers.
import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { MAX_CATALOG_TOOLS } from "../src/catalog-limits.js";
import { Effect } from "effect";
import { runEdge } from "../src/runtime/run.js";
import { openRequest } from "../src/runtime/call.js";
import type { ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeRegistry } from "./helpers.js";

const BASE = "https://connecta.test";

describe("request-scoped catalog cache", () => {
  it("INV-8: a native complete-catalog ceiling failure reaches Effect.result without a partial catalog", async () => {
    const connector = connectorWith({ id: "large", tools: Array(MAX_CATALOG_TOOLS + 1).fill({ name: "read" }) });
    const service = new CatalogService(makeRegistry([connector]), BASE);
    try {
      const result = await runEdge(Effect.result(service.loadConnectorEffect("large")));
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({ message: expect.stringContaining("complete-catalog ceiling") });
      const catalogs = await runEdge(service.listCatalogsEffect());
      expect(catalogs).toEqual([
        { connector, error: expect.objectContaining({ message: expect.stringContaining("complete-catalog ceiling") }) },
      ]);
    } finally {
      openRequest(service.requestScope).close();
    }
  });
  it("INV-1 INV-3: owns its snapshot and never shares definitions with discovery or invocation consumers", async () => {
    const original: ToolDef = {
      name: "read",
      classification: "read",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    };
    const registry = makeRegistry([connectorWith({ id: "owned", tools: [original] })]);
    // Simulate a registry view that returns the same mutable listing.
    const view = Object.assign(Object.create(registry) as typeof registry, {
      getTools: async () => [original],
    });
    const service = new CatalogService(view, BASE);
    const loaded = await service.loadConnector("owned");
    const mutate = (tool: ToolDef) => {
      tool.annotations!.readOnlyHint = false;
      (tool.inputSchema!.properties as Record<string, { type: string }>).id!.type = "number";
    };
    const expected = structuredClone(original);
    mutate(original);
    mutate(loaded[0]!);
    const resolution = await service.resolveTool("owned.read");
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("expected a catalog resolution");
    expect(resolution.resolved.definition).toEqual(expected);
    mutate(resolution.resolved.definition);
    await expect(service.loadConnector("owned")).resolves.toEqual([expected]);
    const page = await service.search({ includeSchemas: "json" });
    mutate(page.entries[0]!.tool as ToolDef);
    const described = await service.describe({ address: "owned.read", format: "json" });
    expect(described[0]).toMatchObject(expected);
    mutate(described[0] as ToolDef);
    await expect(service.loadConnector("owned")).resolves.toEqual([expected]);
  });
});
