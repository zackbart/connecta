// Node-only: reads provider folders and documentation/providers.md from disk.
import { generatedProblems } from "../scripts/drift-validate.mjs";
// Applies the current provider standard to every maintained provider folder.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/storage/memory.js";
import { ConnectorCallError } from "../src/errors.js";
import type { VendorErrors } from "../src/http/errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../src/types.js";
import { schemaExample, validateToolInput } from "../src/validate.js";
import { api } from "../src/connectors/api.js";
import { CredentialVault } from "../src/credentials.js";
import { createExecuteTool } from "../src/execute.js";
import { quickJsExecutor } from "../src/executors/quickjs.js";
import { fieldsProblem } from "../src/http/fields.js";
import { createMetaTools } from "../src/meta-tools.js";
import { connection } from "./fixtures/github-api.js";
import { makeRegistry, silentLogger } from "./helpers.js";
import {
  authoredTools,
  driftViolations,
  evidenceViolations,
  guideViolations,
  layoutViolations,
  surfaceViolations,
  type ProviderFacts,
  type ToolFacts,
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

const BAD_FIELDS = ["zz_unknown_a", "zz_unknown_b"];

/**
 * A1: a tool's own argument checks report every problem in one refusal with a
 * corrected call, so an agent repairs it in one turn. Probed offline through
 * `fields`, the custom check every projecting read shares: two bad paths on an
 * otherwise valid call must come back as one `invalid_args` naming both,
 * before any request, with an example — the connector's own, or the call
 * without the bad paths, which invocation supplies. Hatch reads resolve their
 * path first, and a tool whose schema admits no synthesized call is not probed.
 */
async function argumentRefusalViolations(
  connector: Pick<Connector, "callTool">,
  tools: readonly ToolFacts[],
  context: ConnectorContext,
  requests: () => number,
): Promise<string[]> {
  const found: string[] = [];
  for (const tool of tools) {
    const schema = tool.inputSchema as JsonSchema | undefined;
    if (!(schema?.properties as Record<string, unknown> | undefined)?.["fields"] || /_api_[a-z]+$/.test(tool.name))
      continue;
    const valid = validateToolInput(schema!, { zz_unknown: 1 }, { address: tool.name })?.validation?.example;
    if (valid === null || typeof valid !== "object" || Array.isArray(valid)) continue;
    const args = { ...valid, fields: BAD_FIELDS };
    const before = requests();
    const error = await connector.callTool(tool.name, args, context).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    const validation = error instanceof ConnectorCallError ? error.validation : undefined;
    if (requests() !== before) found.push(`A1: ${tool.name} sent a request before refusing its arguments`);
    if (!(error instanceof ConnectorCallError) || error.code !== "invalid_args" || !validation) {
      found.push(`A1: ${tool.name} does not refuse bad fields with structured invalid_args findings`);
      continue;
    }
    const paths = validation.issues.map((issue) => issue.path);
    if (!["/fields/0", "/fields/1"].every((path) => paths.includes(path)))
      found.push(`A1: ${tool.name} reports ${paths.join(", ") || "no path"}, not every bad fields path`);
    // Invocation attaches the schema's synthesized example when a connector states neither one nor a reason.
    const example =
      validation.example ?? (validation.exampleUnavailable === undefined ? schemaExample(schema!).example : undefined);
    if (example === undefined) found.push(`A1: ${tool.name} gives no corrected example call`);
    // No refusal repeats a submitted string, here the refused paths themselves.
    if (BAD_FIELDS.some((field) => JSON.stringify([error.message, validation]).includes(field)))
      found.push(`A1: ${tool.name}'s refusal repeats a refused fields path`);
  }
  return found;
}

describe("argument refusals (A1)", () => {
  it("holds every provider's own argument checks to one complete refusal with an example", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("A1 probes send nothing.");
    });
    vi.stubGlobal("fetch", fetchStub);
    try {
      const found: string[] = [];
      for (const { facts, tools } of folders) {
        const create = authoredFixtures[facts.name];
        if (!create || !tools) continue;
        const connector = create() as unknown as Parameters<typeof argumentRefusalViolations>[0];
        const findings = await argumentRefusalViolations(connector, tools, CONTEXT, () => fetchStub.mock.calls.length);
        found.push(...findings.map((finding) => `${facts.name} ${finding}`));
      }
      expect(found).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("flags a check that refuses one problem per call without an example", async () => {
    const tool = {
      name: "get_note",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" }, fields: { type: "array", items: { type: "string" } } },
        required: ["id"],
      },
    };
    let sent = 0;
    const firstOnly = {
      callTool: async (_name: string, args: { fields?: string[] }) => {
        const bad = args.fields?.findIndex((field) => !["id", "title"].includes(field)) ?? -1;
        throw new ConnectorCallError("invalid_args", "Bad fields path.", {
          validation: { issues: [{ path: `/fields/${bad}`, expected: "id or title" }] },
        });
      },
    };
    expect(await argumentRefusalViolations(firstOnly as never, [tool], CONTEXT, () => sent)).toEqual([
      "A1: get_note reports /fields/0, not every bad fields path",
    ]);
    const prose = {
      callTool: async () => {
        sent++;
        throw new ConnectorCallError("invalid_args", "fields path zz_unknown_a is not a property.");
      },
    };
    expect(await argumentRefusalViolations(prose as never, [tool], CONTEXT, () => sent)).toEqual([
      "A1: get_note sent a request before refusing its arguments",
      "A1: get_note does not refuse bad fields with structured invalid_args findings",
    ]);
    const echo = {
      callTool: async (_name: string, args: { fields?: string[] }) => {
        throw new ConnectorCallError("invalid_args", `Unknown fields ${args.fields?.join(", ")}.`, {
          validation: {
            issues: [0, 1].map((index) => ({ path: `/fields/${index}`, expected: "id or title" })),
            example: { id: "x" },
          },
        });
      },
    };
    expect(await argumentRefusalViolations(echo as never, [tool], CONTEXT, () => sent)).toEqual([
      "A1: get_note's refusal repeats a refused fields path",
    ]);
  });
});

const SENTINEL = "zq-sentinel-7f3a";

/** Put the sentinel everywhere a schema lets a call carry text: values, keys, map keys and array items. */
function sentinelCall(schema: JsonSchema | undefined, base: unknown): Record<string, unknown> {
  const fill = (value: unknown): unknown =>
    typeof value === "string"
      ? SENTINEL
      : Array.isArray(value)
        ? [...value.map(fill), SENTINEL]
        : value !== null && typeof value === "object"
          ? {
              ...Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)])),
              [SENTINEL]: SENTINEL,
            }
          : value;
  const call = fill(base !== null && typeof base === "object" && !Array.isArray(base) ? base : {}) as Record<
    string,
    unknown
  >;
  for (const [key, node] of Object.entries((schema?.properties ?? {}) as Record<string, { type?: unknown }>)) {
    if (node?.type === "object" && call[key] === undefined) call[key] = { [SENTINEL]: SENTINEL };
    if (node?.type === "array" && call[key] === undefined) call[key] = [SENTINEL];
    if (node?.type === "string" && call[key] === undefined) call[key] = SENTINEL;
  }
  return call;
}

describe("refusal echo sweep (A2)", () => {
  it("INV-5 INV-6: sentinel sweep: no argument refusal echoes a submitted string or key", async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error("The sweep sends nothing.");
    });
    vi.stubGlobal("fetch", fetchStub);
    const executor = quickJsExecutor({ cpuTimeMs: 5_000 });
    const counts = { providers: 0, tools: 0, direct: 0, programs: 0, refusals: 0 };
    const leaks: string[] = [];
    const sweep = async (connectors: Connector[], calls: Array<{ address: string; args: unknown; write: boolean }>) => {
      const storage = memoryStorage();
      const vault = new CredentialVault(storage, btoa("k".repeat(32)));
      for (const connector of connectors)
        await vault.setAll(connector.id, { value: "token", email: "operator@example.com" }, "fixture");
      const registry = makeRegistry(connectors, { storage, credentialVault: vault });
      const meta = createMetaTools(registry, "https://connecta.example");
      const program = createExecuteTool(registry, "https://connecta.example", executor, silentLogger, undefined, {
        readOnly: false,
      });
      for (const [index, { address, args, write }] of calls.entries()) {
        const direct = write
          ? await meta.callDestructiveTool({ address, args: args as Record<string, unknown> })
          : await meta.callTool({ address, args: args as Record<string, unknown> });
        counts.direct++;
        if (JSON.stringify(direct).includes('"invalid_args"')) counts.refusals++;
        if (JSON.stringify(direct).includes(SENTINEL)) leaks.push(`${address} direct: ${JSON.stringify(direct)}`);
        // One program per connector and variant keeps the QuickJS cost bounded.
        if (index % 3 !== 0) continue;
        const ran = await program({
          code: `async () => await connecta.call(${JSON.stringify(address)}, ${JSON.stringify(args)})`,
        });
        counts.programs++;
        if (JSON.stringify(ran).includes(SENTINEL)) leaks.push(`${address} program: ${JSON.stringify(ran)}`);
      }
    };
    try {
      for (const { facts, tools } of folders) {
        const create = authoredFixtures[facts.name];
        if (!create || !tools) continue;
        const connector = create() as unknown as Connector;
        counts.providers++;
        const calls = tools.flatMap((tool) => {
          counts.tools++;
          const schema = tool.inputSchema as JsonSchema | undefined;
          const base = schema
            ? validateToolInput(schema, { zz_unknown: 1 }, { address: tool.name })?.validation?.example
            : {};
          const write = tool.annotations?.readOnlyHint !== true;
          const address = `${connector.id}.${tool.name}`;
          return [
            // Schema violations: the sentinel as every value, an unknown key, a map key and an array item.
            { address, args: sentinelCall(schema, base), write },
            // Custom checks on an otherwise valid call.
            ...((schema?.properties as Record<string, unknown> | undefined)?.["fields"]
              ? [{ address, args: { ...(base as object), fields: [SENTINEL, `item.${SENTINEL}`] }, write }]
              : []),
          ];
        });
        await sweep([connector], calls);
      }
      // Generic validator fixtures and the reviewer's round-2 reproductions.
      const fixture = api("fixture_generic", {
        tools: [
          {
            name: "read_map",
            description: "Map keys and a custom fields check",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: {
                headers: { type: "object", additionalProperties: { type: "string" } },
                fields: { type: "array", items: { type: "string" } },
              },
            },
            handler: (args: { fields?: string[] }) => {
              const problem = fieldsProblem(args.fields, new Set(["id", "title"]), "the result");
              if (problem) throw problem;
              return { id: "1" };
            },
          },
          {
            name: "sign_in",
            description: "Sensitive literals",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: {
                password: { type: "string", writeOnly: true, enum: [`credential-${SENTINEL}`] },
                token: { writeOnly: true, const: `const-${SENTINEL}` },
                vault: {
                  type: "object",
                  writeOnly: true,
                  properties: { pin: { type: "string", enum: [`inherited-${SENTINEL}`] } },
                  required: ["pin"],
                },
              },
              required: ["password"],
            },
            handler: () => ({ ok: true }),
          },
        ],
      });
      await sweep(
        [fixture, connection()],
        [
          {
            address: "fixture_generic.read_map",
            args: { headers: { [`X-Secret-${SENTINEL}`]: "value" }, fields: ["bad"] },
            write: false,
          },
          {
            address: "fixture_generic.read_map",
            args: { headers: { [`X-Secret-${SENTINEL}`]: 1 }, fields: [SENTINEL] },
            write: false,
          },
          { address: "fixture_generic.sign_in", args: { password: "wrong" }, write: false },
          {
            address: "fixture_generic.sign_in",
            args: { password: "wrong", token: "x", vault: { pin: "y" } },
            write: false,
          },
          { address: "fixture_generic.sign_in", args: {}, write: false },
          {
            address: "github.search_scoped",
            args: {
              terms: "bug",
              kind: "issues",
              scopes: [{ org: `org-${SENTINEL}`, repo: `repo-${SENTINEL}` }],
              fields: [`secret-field-${SENTINEL}`],
            },
            write: false,
          },
          {
            address: "github.search_scoped",
            args: { terms: `${SENTINEL} OR x`, kind: "issues", scopes: [{ repo: `${SENTINEL}/x` }] },
            write: false,
          },
          {
            address: "github.github_api_write",
            args: {
              method: "POST",
              path: "/repos/acme/one/releases",
              query: { [SENTINEL]: SENTINEL },
              body: { name: SENTINEL, [SENTINEL]: 1 },
            },
            write: true,
          },
        ],
      );
    } finally {
      await executor.close?.();
      vi.unstubAllGlobals();
    }
    if (process.env["A2_LEAKS"]) writeFileSync(process.env["A2_LEAKS"], leaks.join("\n"));
    expect(leaks).toEqual([]);
    // Coverage: every maintained provider, every authored tool, and refusals actually produced.
    expect(counts.providers).toBe(folders.length);
    expect(counts.refusals).toBeGreaterThan(counts.tools / 2);
    expect(counts.programs).toBeGreaterThan(counts.providers);
    console.info(`A2 sentinel sweep coverage: ${JSON.stringify(counts)}`);
  }, 180_000);
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
