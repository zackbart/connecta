import { encryptedCredentialVault } from "../src/credentials.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogService } from "../src/catalog-service.js";
import { CredentialVault } from "../src/credentials.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { ccb } from "../src/providers/ccb/index.js";
import { breeze } from "../src/providers/breeze/index.js";
import { basecamp } from "../src/providers/basecamp/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { linear } from "../src/providers/linear/index.js";
import { mixpanel } from "../src/providers/mixpanel/index.js";
import { notion } from "../src/providers/notion/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { overflow } from "../src/providers/overflow/index.js";
import { revenuecat } from "../src/providers/revenuecat/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { infisical } from "../src/providers/infisical/index.js";
import { tithely } from "../src/providers/tithely/index.js";
import { connectorGuideSummary } from "../src/skills.js";
import { memoryStorage } from "../src/storage/memory.js";
import { activityFor, activitySink, invokeTestCall, silentLogger } from "./helpers.js";
import type { Connector, KVStorage } from "../src/types.js";

const BASE_URL = "https://connecta.example";
const executor = customExecutor({ execute: async () => ({ result: null }) }, { lifecycle: "self-managed" });
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
    discovery: { catalogTtlSeconds: 300 },
    ...(credentials ? { vault: encryptedCredentialVault(storage, CREDENTIAL_KEY) } : {}),
    connectors,
  });
}

const providers: ProviderCase[] = [
  {
    name: "infisical",
    ids: ["infisical", "infisical_eu"],
    toolName: "list_projects",
    secondToolName: "list_folders",
    descriptionMarks: ["Production secrets", "EU development secrets"],
    admissionIds: ["infisical"],
    meteredId: "infisical",
    staticCatalog: true,
    factory: (storage) =>
      deployment(
        storage,
        [
          infisical("infisical", { purpose: "Production secrets", callAdmission: budget }),
          infisical("infisical_eu", {
            purpose: "EU development secrets",
            baseUrl: "https://eu.infisical.com/api",
            authScope: "personal",
          }),
        ],
        true,
      ),
  },
  {
    name: "stripe",
    ids: ["stripe_live", "stripe_sandbox"] as const,
    toolName: "stripe_api_read",
    secondToolName: "get_balance_summary",
    descriptionMarks: ["live money and real customers", "test data, no real money"],
    admissionIds: ["stripe_live", "stripe_sandbox"],
    meteredId: "stripe_live",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          stripe("stripe_live", {
            mode: "production",
            purpose: "Revenue, disputes, and refunds for the real business",
            auth: { type: "apiKey" },
          }),
          stripe("stripe_sandbox", {
            mode: "sandbox",
            purpose: "Rehearsing billing changes before they touch production",
            auth: { type: "apiKey" },
          }),
        ],
        true,
      ),
  },
  {
    name: "linear",
    ids: ["linear_product", "linear_reporting"] as const,
    toolName: "list_issues",
    secondToolName: "list_projects",
    descriptionMarks: [
      "Linear issue tracking and project planning — Product delivery planning",
      "Linear issue tracking and project planning (read-only) — Executive delivery reporting",
    ],
    admissionIds: ["linear_reporting"],
    meteredId: "linear_reporting",
    staticCatalog: false,
    factory: (storage: KVStorage) =>
      deployment(storage, [
        linear("linear_product", { purpose: "Product delivery planning", access: "read-write" }),
        linear("linear_reporting", {
          purpose: "Executive delivery reporting",
          access: "read-only",
          callAdmission: { rules: [{ budget: { kind: "rolling-window", maxCalls: 500, windowMs: 3_600_000 } }] },
        }),
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
    factory: (storage: KVStorage) =>
      deployment(storage, [
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
    factory: (storage: KVStorage) =>
      deployment(storage, [
        revenuecat("bepresent_ios", {
          purpose: "Subscription state for the BePresent iOS project",
          auth: { type: "headers", headers: { Authorization: "Bearer sk_bepresent_example" } },
          callAdmission: budget,
        }),
        revenuecat("biblescroll", {
          purpose: "Subscription state for the BibleScroll project",
          auth: { type: "headers", headers: { Authorization: "Bearer sk_biblescroll_example" } },
          callAdmission: budget,
        }),
      ]),
  },
  {
    name: "cloudflare",
    ids: ["cloudflare_prod", "cloudflare_staging"] as const,
    toolName: "list_zones",
    secondToolName: "cloudflare_api_read",
    descriptionMarks: ["Production zones and edge cache", "Staging zones only"],
    admissionIds: ["cloudflare_prod", "cloudflare_staging"],
    meteredId: "cloudflare_prod",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(storage, [
        cloudflare("cloudflare_prod", {
          auth: { type: "apiToken" },
          purpose: "Production zones and edge cache",
          zoneId: "zone-prod",
          accountId: "acct-prod",
        }),
        cloudflare("cloudflare_staging", {
          auth: { type: "apiToken" },
          purpose: "Staging zones only",
          zoneId: "zone-staging",
        }),
      ]),
  },
  {
    name: "notion",
    ids: ["notion_eng", "notion_ops"] as const,
    toolName: "integration_query_data_source",
    secondToolName: "integration_query_data_source",
    descriptionMarks: ["Engineering runbooks and specs", "Operations handbook"],
    admissionIds: ["notion_eng", "notion_ops"],
    meteredId: "notion_eng",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          notion("notion_eng", { auth: { type: "token" }, purpose: "Engineering runbooks and specs" }),
          notion("notion_ops", {
            auth: { type: "token" },
            purpose: "Operations handbook",
            title: "Ops wiki",
            defaultPageSize: 50,
          }),
        ],
        true,
      ),
  },
  {
    name: "vercel",
    ids: ["vercel_prod", "vercel_preview"] as const,
    toolName: "list_project_env_vars",
    secondToolName: "list_project_env_vars",
    descriptionMarks: ["Production applications", "Preview applications"],
    admissionIds: ["vercel_prod", "vercel_preview"],
    meteredId: "vercel_prod",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          vercel("vercel_prod", {
            surface: "api",
            purpose: "Production applications",
            teamId: "team_prod",
            callAdmission: budget,
          }),
          vercel("vercel_preview", {
            surface: "api",
            purpose: "Preview applications",
            teamId: "team_preview",
            callAdmission: budget,
          }),
        ],
        true,
      ),
  },
  {
    name: "ccb",
    ids: ["ccb_church", "ccb_sandbox"] as const,
    toolName: "list_individuals",
    secondToolName: "list_groups",
    descriptionMarks: ["Production church data, church-wide", "Sandbox church data, acting as each signed-in person"],
    admissionIds: ["ccb_church", "ccb_sandbox"],
    meteredId: "ccb_church",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(storage, [
        ccb("ccb_church", {
          purpose: "Pastoral care for the main campus",
          environment: "production",
          mode: "system",
          clientId: "prod-client",
          clientSecret: "prod-secret",
        }),
        ccb("ccb_sandbox", {
          purpose: "Rehearsing group changes",
          environment: "sandbox",
          mode: "identity",
          access: "read-write",
          clientId: "sandbox-client",
          clientSecret: "sandbox-secret",
        }),
      ]),
  },
  {
    name: "planning-center",
    ids: ["pco_downtown", "pco_northside"] as const,
    toolName: "search_people",
    secondToolName: "list_plans",
    descriptionMarks: ["Downtown campus staff", "Northside campus staff"],
    admissionIds: ["pco_downtown", "pco_northside"],
    meteredId: "pco_downtown",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          planningCenter("pco_downtown", { purpose: "Downtown campus staff" }),
          planningCenter("pco_northside", {
            purpose: "Northside campus staff",
            title: "Northside PCO",
            callAdmission: budget,
          }),
        ],
        true,
      ),
  },
  {
    name: "overflow",
    ids: ["overflow_church", "overflow_sandbox"] as const,
    toolName: "list_contributions",
    secondToolName: "list_deposits",
    descriptionMarks: ["production: Grace Church giving", "staging: Integration rehearsal"],
    admissionIds: ["overflow_church", "overflow_sandbox"],
    meteredId: "overflow_church",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          overflow("overflow_church", { environment: "production", purpose: "Grace Church giving and deposits" }),
          overflow("overflow_sandbox", { environment: "staging", purpose: "Integration rehearsal" }),
        ],
        true,
      ),
  },
  {
    name: "tithely",
    ids: ["tithely_grace", "tithely_rehearsal"] as const,
    toolName: "list_charges",
    secondToolName: "list_organizations",
    descriptionMarks: [
      "live donors and real money — Grace Church giving",
      "test environment, no real money) — Rehearsing giving reports",
    ],
    // Tithe.ly publishes no rate limit, so only an operator-supplied budget meters.
    admissionIds: ["tithely_grace"],
    meteredId: "tithely_grace",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          tithely("tithely_grace", { purpose: "Grace Church giving", environment: "live", callAdmission: budget }),
          tithely("tithely_rehearsal", { purpose: "Rehearsing giving reports", environment: "test" }),
        ],
        true,
      ),
  },
  {
    name: "breeze",
    ids: ["breeze_main", "breeze_plant"] as const,
    toolName: "list_people",
    secondToolName: "list_contributions",
    descriptionMarks: [
      "gracechurch.breezechms.com: Main campus pastoral care",
      "graceplant.breezechms.com: Church plant giving",
    ],
    admissionIds: ["breeze_main"],
    meteredId: "breeze_main",
    staticCatalog: true,
    factory: (storage: KVStorage) =>
      deployment(
        storage,
        [
          breeze("breeze_main", {
            subdomain: "gracechurch",
            purpose: "Main campus pastoral care",
            callAdmission: budget,
          }),
          breeze("breeze_plant", { subdomain: "graceplant", purpose: "Church plant giving" }),
        ],
        true,
      ),
  },
  {
    name: "basecamp",
    ids: ["basecamp_studio", "basecamp_client"] as const,
    toolName: "list_projects",
    secondToolName: "get_my_assignments",
    descriptionMarks: ["The studio's own projects", "The client-shared account"],
    admissionIds: ["basecamp_studio"],
    meteredId: "basecamp_studio",
    staticCatalog: false,
    factory: (storage: KVStorage) =>
      deployment(storage, [
        basecamp("basecamp_studio", {
          purpose: "The studio's own projects",
          clientMetadataUrl: "https://connecta.example/oauth/basecamp-client",
          callAdmission: budget,
        }),
        basecamp("basecamp_client", {
          purpose: "The client-shared account",
          clientMetadataUrl: "https://connecta.example/oauth/basecamp-client",
          authScope: "personal",
        }),
      ]),
  },
];

const byName = (name: string) => providers.find((provider) => provider.name === name)!;

describe.each(providers)(
  "$name() inside a real deployment",
  ({ factory, ids, toolName, secondToolName, descriptionMarks, admissionIds, meteredId, staticCatalog }) => {
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
      const { registry } = factory(storage);
      if (!staticCatalog) {
        vi.spyOn(registry.getConnector(ids[0])!, "listTools").mockResolvedValue([{ name: toolName }]);
        vi.spyOn(registry.getConnector(ids[1])!, "listTools").mockResolvedValue([{ name: secondToolName }]);
      }
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
  },
);

describe("provider-specific registry behavior", () => {
  it("boots one Stripe OAuth connector for mixed live and sandbox accounts", () => {
    const connecta = deployment(memoryStorage(), [
      stripe("stripe", { purpose: "Live and sandbox organization billing", auth: { type: "oauth" } }),
    ]);
    const connector = connecta.registry.getConnector("stripe");
    expect(connector?.description).toContain("live and sandbox accounts");
    expect(connector?.callAdmission?.rules[0]?.budget).toEqual({
      kind: "rolling-window",
      maxCalls: 25,
      windowMs: 1_000,
    });
  });

  it("boots one RevenueCat OAuth connector and guides project resolution", () => {
    const connecta = deployment(memoryStorage(), [
      revenuecat("revenuecat", { purpose: "Subscription state across every project we ship" }),
    ]);
    const connector = connecta.registry.getConnector("revenuecat")!;
    expect(connector.description).toContain("every project the account can reach");
    expect(connector.callAdmission).toBeUndefined();
    expect(connectorGuideSummary(connector)).toContain("list-projects");
  });

  it("keeps Linear access-mode titles and descriptions byte-exact", () => {
    const { registry } = byName("linear").factory(memoryStorage());
    expect(registry.getConnector("linear_product")?.title).toBe("Linear");
    expect(registry.getConnector("linear_product")?.description).toBe(
      "Linear issue tracking and project planning — Product delivery planning",
    );
    expect(registry.getConnector("linear_reporting")?.title).toBe("Linear (read-only)");
    expect(registry.getConnector("linear_reporting")?.description).toBe(
      "Linear issue tracking and project planning (read-only) — Executive delivery reporting",
    );
  });

  it("names each RevenueCat project in a distinct guide summary", () => {
    const { registry } = byName("revenuecat").factory(memoryStorage());
    const ios = registry.getConnector("bepresent_ios")!;
    const scroll = registry.getConnector("biblescroll")!;
    expect(ios.title).toBe(scroll.title);
    expect(connectorGuideSummary(ios)).toContain("BePresent iOS");
    expect(connectorGuideSummary(scroll)).toContain("BibleScroll");
    expect(connectorGuideSummary(ios)).not.toEqual(connectorGuideSummary(scroll));
  });

  it("names each Basecamp account in a distinct guide summary", () => {
    const { registry } = providers.find((provider) => provider.name === "basecamp")!.factory(memoryStorage());
    const studio = registry.getConnector("basecamp_studio")!;
    const client = registry.getConnector("basecamp_client")!;
    expect(studio.title).toBe(client.title);
    expect(studio.authScope).toBeUndefined();
    expect(client.authScope).toBe("personal");
    expect(connectorGuideSummary(studio)).toContain("The studio's own projects");
    expect(connectorGuideSummary(client)).toContain("The client-shared account");
    expect(connectorGuideSummary(studio)).not.toEqual(connectorGuideSummary(client));
  });

  it("serves Cloudflare's complete static catalog", async () => {
    const { registry } = byName("cloudflare").factory(memoryStorage());
    const tools = await registry.getTools("cloudflare_prod", BASE_URL);
    expect(tools).toHaveLength(9);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true)).toHaveLength(7);
  });

  it("serves equal complete Notion catalogs and refuses unknown addresses", async () => {
    const { registry } = byName("notion").factory(memoryStorage());
    const eng = await registry.getTools("notion_eng", BASE_URL);
    const ops = await registry.getTools("notion_ops", BASE_URL);
    expect(eng.map((tool) => tool.name)).toEqual(ops.map((tool) => tool.name));
    expect(eng).toHaveLength(11);
    expect(registry.resolveAddress("notion_eng.notion_api_write")?.toolName).toBe("notion_api_write");
    expect(registry.resolveAddress("nope.notion_api_write")).toBeFalsy();
  });

  it("carries Cloudflare page bounds in search and compact describe", async () => {
    const { registry } = byName("cloudflare").factory(memoryStorage());
    const catalog = new CatalogService(registry, BASE_URL);
    const search = await catalog.search({
      connector: "cloudflare_prod",
      query: "list zones",
      includeSchemas: "compact",
    });
    expect(search.entries.find((entry) => entry.tool.name === "list_zones")?.tool.inputSchema).toContain(
      "perPage?: integer /* >= 5; <= 50 */",
    );
    const described = await catalog.describe({ addresses: ["cloudflare_prod.list_zones"], format: "compact" });
    expect(described[0]?.inputSchema).toContain("perPage?: integer /* >= 5; <= 50 */");
  });

  it("scopes Cloudflare defaults to each account guide", () => {
    const { registry } = byName("cloudflare").factory(memoryStorage());
    const guide = (id: string) => (registry.getConnector(id)!.usageGuide as { content: string }).content;
    expect(guide("cloudflare_prod")).toContain("zone-prod");
    expect(guide("cloudflare_prod")).toContain("acct-prod");
    expect(guide("cloudflare_staging")).toContain("zone-staging");
    expect(guide("cloudflare_staging")).not.toContain("`{account_id}` in a path fills");
    expect(guide("cloudflare_staging")).not.toContain("acct-prod");
  });

  it("keeps Planning Center credentials, budgets, and guides separate", async () => {
    const storage = memoryStorage();
    const { registry } = byName("planning-center").factory(storage);
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll(
      "pco_downtown",
      { applicationId: "app_downtown", secret: "secret_downtown" },
      "operator@example.com",
    );
    expect(await registry.contextFor("pco_downtown", BASE_URL).credential?.get("applicationId")).toBe("app_downtown");
    expect(await registry.contextFor("pco_northside", BASE_URL).credential?.get("applicationId")).toBeNull();
    const downtown = registry.getConnector("pco_downtown")!;
    const northside = registry.getConnector("pco_northside")!;
    expect(downtown.callAdmission?.rules[0]?.budget).toEqual({
      kind: "rolling-window",
      maxCalls: 100,
      windowMs: 20_000,
    });
    expect(northside.callAdmission).toEqual(budget);
    expect(northside.title).toBe("Northside PCO");
    const guide = (connector: Connector) => (connector.usageGuide as { content: string }).content;
    expect(guide(downtown)).toContain("Downtown campus staff");
    expect(guide(downtown)).not.toContain("Northside campus staff");
    expect(await registry.getTools("pco_downtown", BASE_URL)).toHaveLength(
      (await registry.getTools("pco_northside", BASE_URL)).length,
    );
  });

  it("keeps Overflow environments, credentials, and guides separate", async () => {
    const storage = memoryStorage();
    const { registry } = providers.find((provider) => provider.name === "overflow")!.factory(storage);
    const church = registry.getConnector("overflow_church")!;
    const sandbox = registry.getConnector("overflow_sandbox")!;
    expect(church.title).toBe("Overflow (production)");
    expect(sandbox.title).toBe("Overflow (staging)");
    expect(connectorGuideSummary(church)).toContain("production");
    expect(connectorGuideSummary(sandbox)).toContain("staging");
    const tools = await registry.getTools("overflow_church", BASE_URL);
    expect(tools).toHaveLength(18);
    expect(tools.filter((tool) => tool.annotations?.readOnlyHint === true)).toHaveLength(17);
    const vault = new CredentialVault(storage, CREDENTIAL_KEY);
    await vault.setAll("overflow_church", { clientId: "church-client", apiKey: "church-key" }, "operator@example.com");
    expect(await registry.contextFor("overflow_church", BASE_URL).credential?.get("apiKey")).toBe("church-key");
    expect(await registry.contextFor("overflow_sandbox", BASE_URL).credential?.getAll()).toBeNull();
  });

  it("keeps Notion credentials and guides separate", async () => {
    const storage = memoryStorage();
    const { registry } = byName("notion").factory(storage);
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
