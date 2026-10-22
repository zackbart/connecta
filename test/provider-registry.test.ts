import { encryptedCredentialVault } from "../src/credentials.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialVault } from "../src/credentials.js";
import { customExecutor, createConnecta } from "../src/index.js";
import { linear } from "../src/providers/linear/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { stripe } from "../src/providers/stripe/index.js";
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
    readOnly: false,
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
});
