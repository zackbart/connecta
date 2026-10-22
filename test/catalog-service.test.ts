// The request-scoped catalog cache and the discovery probes above it
// (P1-S11). Ranking, rendering, and the wire shapes are guarded by
// catalog.test.ts, meta-tools-search.test.ts, and execute.test.ts; this suite
// pins the request lifetime and fixed catalog failure contract.
import { describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { buildSandboxProviders } from "../src/execute.js";
import type { ExecutorProvider, ToolDef } from "../src/types.js";
import { connectorWith } from "./fixtures/connectors.js";
import { makeRegistry, required, silentLogger } from "./helpers.js";

const BASE = "https://connecta.test";
const READ: ToolDef = { name: "read", annotations: { readOnlyHint: true } };

interface ScopedPage {
  queryAnalysis?: {
    unavailableConnectorCount?: number;
    catalogError?: { code: string; message: string; retryable: boolean };
  };
}

function hangingConnector() {
  return connectorWith({
    id: "hang",
    kind: "mcp",
    tools: async () => new Promise<never>(() => {}),
  });
}

function connectaProvider(providers: ExecutorProvider[]): ExecutorProvider {
  return required(providers.find((provider) => provider.name === "connecta"));
}

describe("catalog probe deadlines", () => {
  it("returns fixed code-based text in a scoped program search's timed-out catalogError", async () => {
    const providers = await buildSandboxProviders(makeRegistry([hangingConnector()]), BASE, silentLogger, undefined, {
      probeTimeoutMs: 25,
    });
    const page = (await required(connectaProvider(providers).fns.search)({
      connector: "hang",
    })) as ScopedPage;

    const catalogError = required(page.queryAnalysis?.catalogError);
    expect(catalogError.code).toBe("timeout");
    expect(catalogError.message).toBe('Connector "hang" catalog lookup failed (timeout).');
  });
});

describe("request-scoped catalog cache", () => {
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

  it("drops a failed read so the next ask in the request reads again, then keeps the success", async () => {
    let reads = 0;
    const flaky = connectorWith({
      id: "flaky",
      kind: "api",
      tools: async () => {
        reads++;
        if (reads === 1) throw new Error("upstream unavailable");
        return [READ];
      },
    });
    const service = new CatalogService(makeRegistry([flaky]), BASE);

    const first = (await service.search({ connector: "flaky" })) as ScopedPage;
    expect(first.queryAnalysis?.unavailableConnectorCount).toBe(1);
    expect(first.queryAnalysis?.catalogError?.message).toBe(
      'Connector "flaky" catalog lookup failed (catalog_lookup_failed).',
    );

    const [described] = await service.describe({ address: "flaky.read" });
    expect(described?.name).toBe("read");
    const resolved = await service.resolveTool("flaky.read");
    expect(resolved.ok).toBe(true);
    expect(reads).toBe(2);
  });
});
