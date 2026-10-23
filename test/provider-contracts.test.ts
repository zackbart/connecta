import { describe, expect, it } from "vitest";
import { remoteMcp } from "../src/connectors/remote-mcp.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import type { ContractFixture } from "./fixtures/provider-contract.js";
import { providerFixtures } from "./providers.generated.js";

describe.each(providerFixtures as unknown as ContractFixture[])("$name provider construction", (fixture) => {
  it("INV-2 INV-11: accepts and retains connector readOnly in every provider mode", () => {
    for (const scenario of fixture.cases) {
      for (const readOnly of [true, false]) {
        expect(fixture.create("reader", { ...scenario.options, readOnly }).readOnly).toBe(readOnly);
      }
      expect(() => fixture.create("reader", { ...scenario.options, readOnly: "true" })).toThrow(/readOnly.*boolean/);
    }
  });
});

it.each([
  ["Stripe OAuth", () => stripe("billing", { purpose: "Billing", auth: { type: "oauth" } } as never)],
  ["Vercel OAuth", () => vercel("hosting", { purpose: "Hosting", auth: { type: "oauth" } } as never)],
  [
    "Cloudflare OAuth",
    () => cloudflare("infrastructure", { purpose: "Infrastructure", auth: { type: "oauth" } } as never),
  ],
])("INV-11: %s requires the generic hosted replacement at construction", (_name, construct) => {
  expect(construct).toThrow("requires remoteMcp()");
  expect(construct).toThrow("ConnectaConfig.classification");
});

it.each([
  ["Stripe", () => stripe("billing", { purpose: "Billing" } as never), '"apiKey"'],
  ["Vercel", () => vercel("hosting", { purpose: "Hosting" } as never), '"token"'],
  [
    "Cloudflare",
    () => cloudflare("infrastructure", { purpose: "Infrastructure" } as never),
    '"apiToken", "globalApiKey"',
  ],
])("INV-11: %s missing auth lists only API choices", (_name, construct, choices) => {
  expect(construct).toThrow(`one of ${choices}.`);
  expect(construct).not.toThrow(/oauth/);
});

it.each([
  ["remoteMcp", () => remoteMcp("crm", { url: "https://crm.example/mcp", classify: { tools: {} } } as never)],
  [
    "provider",
    () => stripe("billing", { purpose: "Billing", auth: { type: "apiKey" }, classify: { tools: {} } } as never),
  ],
])("INV-11: leftover %s classify names deployment classification", (_name, construct) => {
  expect(construct).toThrow("ConnectaConfig.classification");
});
