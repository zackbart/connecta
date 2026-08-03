// Unmocked on purpose. test/cloudflare-provider.test.ts stubs fetch to inspect
// the requests cloudflare() builds; that suite can never catch a deployment
// that refuses to boot, because it never boots one. This one constructs the
// real connector, hands it to the real Registry, and proves two Cloudflare
// accounts in one deployment share nothing. Construction touches no network:
// fetch throws for the whole file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnecta } from "../src/index.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import type { KVStorage } from "../src/types.js";

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
      cloudflare("cloudflare_prod", {
        purpose: "Production zones and edge cache",
        zoneId: "zone-prod",
        accountId: "acct-prod",
      }),
      cloudflare("cloudflare_staging", {
        purpose: "Staging zones only",
        zoneId: "zone-staging",
      }),
    ],
  });
}

describe("cloudflare() inside a real deployment", () => {
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
    const { registry } = twoAccounts(memoryStorage());
    expect(registry.listConnectors().map((connector) => connector.id)).toEqual([
      "cloudflare_prod",
      "cloudflare_staging",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("serves its whole catalog without discovery", async () => {
    const { registry } = twoAccounts(memoryStorage());
    // A hand-written api() surface is static: an agent can list every tool
    // before the first credential exists, and never pays a discovery round trip.
    const tools = await registry.getTools("cloudflare_prod", BASE_URL);
    expect(tools).toHaveLength(14);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true))
      .toHaveLength(10);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("gives each account its own address namespace", () => {
    const { registry } = twoAccounts(memoryStorage());
    expect(registry.resolveAddress("cloudflare_prod.list_zones")?.connector).toBe(
      registry.getConnector("cloudflare_prod"),
    );
    expect(
      registry.resolveAddress("cloudflare_staging.list_zones")?.connector,
    ).toBe(registry.getConnector("cloudflare_staging"));
    expect(registry.getConnector("cloudflare_prod")).not.toBe(
      registry.getConnector("cloudflare_staging"),
    );
  });

  it("keeps catalogs, storage, and credentials in separate namespaces", async () => {
    const storage = memoryStorage();
    await seedCatalog(storage, "cloudflare_prod", "list_zones");
    await seedCatalog(storage, "cloudflare_staging", "list_dns_records");
    const { registry } = twoAccounts(storage);

    expect(
      (await registry.getTools("cloudflare_prod", BASE_URL)).map((tool) => tool.name),
    ).toContain("list_zones");
    expect(
      (await registry.getTools("cloudflare_staging", BASE_URL)).map((tool) => tool.name),
    ).toContain("list_dns_records");

    const prod = registry.contextFor("cloudflare_prod", BASE_URL);
    const staging = registry.contextFor("cloudflare_staging", BASE_URL);
    await prod.storage.set("token:probe", "prod-value");
    expect(await staging.storage.get("token:probe")).toBeNull();
    expect(await storage.get("conn:cloudflare_prod:token:probe")).toBe(
      "prod-value",
    );
    expect(await storage.get("conn:cloudflare_staging:token:probe")).toBeNull();
  });

  it("meters and observes each account separately", async () => {
    const { registry } = twoAccounts(memoryStorage());
    expect(Object.keys(registry.callAdmissionSnapshot()).sort()).toEqual([
      "cloudflare_prod",
      "cloudflare_staging",
    ]);

    const permit = await registry.admitCall("cloudflare_prod", {
      toolName: "list_zones",
      args: {},
    });
    permit.release();
    const budgets = registry.callAdmissionSnapshot();
    expect(budgets["cloudflare_prod"]?.totals.admitted).toBe(1);
    expect(budgets["cloudflare_staging"]?.totals.admitted).toBe(0);

    registry.recordFailure("cloudflare_prod", 5, new Error("boom"));
    expect(registry.healthFor("cloudflare_prod")?.consecutiveFailures).toBe(1);
    expect(registry.healthFor("cloudflare_staging")).toBeUndefined();
  });

  it("scopes each account's defaults to its own tool schemas", async () => {
    const { registry } = twoAccounts(memoryStorage());
    const prodGuide = registry.getConnector("cloudflare_prod")
      ?.usageGuide as string;
    const stagingGuide = registry.getConnector("cloudflare_staging")
      ?.usageGuide as string;
    expect(prodGuide).toContain("zone-prod");
    expect(prodGuide).toContain("acct-prod");
    expect(stagingGuide).toContain("zone-staging");
    // Staging declares no account default, so its guide still teaches discovery.
    expect(stagingGuide).toContain("declares no default account");
    expect(stagingGuide).not.toContain("acct-prod");
  });
});
