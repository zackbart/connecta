import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { revenuecat } from "../src/providers/revenuecat.js";
import { memoryStorage } from "../src/storage/memory.js";
import { connectorGuideSummary } from "../src/skills.js";
import { silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

// Unmocked on purpose. test/revenuecat-provider.test.ts stubs remote-mcp to
// inspect the options revenuecat() passes down; that suite can never catch a
// deployment that refuses to boot, because it never boots one. This one
// constructs the real connectors, hands them to the real Registry, and is the
// acceptance test for the shape #433 exists for: two `sk_` keys, two projects,
// two connectors. Construction touches no network: fetch throws for the file.

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

/** The documented multi-project shape: one connector per project key. */
function twoProjects(storage: KVStorage) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    discovery: { persistCatalog: true },
    connectors: [
      revenuecat("bepresent_ios", {
        purpose: "Subscription state for the BePresent iOS project",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer sk_bepresent_example" },
        },
      }),
      revenuecat("biblescroll", {
        purpose: "Subscription state for the BibleScroll project",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer sk_biblescroll_example" },
        },
      }),
    ],
  });
}

describe("revenuecat() inside a real deployment", () => {
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

  it("boots one OAuth connector for every project the account can reach", () => {
    const connecta = createConnecta({
      executor,
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE_URL,
      connectors: [
        revenuecat("revenuecat", {
          purpose: "Subscription state across every project we ship",
        }),
      ],
    });
    const connector = connecta.registry.getConnector("revenuecat");
    expect(connector?.description).toContain(
      "every project the account can reach",
    );
    // P12: no default budget, so nothing to meter until an operator says so.
    expect(connector?.callAdmission).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("boots two project-scoped keys without reaching the network", () => {
    const connecta = twoProjects(memoryStorage());
    expect(
      connecta.registry.listConnectors().map((connector) => connector.id),
    ).toEqual(["bepresent_ios", "biblescroll"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names each project in the guide summary an agent browses (P3)", () => {
    const connecta = twoProjects(memoryStorage());
    const ios = connecta.registry.getConnector("bepresent_ios")!;
    const scroll = connecta.registry.getConnector("biblescroll")!;
    // The title is identical by design — connecta cannot know which project a
    // key reaches — so the summary is what has to tell them apart.
    expect(ios.title).toBe(scroll.title);
    expect(connectorGuideSummary(ios)).toContain("BePresent iOS");
    expect(connectorGuideSummary(scroll)).toContain("BibleScroll");
    expect(connectorGuideSummary(ios)).not.toEqual(
      connectorGuideSummary(scroll),
    );
  });

  it("gives each project its own address namespace", () => {
    const connecta = twoProjects(memoryStorage());
    expect(
      connecta.registry.resolveAddress("bepresent_ios.list-projects")?.connector,
    ).toBe(connecta.registry.getConnector("bepresent_ios"));
    expect(
      connecta.registry.resolveAddress("biblescroll.list-projects")?.connector,
    ).toBe(connecta.registry.getConnector("biblescroll"));
    expect(connecta.registry.getConnector("bepresent_ios")).not.toBe(
      connecta.registry.getConnector("biblescroll"),
    );
  });

  it("keeps catalogs, storage, and credentials in separate namespaces", async () => {
    const storage = memoryStorage();
    const connecta = twoProjects(storage);
    await seedCatalog(storage, "bepresent_ios", "list-customers");
    await seedCatalog(storage, "biblescroll", "list-subscriptions");

    expect(
      (await connecta.registry.getTools("bepresent_ios", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["list-customers"]);
    expect(
      (await connecta.registry.getTools("biblescroll", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["list-subscriptions"]);

    // Downstream OAuth registration and tokens ride connector-scoped storage,
    // so one project's credentials are unreachable from the other's context —
    // the isolation that makes per-project keys safe to co-deploy.
    const ios = connecta.registry.contextFor("bepresent_ios", BASE_URL);
    const scroll = connecta.registry.contextFor("biblescroll", BASE_URL);
    await ios.storage.set("oauth:tokens", "ios-token");
    expect(await scroll.storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("conn:bepresent_ios:oauth:tokens")).toBe(
      "ios-token",
    );
    expect(await storage.get("conn:biblescroll:oauth:tokens")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters and observes each project separately when an operator declares a budget", async () => {
    const budget = {
      rules: [
        {
          maxConcurrency: 4,
          budget: {
            kind: "rolling-window" as const,
            maxCalls: 60,
            windowMs: 60_000,
          },
        },
      ],
    };
    const connecta = createConnecta({
      executor,
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE_URL,
      connectors: [
        revenuecat("bepresent_ios", {
          purpose: "Subscription state for the BePresent iOS project",
          auth: {
            type: "headers",
            headers: { Authorization: "Bearer sk_bepresent_example" },
          },
          callAdmission: budget,
        }),
        revenuecat("biblescroll", {
          purpose: "Subscription state for the BibleScroll project",
          auth: {
            type: "headers",
            headers: { Authorization: "Bearer sk_biblescroll_example" },
          },
          callAdmission: budget,
        }),
      ],
    });
    expect(
      Object.keys(connecta.registry.callAdmissionSnapshot()).sort(),
    ).toEqual(["bepresent_ios", "biblescroll"]);

    const permit = await connecta.registry.admitCall("bepresent_ios", {
      toolName: "list-customers",
      args: {},
    });
    permit.release();
    const budgets = connecta.registry.callAdmissionSnapshot();
    expect(budgets["bepresent_ios"]?.totals.admitted).toBe(1);
    expect(budgets["biblescroll"]?.totals.admitted).toBe(0);

    // Health and activity are keyed by connector id the same way.
    connecta.registry.recordFailure("bepresent_ios", 5, new Error("boom"));
    expect(
      connecta.registry.healthFor("bepresent_ios")?.consecutiveFailures,
    ).toBe(1);
    expect(connecta.registry.healthFor("biblescroll")).toBeUndefined();
  });
});
