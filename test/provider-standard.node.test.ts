// Node-only: reads provider folders and documentation/providers.md from disk.
import { generatedProblems } from "../scripts/drift-validate.mjs";
//
// Applies decision 0011's provider standard to every provider folder. A
// provider listed in `PENDING` (test/provider-standard.ts) is exempt from the
// step it has not landed, and must still fail that step. Every other folder,
// including any created after the list, meets the whole standard.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import type { VendorErrors } from "../src/http/errors.js";
import type { ConnectorContext } from "../src/types.js";
import { silentLogger } from "./helpers.js";
import baseline from "./provider-pending-baseline.json";
import {
  PENDING,
  authoredTools,
  driftViolations,
  evidenceViolations,
  guideViolations,
  layoutViolations,
  surfaceViolations,
  type ProviderFacts,
} from "./provider-standard.js";
import { authoredFixtures } from "./providers.generated.js";

const root = fileURLToPath(new URL("../src/providers/", import.meta.url));
const documentationPath = fileURLToPath(new URL("../documentation/providers.md", import.meta.url));
const documentation = existsSync(documentationPath) ? readFileSync(documentationPath, "utf8") : "";
const today = new Date().toISOString().slice(0, 10);

const CONTEXT: ConnectorContext = {
  storage: memoryStorage(),
  logger: silentLogger,
  baseUrl: "https://connecta.example",
  credential: {
    get: async () => "token",
    getAll: async () => ({ value: "token", email: "operator@example.com" }),
  },
};

function walk(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

const names = readdirSync(root)
  .filter((name) => name !== "_shared" && statSync(join(root, name)).isDirectory())
  .sort();

const folders = await Promise.all(
  names.map(async (name) => {
    const directory = join(root, name);
    const module = (await import(pathToFileURL(join(directory, "index.ts")).href)) as Record<string, unknown>;
    const api = (await import(pathToFileURL(join(directory, "api.ts")).href)) as Record<string, unknown>;
    const vendors = Object.values(api).filter(
      (value): value is VendorErrors =>
        typeof value === "object" && value !== null && "facts" in value && "statuses" in value && "provider" in value,
    );
    const factory = Object.values(module).find(
      (
        value,
      ): value is {
        definition: { kind: string; title: string; readme?: string; blocks?: { keys: readonly string[] } };
      } => typeof value === "function" && "definition" in value,
    );
    const files = walk(directory).sort();
    const facts: ProviderFacts = {
      name,
      kind: factory?.definition.kind ?? "",
      display: factory?.definition.readme ?? factory?.definition.title ?? name,
      files,
      read: (path) => (files.includes(path) ? readFileSync(join(directory, path), "utf8") : undefined),
      ...(factory?.definition.blocks ? { blockKeys: factory.definition.blocks.keys } : {}),
    };
    // Hosted tools are the vendor's (P1); the S rules read surfaces connecta authors.
    const createAuthored = authoredFixtures[name];
    const tools = await authoredTools(facts.kind, { name, ...(createAuthored ? { createAuthored } : {}) }, CONTEXT);
    return { facts, tools, vendors };
  }),
);

const stepOne = ({ facts }: (typeof folders)[number]) =>
  [...layoutViolations(facts), ...evidenceViolations(facts, today), ...driftViolations(facts, today)].map(
    (finding) => `${facts.name} ${finding}`,
  );
const stepTwo = ({ facts, tools }: (typeof folders)[number]) =>
  [...guideViolations(facts, documentation), ...(tools ? surfaceViolations(tools) : [])].map(
    (finding) => `${facts.name} ${finding}`,
  );

describe("the provider standard (decision 0011)", () => {
  it("keeps the exemption inventory consistent with the pending providers", () => {
    expect(baseline).toEqual({ step1: [...PENDING.step1].sort(), step2: [...PENDING.step2].sort() });
  });
  it("keeps one shrinking list of providers that have not landed a step", () => {
    for (const name of PENDING.step1) expect(PENDING.step2.has(name), `${name} pending step 1`).toBe(true);
    for (const name of PENDING.step2) expect(names, `${name} is listed but has no folder`).toContain(name);
  });

  it("holds every provider past step 1 to layout, evidence, drift and declared Retry-After facts", () => {
    const found = folders.filter((folder) => !PENDING.step1.has(folder.facts.name)).flatMap(stepOne);
    expect(found).toEqual([]);
    for (const { facts, vendors } of folders) {
      expect(vendors.length, `${facts.name} exports its kit vendor error table`).toBeGreaterThan(0);
      for (const vendor of vendors)
        expect(vendor.numericFacts?.["retryAfterMs"], `${facts.name}: ${vendor.provider} Retry-After`).toMatchObject({
          header: "retry-after",
          format: "retry-after",
        });
    }
  });

  it("holds every provider past step 2 to the guide and surface rules (G, S)", () => {
    const found = folders.filter((folder) => !PENDING.step2.has(folder.facts.name)).flatMap(stepTwo);
    expect(found).toEqual([]);
  });

  it("fails while a listed provider already meets the step it is excused from", () => {
    const stale: string[] = [];
    for (const folder of folders) {
      const { name } = folder.facts;
      if (PENDING.step1.has(name) && stepOne(folder).length === 0) stale.push(`${name}: remove from PENDING.step1`);
      if (PENDING.step2.has(name) && !PENDING.step1.has(name) && stepTwo(folder).length === 0) {
        stale.push(`${name}: remove from PENDING.step2`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/** A provider folder written to today's legacy shapes, as a new provider might copy them. */
function legacy(): ProviderFacts {
  const files: Record<string, string> = {
    "index.ts": 'export const acme = asProviderFactory({ kind: "composed", create: () => api({ inputSchema }) });',
    "SKILL.md":
      '---\n{ "name": "acme", "instructionsHeading": "Acme instructions", "content": "guide" }\n---\n' +
      "<!-- fragment: guide -->\n# Acme usage\n\nImport `acme` from `@zackbart/connecta/providers/acme`.\n<!-- endfragment -->\n",
    "drift.json": JSON.stringify({
      version: 1,
      provider: "acme",
      checks: [{ type: "manual", source: "https://acme.example/api", rationale: "Hand-written HTML." }],
    }),
    "fixtures.ts": "",
    "skill.generated.ts": "",
    "provider.test.ts": "",
    "catalog.fixture.json": "[]",
    "value-safety.candidates.json": "{}",
  };
  return {
    name: "acme",
    kind: "composed",
    display: "Acme",
    files: Object.keys(files).sort(),
    read: (path) => files[path],
  };
}

const DIGEST = `sha256:${"0".repeat(64)}`;

/** An API provider folder that meets every rule. */
function standard(): ProviderFacts {
  const files: Record<string, string> = {
    "index.ts": 'export const acme = defineProvider({ kind: "api", create: kit });',
    "api.ts": "",
    "tools.ts": "",
    "safety.ts": "",
    "SKILL.md":
      '---\n{ "name": "acme", "instructionsHeading": "Acme instructions" }\n---\n\n## Identity first\n\n' +
      "Resolve a customer id before any write.\n\n<!-- when: account -->\nSelect the account first.\n<!-- end -->\n",
    "drift.json": JSON.stringify({
      version: 2,
      provider: "acme",
      generated: {
        operations: ["GET /customers", "POST /customers"],
        evidence: { "openapi.json": DIGEST, "value-safety.json": DIGEST },
      },
      checks: [
        { type: "openapi-index", source: "evidence/openapi.json" },
        {
          type: "manual",
          source: "https://acme.example/reference",
          reason: "Review the REST reference.",
          lastVerified: "2026-10-20",
        },
      ],
    }),
    "fixtures.ts": "",
    "skill.generated.ts": "",
    "openapi.generated.ts": "",
    "provider.test.ts": "",
    "provider.safety.node.test.ts": "// Node-only: reads evidence files.",
    "lib/graphql.ts": "",
    "evidence/openapi.json": JSON.stringify({
      url: "https://acme.example/openapi.json",
      revision: "v1",
      digest: DIGEST,
    }),
    "evidence/value-safety.json": JSON.stringify({ format: 5, digest: DIGEST, candidates: {} }),
    "evidence/review.md": "Reviewed against the published reference.\n",
  };
  return {
    name: "acme",
    kind: "api",
    display: "Acme",
    files: Object.keys(files).sort(),
    read: (path) => files[path],
    blockKeys: ["api", "account"],
  };
}

describe("the provider standard's rules", () => {
  it("excuses no provider created after the list", () => {
    expect(PENDING.step1.has("acme")).toBe(false);
    expect(PENDING.step2.has("acme")).toBe(false);
  });

  it("rejects a new provider written to legacy shapes, in every rule family", () => {
    const folder = legacy();
    const found = [
      ...layoutViolations(folder),
      ...evidenceViolations(folder, today),
      ...driftViolations(folder, today),
      ...guideViolations(folder, ""),
    ];
    for (const rule of ["L1", "L2", "L3", "D1", "G1", "G2", "G3", "G4", "G7"]) {
      expect(
        found.some((finding) => finding.startsWith(`${rule}:`)),
        rule,
      ).toBe(true);
    }
  });

  it("holds when-blocks to declared keys on their own lines", () => {
    const folder = standard();
    const guide = (body: string, facts: Partial<ProviderFacts> = {}) =>
      guideViolations(
        {
          ...folder,
          ...facts,
          read: (path) =>
            path === "SKILL.md" ? `---\n{ "name": "acme", "instructionsHeading": "Acme" }\n---\n${body}` : undefined,
        },
        "## Acme\n",
      );
    expect(guide("\n## Ids\n\n<!-- when: account -->\nSelect the account.\n<!-- end -->\n")).toEqual([]);
    expect(guide("\n<!-- when: region -->\nUS only.\n<!-- end -->\n")).toEqual([
      "G2: SKILL.md uses the undeclared when-block key region",
    ]);
    expect(guide("\nText <!-- when: account -->inline<!-- end -->\n")).toContain(
      "G2: a when-block marker stands alone on its line",
    );
    expect(guide("\n<!-- when: account -->\n<!-- when: api -->\n<!-- end -->\n")).toContain(
      "G2: SKILL.md when-blocks must open and close in turn, unnested",
    );
    expect(guide("\n## Ids\n", { kind: "api", blockKeys: [] })).toEqual([]);
  });

  it.each([
    [
      "extra generated key",
      (drift: { generated: { evidence: Record<string, string>; extra?: boolean } }) => {
        drift.generated.extra = true;
      },
      "D2: drift.json needs a generated block",
    ],
    [
      "invalid evidence digest",
      (drift: { generated: { evidence: Record<string, string>; extra?: boolean } }) => {
        drift.generated.evidence["openapi.json"] = "broken";
      },
      "D2: generated.evidence holds one sha256",
    ],
    [
      "missing evidence key",
      (drift: { generated: { evidence: Record<string, string>; extra?: boolean } }) => {
        delete drift.generated.evidence["openapi.json"];
      },
      "D2: generated.evidence holds one sha256",
    ],
  ])("rejects %s through the shared drift validator", (_, corrupt, message) => {
    const folder = standard();
    const drift = JSON.parse(folder.read("drift.json")!);
    corrupt(drift);
    expect(generatedProblems(drift, { kind: folder.kind, files: folder.files })).toEqual([
      expect.stringContaining(message),
    ]);
    expect(
      driftViolations(
        { ...folder, read: (path) => (path === "drift.json" ? JSON.stringify(drift) : folder.read(path)) },
        today,
      ),
    ).toContainEqual(expect.stringContaining(message));
  });
});
