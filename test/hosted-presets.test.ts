// Captured from abc0d176 through Registry.getTools before converting 5c.
// Catalog hashes cover every reviewed name and two unknowns under nine hint
// shapes. Guide edits are enumerated separately; all other fields stay exact.
import { describe, expect, it } from "vitest";
import before from "./fixtures/hosted-presets-abc0d176.json";
import configChanges from "./fixtures/provider-5d-config-changes.json";
import guideChanges from "./fixtures/hosted-5c-guide-changes.json";
import errorGuideChanges from "./fixtures/hosted-p2-item4-guide-changes.json";
import trustChanges from "./fixtures/providers-p2-item1-contract-changes.json";
import { classifyTool } from "../src/tool-safety.js";
import { providerFixtures } from "./providers.generated.js";
import { Registry } from "../src/registry.js";
import { memoryStorage } from "../src/storage/memory.js";
import { silentLogger } from "./helpers.js";
import { catalogReviewOf } from "../src/catalog-drift.js";
import { basecamp } from "../src/providers/basecamp/index.js";
import { linear } from "../src/providers/linear/index.js";
import { mixpanel } from "../src/providers/mixpanel/index.js";
import { revenuecat } from "../src/providers/revenuecat/index.js";
import { stripe } from "../src/providers/stripe/index.js";
import { notion } from "../src/providers/notion/index.js";
import { vercel } from "../src/providers/vercel/index.js";
import { cloudflare } from "../src/providers/cloudflare/index.js";
import type { Connector, ToolAnnotations } from "../src/types.js";

const factories = { basecamp, linear, mixpanel, revenuecat, stripe, notion, vercel, cloudflare };
type Name = keyof typeof factories;
const upstreamContracts = trustChanges as Record<string, Record<string, { describe?: string }>>;
const construct = (name: Name, options: unknown): Connector => factories[name]("fixture", options as never);

async function hash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectedGuide(name: Name, content: string): string {
  if (Object.hasOwn(configChanges, name)) return content;
  const repairs = errorGuideChanges as Partial<Record<Name, string[][]>>;
  for (const [from, to] of [...guideChanges[name], ...repairs[name] ?? []]) content = content.replaceAll(from!, to!);
  return content;
}

const registryFor = (connector: Connector) => new Registry([connector], {
  storage: memoryStorage(), logger: silentLogger,
});

describe.each(Object.keys(before.providers) as Name[])("%s hosted preset", (name) => {
  const recorded = before.providers[name];

  it("preserves connection choices, metadata, describe(), and guides except the enumerated prerequisites", async () => {
    const configs = configChanges[name as keyof typeof configChanges] ?? recorded.configs;
    for (const [label, row] of Object.entries(configs)) {
      const connector = construct(name, row.options);
      const metadata = JSON.parse(JSON.stringify({
        title: connector.title, description: connector.description, kind: connector.kind,
        authScope: connector.authScope ?? null, maxResultBytes: connector.maxResultBytes ?? null,
        callAdmission: connector.callAdmission ?? null, credential: connector.credential ?? null,
        usageGuide: connector.usageGuide, describeSha256: await hash(connector.describe?.()),
      }));
      const expected = structuredClone(row.metadata);
      // #734 removed precomputed classifications from raw API descriptions.
      if (!Object.hasOwn(configChanges, name)) expected.describeSha256 = upstreamContracts[name]?.[label]?.describe ?? expected.describeSha256;
      expected.usageGuide.content = expectedGuide(name, expected.usageGuide.content);
      if (typeof expected.usageGuide.summary === "string") {
        expected.usageGuide.summary = expectedGuide(name, expected.usageGuide.summary);
      }
      expect(metadata, `${name}:${label}`).toEqual(expected);
      if ("tools" in row) {
        const tools = await registryFor(connector).getTools("fixture", "https://connecta.example");
        expect(tools.map((tool) => ({ name: tool.name, annotations: tool.annotations }))).toEqual(row.tools);
        expect(connector.classification).toBeUndefined();
      }
    }
  });

  it("INV-1: preserves every reviewed verdict and digest with a frozen per-tool reason", () => {
    const classify = factories[name].definition.classify!;
    const fixture = providerFixtures.find((fixture) => fixture.name === name)!;
    const connector = fixture.create("fixture", ["notion", "vercel", "cloudflare"].includes(name)
      ? { surface: "mcp" } as never : {});
    const review = catalogReviewOf(connector)!;
    expect(Object.fromEntries([...review.tools].filter(([name]) => Object.hasOwn(recorded.verdicts, name)))).toEqual(recorded.verdicts);
    expect(Object.isFrozen(classify.tools)).toBe(true);
    expect(connector.classification).toEqual(classify);
    for (const entry of Object.values(classify.tools)) {
      expect(typeof entry).toBe("object");
      expect(typeof entry === "object" && entry.reason?.trim()).toBeTruthy();
      expect(Object.isFrozen(entry)).toBe(true);
    }
    if (name === "revenuecat") expect(classify.tools).not.toHaveProperty("render-paywall-screenshot");
  });

  it("INV-1: serves the identical complete registry catalog under all recorded annotation shapes", async () => {
    const fixture = providerFixtures.find((fixture) => fixture.name === name)!;
    const names = [...Object.keys(recorded.verdicts), "unknown_silent", "unknown_read"];
    for (const [index, hints] of before.variants.entries()) {
      const annotations = hints as ToolAnnotations | null;
      const real = fixture.create("fixture", ["notion", "vercel", "cloudflare"].includes(name)
        ? { surface: "mcp" } as never : {});
      const facts = names.map((name) => ({ name, ...(annotations ? { annotations } : {}) }));
      const connector = { ...real, listTools: async () => structuredClone(facts) };
      const registry = registryFor(connector);
      const served = await registry.getTools("fixture", "https://connecta.example");
      expect(served.map((tool) => tool.name)).toEqual(names);
      expect(await hash(served.map((tool) => [tool.name, tool.annotations ?? null]))).toBe(recorded.classified[index]);
      for (const tool of served) {
        expect(tool.classification).toBe(classifyTool(tool));
      }
      // Repeated reads use cached facts and still return the same classification.
      expect(await registry.getTools("fixture", "https://connecta.example")).toEqual(served);
      expect(await connector.listTools()).toEqual(facts);
    }
  });

  it("INV-11: rejects blank titles and malformed common values before serving", () => {
    const options = Object.values(recorded.configs)[0]!.options;
    for (const title of ["", " "]) expect(() => construct(name, { ...options, title })).toThrow("title");
    expect(() => construct(name, { ...options, purpose: 3 })).toThrow("purpose");
    expect(() => construct(name, { ...options, instructions: 3 })).toThrow("instructions");
  });
});
