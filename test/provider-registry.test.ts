import { describe, expect, it } from "vitest";
import { CredentialVault, encryptedCredentialVault } from "../src/credentials.js";
import { createConnecta, customExecutor } from "../src/index.js";
import { linear } from "../src/providers/linear/index.js";
import { planningCenter } from "../src/providers/planning-center/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { memoryStorage } from "../src/storage/memory.js";
import type { Connector, KVStorage } from "../src/types.js";
import { silentLogger } from "./helpers.js";

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
