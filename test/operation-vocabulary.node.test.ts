// Node-only: broad ranking and cache work are pure logic; the hatch boundary also runs on workerd.
import { describe, expect, it, vi } from "vitest";
import { apiConnector, type ApiTool } from "../src/connectors/api-connector.js";
import { CatalogService, flatSearchResult } from "../src/catalog-service.js";
import { registerOperationVocabulary, OPERATION_VOCABULARY_BOUNDS } from "../src/operation-vocabulary.js";
import { providerFixtures } from "./providers.generated.js";
import { makeRegistry } from "./helpers.js";

function fixture() {
  const declarations: ApiTool[] = ["search", "read", "write"].map((kind) => ({
    name: `crm_api_${kind}`,
    description: `Inspect the CRM ${kind} interface.`,
    annotations: { readOnlyHint: kind !== "write" },
    handler: vi.fn(),
  }));
  const rows = vi.fn(function* () {
    yield { text: "List Tap devices", route: "crm_api_read", write: false };
    yield { text: "Update donor account", route: "crm_api_write", write: true };
    yield { text: "List webhook subscriptions", route: "crm_api_read", write: false };
  });
  registerOperationVocabulary(declarations[0]!, rows);
  return { connector: apiConnector("crm", { tools: declarations }), declarations, rows };
}

describe("bounded operation vocabulary", () => {
  it("INV-2 INV-4 INV-10: finds a single operation's vocabulary, without calls or widening grants", async () => {
    const { connector, declarations, rows } = fixture();
    const registry = makeRegistry([connector]);
    const search = (query: string, safety?: "readOnly" | "approvalRequired") =>
      new CatalogService(registry, "https://connecta.test")
        .search({ query, ...(safety ? { safety } : {}) })
        .then(flatSearchResult);
    for (const query of ["Tap devices", "webhook subscriptions", "edit donor account"]) {
      expect((await search(query)).tools[0]?.address).toBe("crm.crm_api_search");
    }
    expect((await search("donor devices")).tools).toEqual([]);
    expect((await search("donor account", "readOnly")).tools).toEqual([]);
    expect((await search("Tap devices", "approvalRequired")).tools).toEqual([]);
    expect((await search("donor account", "approvalRequired")).tools[0]?.address).toBe("crm.crm_api_search");
    const scoped = registry.scoped({
      connectorIds: ["crm"],
      toolAccess: new Map([["crm", new Set(["crm_api_search"])]]),
    });
    expect((await new CatalogService(scoped, "https://connecta.test").search({ query: "Tap devices" })).total).toBe(0);
    expect(
      (
        await new CatalogService(registry, "https://connecta.test", { readOnly: true }).search({
          query: "donor account",
        })
      ).total,
    ).toBe(0);
    expect(rows).toHaveBeenCalledTimes(1);
    for (const tool of declarations) expect(tool.handler).not.toHaveBeenCalled();
  });

  it("INV-10: caps compilation, query work and cache residency without joining enormous descriptions", async () => {
    const { connector, declarations } = fixture();
    let visited = 0;
    registerOperationVocabulary(declarations[0]!, function* () {
      for (let i = 0; i < 1_000_000; i++) {
        visited++;
        yield { text: `widget${i}`, route: "crm_api_read", write: false };
      }
    });
    // Capture the replacement registration at the same construction seam.
    const bounded = apiConnector("bounded", { tools: declarations });
    const catalog = new CatalogService(makeRegistry([connector, bounded]), "https://connecta.test");
    for (let i = 0; i < OPERATION_VOCABULARY_BOUNDS.cache + 2; i++)
      await catalog.search({ query: `widget${i}`, connector: "bounded" });
    expect(visited).toBe(OPERATION_VOCABULARY_BOUNDS.operations + 1);
    expect((await catalog.search({ query: "widget9000", connector: "bounded" })).total).toBe(0);
    expect((await catalog.search({ query: "widget1 ".repeat(30), connector: "bounded" })).total).toBe(0);
    expect(visited).toBe(OPERATION_VOCABULARY_BOUNDS.operations + 1);
  });

  it("INV-2 INV-10 INV-12: retrieves held-out domains across real indexes and preserves exact authored relevance", async () => {
    const connectors = providerFixtures
      .filter((f) => ["overflow", "tithely", "cloudflare", "stripe"].includes(f.name))
      .map((f) => f.create(f.name));
    const catalog = new CatalogService(makeRegistry(connectors), "https://connecta.test");
    for (const [connector, query, address] of [
      ["overflow", "Tap devices", "overflow.overflow_api_search"],
      ["overflow", "webhook subscriptions", "overflow.overflow_api_search"],
      ["tithely", "edit donor account", "tithely.tithely_api_search"],
      ["stripe", "radar value lists", "stripe.stripe_api_search"],
      ["cloudflare", "urlscanner search", "cloudflare.cloudflare_api_search"],
    ] as const) {
      const result = flatSearchResult(await catalog.search({ query, connector, limit: 8 }));
      expect(
        result.tools.map((t) => t.address),
        `${connector}: ${query}`,
      ).toContain(address);
      expect(JSON.stringify(result).length).toBeLessThan(16_384);
      expect(flatSearchResult(await catalog.search({ query, connector, limit: 8 }))).toEqual(result);
    }
    expect(
      flatSearchResult(await catalog.search({ query: "get_balance_summary", connector: "stripe" })).tools[0]?.name,
    ).toBe("get_balance_summary");
  });
});
