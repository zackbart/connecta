import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { stripe } from "../src/providers/stripe.js";
import { memoryStorage } from "../src/storage/memory.js";
import { activityFor, activitySink, invokeTestCall, seedCatalog, silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

// Unmocked on purpose. test/stripe-provider.test.ts stubs remote-mcp to
// inspect the options stripe() passes down; that suite can never catch a
// deployment that refuses to boot, because it never boots one. This one
// constructs the real connectors, hands them to the real Registry, and would
// have failed on a callAdmission rule that declared queue settings without a
// maxConcurrency. Construction touches no network: fetch throws for the file.

const BASE_URL = "https://connecta.example";
const executor = { execute: async () => ({ result: null }) };

/**
 * Seed one connector's persisted catalog so `getTools` resolves from storage.
 * The key (`catalog:<id>`) is the namespace under test.
 */
function twoAccounts(storage: KVStorage) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    discovery: { persistCatalog: true },
    connectors: [
      stripe("stripe_live", {
        mode: "production",
        purpose: "Revenue, disputes, and refunds for the real business",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer rk_live_example" },
        },
      }),
      stripe("stripe_sandbox", {
        mode: "sandbox",
        purpose: "Rehearsing billing changes before they touch production",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer rk_test_example" },
        },
      }),
    ],
  });
}

describe("stripe() inside a real deployment", () => {
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

  it("boots one OAuth connector for mixed live and sandbox accounts", () => {
    const connecta = createConnecta({
      executor,
      storage: memoryStorage(),
      logger: silentLogger,
      publicUrl: BASE_URL,
      connectors: [
        stripe("stripe", {
          purpose: "Live and sandbox organization billing",
        }),
      ],
    });
    const connector = connecta.registry.getConnector("stripe");
    expect(connector?.description).toContain("live and sandbox accounts");
    expect(connector?.callAdmission?.rules[0]?.budget).toEqual({
      kind: "rolling-window",
      maxCalls: 25,
      windowMs: 1_000,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("boots a production and a sandbox account without reaching the network", () => {
    const connecta = twoAccounts(memoryStorage());
    expect(
      connecta.registry.listConnectors().map((connector) => connector.id),
    ).toEqual(["stripe_live", "stripe_sandbox"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tells the two modes apart in the descriptions an agent searches", () => {
    const connecta = twoAccounts(memoryStorage());
    expect(
      connecta.registry.getConnector("stripe_live")?.description,
    ).toContain("live money and real customers");
    expect(
      connecta.registry.getConnector("stripe_sandbox")?.description,
    ).toContain("test data, no real money");
  });

  it("gives each account its own address namespace", () => {
    const connecta = twoAccounts(memoryStorage());
    expect(
      connecta.registry.resolveAddress("stripe_live.stripe_api_read")
        ?.connector,
    ).toBe(connecta.registry.getConnector("stripe_live"));
    expect(
      connecta.registry.resolveAddress("stripe_sandbox.stripe_api_read")
        ?.connector,
    ).toBe(connecta.registry.getConnector("stripe_sandbox"));
    expect(connecta.registry.getConnector("stripe_live")).not.toBe(
      connecta.registry.getConnector("stripe_sandbox"),
    );
  });

  it("keeps catalogs, storage, and credentials in separate namespaces", async () => {
    const storage = memoryStorage();
    const connecta = twoAccounts(storage);
    await seedCatalog(storage, "stripe_live", "stripe_api_read");
    await seedCatalog(storage, "stripe_sandbox", "get_balance_summary");

    expect(
      (await connecta.registry.getTools("stripe_live", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["stripe_api_read"]);
    expect(
      (await connecta.registry.getTools("stripe_sandbox", BASE_URL)).map(
        (tool) => tool.name,
      ),
    ).toEqual(["get_balance_summary"]);

    // Downstream OAuth registration and tokens ride connector-scoped storage,
    // so the live account's credentials are unreachable from the sandbox's
    // context — the isolation that makes two Stripe modes safe to co-deploy.
    const live = connecta.registry.contextFor("stripe_live", BASE_URL);
    const sandbox = connecta.registry.contextFor("stripe_sandbox", BASE_URL);
    await live.storage.set("oauth:tokens", "live-token");
    expect(await sandbox.storage.get("oauth:tokens")).toBeNull();
    expect(await storage.get("conn:stripe_live:oauth:tokens")).toBe(
      "live-token",
    );
    expect(await storage.get("conn:stripe_sandbox:oauth:tokens")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters and observes each account separately", async () => {
    const storage = memoryStorage();
    await seedCatalog(storage, "stripe_live", "stripe_api_read");
    const connecta = twoAccounts(storage);
    expect(Object.keys(connecta.registry.callAdmissionSnapshot()).sort()).toEqual(
      ["stripe_live", "stripe_sandbox"],
    );

    // The live account spending its budget leaves the sandbox's untouched.
    const permit = await connecta.registry.admitCall("stripe_live", {
      toolName: "stripe_api_read",
      args: {},
    });
    permit.release();
    const budgets = connecta.registry.callAdmissionSnapshot();
    expect(budgets["stripe_live"]?.totals.admitted).toBe(1);
    expect(budgets["stripe_sandbox"]?.totals.admitted).toBe(0);

    const activity = activitySink();
    await invokeTestCall(
      connecta.registry,
      activity,
      "stripe_live.stripe_api_read",
    );
    expect(activityFor(activity.events, "stripe_live")?.outcome).toBe("error");
    expect(activityFor(activity.events, "stripe_sandbox")).toBeUndefined();
  });
});
