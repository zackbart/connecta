import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { createConnecta } from "../src/index.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import { linear } from "../src/providers/linear.js";
import { mixpanel } from "../src/providers/mixpanel.js";
import { notion } from "../src/providers/notion.js";
import { revenuecat } from "../src/providers/revenuecat.js";
import { stripe } from "../src/providers/stripe.js";
import { vercel } from "../src/providers/vercel.js";
import { connectorGuideSummary } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import { activityFor, activitySink, invokeTestCall, seedCatalog, silentLogger } from "./helpers.js";
import type { Connector, KVStorage } from "../src/types.js";

const BASE_URL = "https://connecta.example";
const executor = { execute: async () => ({ result: null }) };
const CREDENTIAL_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const budget = {
  rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 60, windowMs: 60_000 } }],
};

type ProviderCase = {
  name: string;
  ids: readonly [string, string];
  toolName: string;
  secondToolName: string;
  descriptionMarks: readonly [string, string];
  admissionIds: readonly string[];
  meteredId: string;
  staticCatalog: boolean;
  factory: (storage: KVStorage) => ReturnType<typeof deployment>;
};

function deployment(storage: KVStorage, connectors: Connector[], credentials = false) {
  return createConnecta({
    executor,
    storage,
    logger: silentLogger,
    publicUrl: BASE_URL,
    discovery: { persistCatalog: true },
    ...(credentials ? { credentials: { encryptionKey: CREDENTIAL_KEY } } : {}),
    connectors,
  });
}

const providers: ProviderCase[] = [
  {
    name: "stripe",
    ids: ["stripe_live", "stripe_sandbox"] as const,
    toolName: "stripe_api_read",
    secondToolName: "get_balance_summary",
    descriptionMarks: ["live money and real customers", "test data, no real money"],
    admissionIds: ["stripe_live", "stripe_sandbox"],
    meteredId: "stripe_live",
    staticCatalog: false,
    factory: (storage: KVStorage) => deployment(storage, [
      stripe("stripe_live", { mode: "production", purpose: "Revenue, disputes, and refunds for the real business", auth: { type: "headers", headers: { Authorization: "Bearer rk_live_example" } } }),
      stripe("stripe_sandbox", { mode: "sandbox", purpose: "Rehearsing billing changes before they touch production", auth: { type: "headers", headers: { Authorization: "Bearer rk_test_example" } } }),
    ]),
  },
  {
    name: "linear",
    ids: ["linear_product", "linear_reporting"] as const,
    toolName: "list_issues",
    secondToolName: "list_projects",
    descriptionMarks: ["Linear issue tracking and project planning — Product delivery planning", "Linear issue tracking and project planning (read-only) — Executive delivery reporting"],
    admissionIds: ["linear_reporting"],
    meteredId: "linear_reporting",
    staticCatalog: false,
    factory: (storage: KVStorage) => deployment(storage, [
      linear("linear_product", { purpose: "Product delivery planning", access: "read-write" }),
      linear("linear_reporting", { purpose: "Executive delivery reporting", access: "read-only", callAdmission: { rules: [{ budget: { kind: "rolling-window", maxCalls: 500, windowMs: 3_600_000 } }] } }),
    ]),
  },
  {
    name: "mixpanel",
    ids: ["mixpanel_us", "mixpanel_eu"] as const,
    toolName: "Run-Query",
    secondToolName: "List-Dashboards",
    descriptionMarks: ["US residency", "EU residency"],
    admissionIds: ["mixpanel_us"],
    meteredId: "mixpanel_us",
    staticCatalog: false,
    factory: (storage: KVStorage) => deployment(storage, [
      mixpanel("mixpanel_us", { purpose: "Production product decisions", callAdmission: budget }),
      mixpanel("mixpanel_eu", { purpose: "EU product reporting", region: "eu" }),
    ]),
  },
  {
    name: "revenuecat",
    ids: ["bepresent_ios", "biblescroll"] as const,
    toolName: "list-projects",
    secondToolName: "list-subscriptions",
    descriptionMarks: ["one project", "one project"],
    admissionIds: ["bepresent_ios", "biblescroll"],
    meteredId: "bepresent_ios",
    staticCatalog: false,
    factory: (storage: KVStorage) => deployment(storage, [
      revenuecat("bepresent_ios", { purpose: "Subscription state for the BePresent iOS project", auth: { type: "headers", headers: { Authorization: "Bearer sk_bepresent_example" } }, callAdmission: budget }),
      revenuecat("biblescroll", { purpose: "Subscription state for the BibleScroll project", auth: { type: "headers", headers: { Authorization: "Bearer sk_biblescroll_example" } }, callAdmission: budget }),
    ]),
  },
  {
    name: "cloudflare",
    ids: ["cloudflare_prod", "cloudflare_staging"] as const,
    toolName: "list_zones",
    secondToolName: "list_dns_records",
    descriptionMarks: ["Production zones and edge cache", "Staging zones only"],
    admissionIds: ["cloudflare_prod", "cloudflare_staging"],
    meteredId: "cloudflare_prod",
    staticCatalog: true,
    factory: (storage: KVStorage) => deployment(storage, [
      cloudflare("cloudflare_prod", { purpose: "Production zones and edge cache", zoneId: "zone-prod", accountId: "acct-prod" }),
      cloudflare("cloudflare_staging", { purpose: "Staging zones only", zoneId: "zone-staging" }),
    ]),
  },
  {
    name: "notion",
    ids: ["notion_eng", "notion_ops"] as const,
    toolName: "query_data_source",
    secondToolName: "query_data_source",
    descriptionMarks: ["Engineering runbooks and specs", "Operations handbook"],
    admissionIds: ["notion_eng", "notion_ops"],
    meteredId: "notion_eng",
    staticCatalog: true,
    factory: (storage: KVStorage) => deployment(storage, [
      notion("notion_eng", { purpose: "Engineering runbooks and specs" }),
      notion("notion_ops", { purpose: "Operations handbook", title: "Ops wiki", defaultPageSize: 50 }),
    ], true),
  },
  {
    name: "vercel",
    ids: ["vercel_prod", "vercel_preview"] as const,
    toolName: "list_projects",
    secondToolName: "list_deployments",
    descriptionMarks: ["Production applications", "Preview applications"],
    admissionIds: ["vercel_prod", "vercel_preview"],
    meteredId: "vercel_prod",
    staticCatalog: true,
    factory: (storage: KVStorage) => deployment(storage, [
      vercel("vercel_prod", { purpose: "Production applications", teamId: "team_prod", callAdmission: budget }),
      vercel("vercel_preview", { purpose: "Preview applications", teamId: "team_preview", callAdmission: budget }),
    ], true),
  },
];

describe.each(providers)("$name() inside a real deployment", ({ factory, ids, toolName, secondToolName, descriptionMarks, admissionIds, meteredId, staticCatalog }) => {
  const realFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(() => { throw new Error("network touched"); });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("boots two connectors without reaching the network", () => {
    const { registry } = factory(memoryStorage());
    expect(registry.listConnectors().map((connector) => connector.id)).toEqual(ids);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("includes the provider-specific description marks", () => {
    const { registry } = factory(memoryStorage());
    expect(registry.getConnector(ids[0])?.description).toContain(descriptionMarks[0]);
    expect(registry.getConnector(ids[1])?.description).toContain(descriptionMarks[1]);
  });

  it("gives each connector its own address namespace", () => {
    const { registry } = factory(memoryStorage());
    expect(registry.resolveAddress(`${ids[0]}.${toolName}`)?.connector).toBe(registry.getConnector(ids[0]));
    expect(registry.resolveAddress(`${ids[1]}.${toolName}`)?.connector).toBe(registry.getConnector(ids[1]));
    expect(registry.getConnector(ids[0])).not.toBe(registry.getConnector(ids[1]));
  });

  it("keeps catalogs and storage in separate namespaces", async () => {
    const storage = memoryStorage();
    await seedCatalog(storage, ids[0], toolName);
    await seedCatalog(storage, ids[1], secondToolName);
    const { registry } = factory(storage);
    const firstNames = (await registry.getTools(ids[0], BASE_URL)).map((tool) => tool.name);
    const secondNames = (await registry.getTools(ids[1], BASE_URL)).map((tool) => tool.name);
    if (staticCatalog) {
      expect(firstNames).toContain(toolName);
      expect(secondNames).toContain(secondToolName);
    } else {
      expect(firstNames).toEqual([toolName]);
      expect(secondNames).toEqual([secondToolName]);
    }
    const first = registry.contextFor(ids[0], BASE_URL);
    const second = registry.contextFor(ids[1], BASE_URL);
    await first.storage.set("namespace:probe", "first");
    expect(await second.storage.get("namespace:probe")).toBeNull();
    expect(await storage.get(`conn:${ids[0]}:namespace:probe`)).toBe("first");
    expect(await storage.get(`conn:${ids[1]}:namespace:probe`)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("meters and observes each connector separately", async () => {
    const storage = memoryStorage();
    await seedCatalog(storage, ids[0], toolName);
    const { registry } = factory(storage);
    expect(Object.keys(registry.callAdmissionSnapshot()).sort()).toEqual([...admissionIds].sort());
    const permit = await registry.admitCall(meteredId, { toolName, args: {} });
    permit.release();
    const snapshots = registry.callAdmissionSnapshot();
    expect(snapshots[meteredId]?.totals.admitted).toBe(1);
    const otherId = ids.find((id) => id !== meteredId)!;
    if (admissionIds.includes(otherId)) {
      expect(snapshots[otherId]?.totals.admitted).toBe(0);
    } else {
      const unmetered = await registry.admitCall(otherId, { toolName, args: {} });
      unmetered.release();
      expect(snapshots[otherId]).toBeUndefined();
    }
    const activity = activitySink();
    await invokeTestCall(registry, activity, `${ids[0]}.${toolName}`);
    expect(activityFor(activity.events, ids[0])?.outcome).toBe("error");
    expect(activityFor(activity.events, ids[1])).toBeUndefined();
  });
});

describe("provider-specific registry behavior", () => {
  it("boots one Stripe OAuth connector for mixed live and sandbox accounts", () => {
    const connecta = deployment(memoryStorage(), [stripe("stripe", { purpose: "Live and sandbox organization billing" })]);
    const connector = connecta.registry.getConnector("stripe");
    expect(connector?.description).toContain("live and sandbox accounts");
    expect(connector?.callAdmission?.rules[0]?.budget).toEqual({ kind: "rolling-window", maxCalls: 25, windowMs: 1_000 });
  });

  it("boots one RevenueCat OAuth connector and guides project resolution", () => {
    const connecta = deployment(memoryStorage(), [revenuecat("revenuecat", { purpose: "Subscription state across every project we ship" })]);
    const connector = connecta.registry.getConnector("revenuecat")!;
    expect(connector.description).toContain("every project the account can reach");
    expect(connector.callAdmission).toBeUndefined();
    expect(connectorGuideSummary(connector)).toContain("list-projects");
  });

  it("keeps Linear access-mode titles and descriptions byte-exact", () => {
    const { registry } = providers[1]!.factory(memoryStorage());
    expect(registry.getConnector("linear_product")?.title).toBe("Linear");
    expect(registry.getConnector("linear_product")?.description).toBe("Linear issue tracking and project planning — Product delivery planning");
    expect(registry.getConnector("linear_reporting")?.title).toBe("Linear (read-only)");
    expect(registry.getConnector("linear_reporting")?.description).toBe("Linear issue tracking and project planning (read-only) — Executive delivery reporting");
  });

  it("names each RevenueCat project in a distinct guide summary", () => {
    const { registry } = providers[3]!.factory(memoryStorage());
    const ios = registry.getConnector("bepresent_ios")!;
    const scroll = registry.getConnector("biblescroll")!;
    expect(ios.title).toBe(scroll.title);
    expect(connectorGuideSummary(ios)).toContain("BePresent iOS");
    expect(connectorGuideSummary(scroll)).toContain("BibleScroll");
    expect(connectorGuideSummary(ios)).not.toEqual(connectorGuideSummary(scroll));
  });

  it("serves Cloudflare's complete static catalog", async () => {
    const { registry } = providers[4]!.factory(memoryStorage());
    const tools = await registry.getTools("cloudflare_prod", BASE_URL);
    expect(tools).toHaveLength(51);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true)).toHaveLength(27);
  });

  it("serves equal complete Notion catalogs and refuses unknown addresses", async () => {
    const { registry } = providers[5]!.factory(memoryStorage());
    const eng = await registry.getTools("notion_eng", BASE_URL);
    const ops = await registry.getTools("notion_ops", BASE_URL);
    expect(eng.map((tool) => tool.name)).toEqual(ops.map((tool) => tool.name));
    expect(eng).toHaveLength(15);
    expect(registry.resolveAddress("notion_eng.trash_page")?.toolName).toBe("trash_page");
    expect(registry.resolveAddress("nope.trash_page")).toBeFalsy();
  });

  it("carries Cloudflare page bounds in search and compact describe", async () => {
    const { registry } = providers[4]!.factory(memoryStorage());
    const catalog = new CatalogService(registry, BASE_URL);
    const search = await catalog.search({ connector: "cloudflare_prod", query: "list zones", includeSchemas: "compact" });
    expect(search.entries.find((entry) => entry.tool.name === "list_zones")?.tool.inputSchema).toContain("perPage?: integer /* >= 5; <= 50 */");
    const described = await catalog.describe({ addresses: ["cloudflare_prod.list_zones"], format: "compact" });
    expect(described[0]?.inputSchema).toContain("perPage?: integer /* >= 5; <= 50 */");
  });

  it("scopes Cloudflare defaults to each account guide", () => {
    const { registry } = providers[4]!.factory(memoryStorage());
    const guide = (id: string) => (registry.getConnector(id)!.usageGuide as { content: string }).content;
    expect(guide("cloudflare_prod")).toContain("zone-prod");
    expect(guide("cloudflare_prod")).toContain("acct-prod");
    expect(guide("cloudflare_staging")).toContain("zone-staging");
    expect(guide("cloudflare_staging")).toContain("declares no default account");
    expect(guide("cloudflare_staging")).not.toContain("acct-prod");
  });

  it("keeps Notion credentials and guides separate", async () => {
    const storage = memoryStorage();
    const { registry } = providers[5]!.factory(storage);
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.set("notion_eng", "secret_eng_token", "operator@example.com");
    expect(await registry.contextFor("notion_eng", BASE_URL).credential?.get()).toBe("secret_eng_token");
    expect(await registry.contextFor("notion_ops", BASE_URL).credential?.get()).toBeNull();
    const eng = (registry.getConnector("notion_eng")!.usageGuide as { content: string }).content;
    const ops = (registry.getConnector("notion_ops")!.usageGuide as { content: string }).content;
    expect(eng).toContain("Engineering runbooks and specs");
    expect(ops).toContain("Operations handbook");
    expect(eng).not.toContain("Operations handbook");
  });
});
