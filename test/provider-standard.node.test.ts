// Node-only: reads provider folders and documentation/providers.md from disk.
import { generatedProblems } from "../scripts/drift-validate.mjs";
// Applies the current provider standard to every maintained provider folder.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import type { VendorErrors } from "../src/http/errors.js";
import type { ConnectorContext } from "../src/types.js";
import { silentLogger } from "./helpers.js";
import {
  authoredTools,
  driftViolations,
  evidenceViolations,
  guideViolations,
  layoutViolations,
  surfaceViolations,
  type ProviderFacts,
} from "./provider-standard.js";
import { authoredFixtures } from "./providers.generated.js";

// Check the actual hatch constructor reached by every Google product fixture,
// through declarations in the kit.
const googleBindings = vi.hoisted(() => {
  type Declaration = { connection: { provider: string }; index: object; binding?: { send?: object; index?: object } };
  const bindings = new WeakMap<object, { connection: object; index: object }>();
  const check = ({ connection, index, binding }: Declaration) => {
    if (
      !["Gmail", "Google Drive", "Google Docs", "Google Sheets", "Google Slides", "Google Forms"].includes(
        connection.provider,
      )
    )
      return;
    const reviewed = binding?.send && bindings.get(binding.send);
    if (!reviewed || reviewed.connection !== connection || reviewed.index !== index || binding?.index !== index)
      throw new Error("Google hatch requires googleHatchBinding with its connection and index.");
  };
  return { bindings, check };
});
vi.mock("../src/providers/_shared/google/hatch.js", async (original) => {
  const module = await original<typeof import("../src/providers/_shared/google/hatch.js")>();
  return {
    ...module,
    googleHatchBinding: (...args: Parameters<typeof module.googleHatchBinding>) => {
      const binding = module.googleHatchBinding(...args);
      googleBindings.bindings.set(binding.send, { connection: args[0], index: args[1].index });
      return binding;
    },
  };
});
vi.mock("../src/http/hatch.js", async (original) => {
  const module = await original<typeof import("../src/http/hatch.js")>();
  return {
    ...module,
    hatch: (options: Parameters<typeof module.hatch>[0]) => {
      googleBindings.check(options);
      return module.hatch(options);
    },
  };
});

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
    // The S rules read the tools Connecta authors.
    const createAuthored = authoredFixtures[name];
    const tools = await authoredTools(facts.kind, { name, ...(createAuthored ? { createAuthored } : {}) }, CONTEXT);
    return { facts, tools, vendors };
  }),
);

const folderViolations = ({ facts }: (typeof folders)[number]) =>
  [...layoutViolations(facts), ...evidenceViolations(facts, today), ...driftViolations(facts, today)].map(
    (finding) => `${facts.name} ${finding}`,
  );
const guideAndSurfaceViolations = ({ facts, tools }: (typeof folders)[number]) =>
  [...guideViolations(facts, documentation), ...(tools ? surfaceViolations(tools) : [])].map(
    (finding) => `${facts.name} ${finding}`,
  );

describe("the provider standard (decision 0011)", () => {
  it("holds every provider to layout, evidence, drift and declared Retry-After facts", () => {
    const found = folders.flatMap(folderViolations);
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

  it("holds every provider to the guide and surface rules (G, S)", () => {
    const found = folders.flatMap(guideAndSurfaceViolations);
    expect(found).toEqual([]);
    const index = {},
      other = {},
      connection = { provider: "Google Docs" },
      binding = { send: () => {}, index };
    googleBindings.bindings.set(binding.send, { connection, index });
    expect(() => googleBindings.check({ connection, index, binding })).not.toThrow();
    expect(() => googleBindings.check({ connection, index, binding: { ...binding } })).not.toThrow();
    for (const options of [
      { connection, index },
      { connection, index, binding: {} },
      { connection, index, binding: { send: binding.send } },
      { connection, index: other, binding },
      { connection: { provider: "Gmail" }, index, binding },
    ])
      expect(() => googleBindings.check(options)).toThrow("googleHatchBinding");
  });
});

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
  it("validates composed and Discovery evidence against its pins", () => {
    const base = standard();
    for (const [label, source, pin] of [
      [
        "composed OpenAPI",
        { revision: "alpha@1", documents: [{ pin: "alpha.json", prefix: "/alpha/v2" }] },
        "alpha.json",
      ],
      [
        "primary pin references Discovery evidence",
        {
          url: "https://vendor.example/discovery",
          revision: "r1",
          digest: DIGEST,
          vendored: true,
          discovery: { format: "google-discovery-v1", pin: "discovery.json" },
        },
        "discovery.json",
      ],
    ] as const) {
      const document = pin.replace(".json", ".document.json");
      const extra: Record<string, string> = {
        "evidence/openapi.json": JSON.stringify(source),
        [`evidence/${pin}`]: JSON.stringify({
          url: "https://vendor.example/discovery",
          documentation: "https://vendor.example/docs",
          revision: "r1",
          vendored: true,
          digest: DIGEST,
        }),
        [`evidence/${document}`]: "{}",
      };
      const drift = JSON.parse(base.read("drift.json")!);
      drift.generated.evidence[pin] = DIGEST;
      drift.generated.evidence[document] = DIGEST;
      extra["drift.json"] = JSON.stringify(drift);
      const fixture = {
        ...base,
        files: [...new Set([...base.files, ...Object.keys(extra)])],
        read: (path: string) => extra[path] ?? base.read(path),
      };
      expect(evidenceViolations(fixture, today), label).toEqual([]);
      for (const invalid of ["../alpha.json", "openapi.json"]) {
        extra["evidence/openapi.json"] = JSON.stringify(
          "discovery" in source
            ? { ...source, discovery: { ...source.discovery, pin: invalid } }
            : { ...source, documents: [{ pin: invalid, prefix: "/alpha/v2" }] },
        );
        expect(evidenceViolations(fixture, today), label).toContainEqual(expect.stringMatching(/^E3:/));
      }
      extra["evidence/openapi.json"] = JSON.stringify(source);
      for (const corrupt of [
        { documentation: "http://vendor.example/docs" },
        { vendored: false },
        { digest: `sha256:${"1".repeat(64)}` },
        ...("discovery" in source ? [{ revision: "other" }, { url: "https://other.example/discovery" }] : []),
      ]) {
        const original = extra[`evidence/${pin}`]!;
        extra[`evidence/${pin}`] = JSON.stringify({ ...JSON.parse(original), ...corrupt });
        expect(evidenceViolations(fixture, today), label).toContainEqual(expect.stringMatching(/^E3:/));
        extra[`evidence/${pin}`] = original;
      }
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

describe("the hatch details response contract (S5)", () => {
  it("documents that listed response fields promise no readability and the withheld hint is best effort", () => {
    const text = readFileSync(documentationPath, "utf8").replace(/\s+/g, " ");
    expect(text).toContain("**`response` promises no readability.**");
    expect(text).toContain("may still be withheld or redacted at read time");
    expect(text).toContain("`withheld` is a best-effort, incomplete hint");
    expect(text).toContain("never treat it as safe");
  });
});
