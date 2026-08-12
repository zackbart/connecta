import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { mixpanel } from "../src/providers/mixpanel.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

// Unmocked on purpose. test/mixpanel-provider.test.ts stubs remote-mcp to
// inspect the options mixpanel() passes down; that suite can never catch a
// deployment that refuses to boot, because it never boots one. This one
// constructs the real connector, hands it to the real Registry, and would have
// failed on the callAdmission rule that declared a queue setting without a
// queue. Construction touches no network: fetch throws for the whole file.

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

function twoAccounts(storage: KVStorage) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    discovery: { persistCatalog: true },
    connectors: [
      mixpanel("mixpanel_us", {
        purpose: "Production product decisions",
        // Only this instance opts into a ceiling; the other must stay
        // unmetered, because the connection invents no default budget for a
        // limit Mixpanel meters per user.
        callAdmission: {
          rules: [
            {
              budget: {
                kind: "rolling-window",
                maxCalls: 300,
                windowMs: 3_600_000,
              },
            },
          ],
        },
      }),
      mixpanel("mixpanel_eu", {
        purpose: "EU product reporting",
        region: "eu",
      }),
    ],
  });
}

describe("mixpanel() inside a real deployment", () => {
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

  it("boots two accounts without reaching the network", () => {
    const connecta = twoAccounts(memoryStorage());
    expect(
      connecta.registry.listConnectors().map((connector) => connector.id),
    ).toEqual(["mixpanel_us", "mixpanel_eu"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives each account its own address namespace", () => {
    const connecta = twoAccounts(memoryStorage());
    expect(connecta.registry.resolveAddress("mixpanel_us.Run-Query")?.connector)
      .toBe(connecta.registry.getConnector("mixpanel_us"));
    expect(connecta.registry.resolveAddress("mixpanel_eu.Run-Query")?.connector)
      .toBe(connecta.registry.getConnector("mixpanel_eu"));
    expect(
      connecta.registry.getConnector("mixpanel_us"),
    ).not.toBe(connecta.registry.getConnector("mixpanel_eu"));
  });

  it("keeps catalogs, storage, and credentials in separate namespaces", async () => {
    const storage = memoryStorage();
    const connecta = twoAccounts(storage);
    await seedCatalog(storage, "mixpanel_us", "Run-Query");
    await seedCatalog(storage, "mixpanel_eu", "List-Dashboards");

    expect(
      (await connecta.registry.getTools("mixpanel_us", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["Run-Query"]);
    expect(
      (await connecta.registry.getTools("mixpanel_eu", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["List-Dashboards"]);

    // Downstream OAuth registration and tokens ride connector-scoped storage,
    // so one account's credentials are unreachable from the other's context.
    const us = connecta.registry.contextFor("mixpanel_us", BASE_URL);
    const eu = connecta.registry.contextFor("mixpanel_eu", BASE_URL);
    await us.storage.set("oauth:tokens", "us-token");
    expect(await eu.storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("conn:mixpanel_us:oauth:tokens")).toBe("us-token");
    expect(await storage.get("conn:mixpanel_eu:oauth:tokens")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters only the account that asked to be metered, and observes both", async () => {
    const connecta = twoAccounts(memoryStorage());
    // No invented default ceiling: the unmetered instance has no admission
    // controller at all, while the operator-configured one does.
    expect(Object.keys(connecta.registry.callAdmissionSnapshot())).toEqual([
      "mixpanel_us",
    ]);

    const metered = await connecta.registry.admitCall("mixpanel_us", {
      toolName: "Run-Query",
      args: {},
    });
    metered.release();
    const unmetered = await connecta.registry.admitCall("mixpanel_eu", {
      toolName: "Run-Query",
      args: {},
    });
    unmetered.release();
    const budgets = connecta.registry.callAdmissionSnapshot();
    expect(budgets["mixpanel_us"]?.totals.admitted).toBe(1);
    expect(budgets["mixpanel_eu"]).toBeUndefined();

    // Health and activity are keyed by connector id the same way.
    connecta.registry.recordFailure("mixpanel_us", 5, new Error("boom"));
    expect(connecta.registry.healthFor("mixpanel_us")?.consecutiveFailures)
      .toBe(1);
    expect(connecta.registry.healthFor("mixpanel_eu")).toBeUndefined();
  });
});
