// The request-scoped catalog cache and the discovery probes above it
// (P1-S11). Ranking, rendering, and the wire shapes are guarded by
// catalog.test.ts, meta-tools-search.test.ts, and execute.test.ts; this suite
// pins what the Effect port had to keep and the one label it corrected.
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
  it("names connecta.search, not search_tools, in a scoped program search's timed-out catalogError", async () => {
    const providers = await buildSandboxProviders(
      makeRegistry([hangingConnector()]),
      BASE,
      silentLogger,
      undefined,
      { probeTimeoutMs: 25 },
    );
    const page = (await required(connectaProvider(providers).fns.search)({
      connector: "hang",
    })) as ScopedPage;

    const catalogError = required(page.queryAnalysis?.catalogError);
    expect(catalogError.code).toBe("timeout");
    // A program cannot call search_tools; the message is echoed verbatim.
    expect(catalogError.message).toContain(
      'connecta.search probe of "hang" timed out after 25ms',
    );
    expect(catalogError.message).not.toContain("search_tools");
  });

  it("keeps naming search_tools for the top-level route", async () => {
    const page = await new CatalogService(
      makeRegistry([hangingConnector()]),
      BASE,
      { probeTimeoutMs: 25 },
    ).search({ connector: "hang" });

    expect(page.queryAnalysis?.catalogError?.message).toContain(
      'search_tools probe of "hang" timed out after 25ms',
    );
  });

  it("ends only the timed-out asker's wait; a joiner still receives the shared read", async () => {
    let reads = 0;
    let release: ((tools: ToolDef[]) => void) | undefined;
    const slow = connectorWith({
      id: "slow",
      kind: "mcp",
      // Ignores its signal, as a connector may.
      tools: () => {
        reads++;
        return new Promise<ToolDef[]>((resolve) => {
          release = resolve;
        });
      },
    });
    const service = new CatalogService(makeRegistry([slow]), BASE, {
      probeTimeoutMs: 20,
    });

    const searched = service.search({ connector: "slow" });
    const joined = service.loadConnector("slow");
    const page = await searched;
    expect(page.queryAnalysis?.catalogError?.code).toBe("timeout");

    required(release)([READ]);
    await expect(joined).resolves.toEqual([READ]);
    // The read the probe started now serves the rest of the request.
    const again = await service.search({ connector: "slow" });
    expect(again.entries.map((entry) => entry.tool.address)).toEqual([
      "slow.read",
    ]);
    expect(reads).toBe(1);
  });
});

describe("request-scoped catalog cache", () => {
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
      "upstream unavailable",
    );

    const [described] = await service.describe({ address: "flaky.read" });
    expect(described?.name).toBe("read");
    const resolved = await service.resolveTool("flaky.read");
    expect(resolved.ok).toBe(true);
    expect(reads).toBe(2);
  });

  it("joins concurrent asks for one connector into one read", async () => {
    let reads = 0;
    const counted = connectorWith({
      id: "counted",
      kind: "api",
      tools: async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return [READ];
      },
    });
    const service = new CatalogService(makeRegistry([counted]), BASE);

    const [page, described, resolved, loaded] = await Promise.all([
      service.search({}),
      service.describe({ address: "counted.read" }),
      service.resolveTool("counted.read"),
      service.loadConnector("counted"),
    ]);
    expect(page.entries.map((entry) => entry.tool.address)).toEqual([
      "counted.read",
    ]);
    expect(described[0]?.name).toBe("read");
    expect(resolved.ok).toBe(true);
    expect(loaded).toEqual([READ]);
    expect(reads).toBe(1);
  });

  it("rejects a synchronous getTools throw like an asynchronous one and does not cache it", async () => {
    const registry = makeRegistry([
      connectorWith({ id: "sync", kind: "api", tools: [READ] }),
    ]);
    let throws = true;
    const getTools = registry.getTools.bind(registry);
    const view = Object.assign(Object.create(registry) as typeof registry, {
      getTools: (...args: Parameters<typeof registry.getTools>) => {
        if (throws) throw new Error("synchronous failure");
        return getTools(...args);
      },
    });
    const service = new CatalogService(view, BASE);

    await expect(service.loadConnector("sync")).rejects.toThrow(
      "synchronous failure",
    );
    throws = false;
    await expect(service.loadConnector("sync")).resolves.toEqual([READ]);
  });
});
