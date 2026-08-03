import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { linear } from "../src/providers/linear.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

// Unmocked on purpose. test/linear-provider.test.ts stubs remote-mcp to
// inspect the options linear() passes down; that suite can never catch a
// deployment that refuses to boot, because it never boots one. This one
// constructs the real connector, hands it to the real Registry, and would fail
// on an admission rule that declared a queue setting without a queue.
// Construction touches no network: fetch throws for the whole file.

const BASE_URL = "https://connecta.example";
const executor = { execute: async () => ({ result: null }) };

/**
 * Seed one connector's persisted catalog so `getTools` resolves from storage.
 * The key (`catalog:<id>`) is the namespace under test.
 */
async function seedCatalog(
  storage: KVStorage,
  id: string,
  toolName: string,
): Promise<void> {
  const now = Date.now();
  await storage.set(
    `catalog:${id}`,
    JSON.stringify({
      tools: [{ name: toolName, annotations: { readOnlyHint: true } }],
      fetchedAt: now,
      expiresAt: now + 600_000,
      staleUntil: now + 1_200_000,
    }),
  );
}

function twoWorkspaces(storage: KVStorage) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    discovery: { persistCatalog: true },
    connectors: [
      linear("linear_product", {
        purpose: "Product delivery planning",
      }),
      linear("linear_reporting", {
        purpose: "Executive delivery reporting",
        access: "read-only",
        // Only this instance opts into a ceiling; the other must stay unmetered.
        callAdmission: {
          rules: [
            {
              budget: {
                kind: "rolling-window",
                maxCalls: 500,
                windowMs: 3_600_000,
              },
            },
          ],
        },
      }),
    ],
  });
}

describe("linear() inside a real deployment", () => {
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => {
      throw new Error("network touched");
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("boots two workspaces without reaching the network", () => {
    const connecta = twoWorkspaces(memoryStorage());
    expect(
      connecta.registry.listConnectors().map((connector) => connector.id),
    ).toEqual(["linear_product", "linear_reporting"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives each workspace its own address namespace", () => {
    const connecta = twoWorkspaces(memoryStorage());
    expect(
      connecta.registry.resolveAddress("linear_product.list_issues")?.connector,
    ).toBe(connecta.registry.getConnector("linear_product"));
    expect(
      connecta.registry.resolveAddress("linear_reporting.list_issues")
        ?.connector,
    ).toBe(connecta.registry.getConnector("linear_reporting"));
    expect(connecta.registry.getConnector("linear_product")).not.toBe(
      connecta.registry.getConnector("linear_reporting"),
    );
  });

  it("keeps catalogs, storage, and credentials in separate namespaces", async () => {
    const storage = memoryStorage();
    const connecta = twoWorkspaces(storage);
    await seedCatalog(storage, "linear_product", "save_issue");
    await seedCatalog(storage, "linear_reporting", "list_projects");

    expect(
      (await connecta.registry.getTools("linear_product", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["save_issue"]);
    expect(
      (await connecta.registry.getTools("linear_reporting", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["list_projects"]);

    // Downstream OAuth registration and tokens ride connector-scoped storage,
    // so one workspace's credentials are unreachable from the other's context.
    const product = connecta.registry.contextFor("linear_product", BASE_URL);
    const reporting = connecta.registry.contextFor(
      "linear_reporting",
      BASE_URL,
    );
    await product.storage.set("oauth:tokens", "product-token");
    expect(await reporting.storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("conn:linear_product:oauth:tokens")).toBe(
      "product-token",
    );
    expect(await storage.get("conn:linear_reporting:oauth:tokens")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters only the workspace that asked to be metered, and observes both", async () => {
    const connecta = twoWorkspaces(memoryStorage());
    // No invented default ceiling: the unmetered instance has no admission
    // controller at all, while the operator-configured one does.
    expect(Object.keys(connecta.registry.callAdmissionSnapshot())).toEqual([
      "linear_reporting",
    ]);

    const metered = await connecta.registry.admitCall("linear_reporting", {
      toolName: "list_issues",
      args: {},
    });
    metered.release();
    const unmetered = await connecta.registry.admitCall("linear_product", {
      toolName: "list_issues",
      args: {},
    });
    unmetered.release();

    const budgets = connecta.registry.callAdmissionSnapshot();
    expect(budgets["linear_reporting"]?.totals.admitted).toBe(1);
    expect(budgets["linear_product"]).toBeUndefined();

    // Health and activity are keyed by connector id the same way.
    connecta.registry.recordFailure("linear_product", 5, new Error("boom"));
    expect(
      connecta.registry.healthFor("linear_product")?.consecutiveFailures,
    ).toBe(1);
    expect(connecta.registry.healthFor("linear_reporting")).toBeUndefined();
  });

  it("routes the two access modes to different Linear endpoints", () => {
    const connecta = twoWorkspaces(memoryStorage());
    expect(connecta.registry.getConnector("linear_product")?.description).toBe(
      "Linear issue tracking and project planning — Product delivery planning",
    );
    expect(
      connecta.registry.getConnector("linear_reporting")?.description,
    ).toBe(
      "Linear issue tracking and project planning (read-only) — Executive delivery reporting",
    );
  });
});
