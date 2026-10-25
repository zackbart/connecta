// Node-only: executes the generator against temporary provider folders.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/generate-providers.mjs", import.meta.url));

/** The maintainer OpenAPI compiler, typed for these tests (it is plain ESM). */
interface OpenApiGenerator {
  buildOperationIndex(document: unknown, source: object): any;
  renderOpenApiModule(data: unknown, source: object): string;
  sha256(bytes: string | Uint8Array): string;
}
const generator = async (): Promise<OpenApiGenerator> =>
  (await import(new URL("../scripts/generate-openapi.mjs", import.meta.url).href)) as OpenApiGenerator;
const directories: string[] = [];
const read = (root: string, path: string) => readFileSync(join(root, path), "utf8");
const json = (root: string, path: string) => JSON.parse(read(root, path));
const write = (root: string, path: string, content: string) => writeFileSync(join(root, path), content);

function run(root: string, check = false) {
  return spawnSync(process.execPath, [script, "--root", root, ...(check ? ["--check"] : [])], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "connecta-provider-generation-"));
  directories.push(root);
  for (const folder of ["src/providers/_shared", "scripts", "test"]) mkdirSync(join(root, folder), { recursive: true });
  write(root, "src/providers/_shared/helpers.ts", "export const helper = true;\n");
  write(
    root,
    "package.json",
    JSON.stringify(
      {
        name: "fixture",
        type: "module",
        exports: {
          ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
          "./providers/retired": { types: "./dist/providers/retired.d.ts", import: "./dist/providers/retired.js" },
          "./worker": { types: "./dist/worker.d.ts", import: "./dist/worker.js" },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    root,
    "knip.jsonc",
    '{\n  // Keep this comment and the Worker entry.\n  "entry": [\n    "src/index.ts",\n    "src/providers/retired.ts",\n    "src/worker.ts"\n  ],\n  "project": ["src/**/*.ts"]\n}\n',
  );
  write(
    root,
    "scripts/bundle-budget.json",
    JSON.stringify(
      {
        notes: ["Root note", "./providers/retired old note", "Worker note"],
        entries: {
          ".": { baselineGzip: 50, maxGzip: 101 },
          "./providers/retired": { baselineGzip: 10 },
          "./worker": { baselineGzip: 30, maxGzip: 75 },
        },
      },
      null,
      2,
    ) + "\n",
  );
  write(
    root,
    "README.md",
    "# Fixture\n\n- **Use maintained connections** for Retired: known endpoints, auth defaults, and\n  vetted read/write classifications, imported one at a time.\n\nUnrelated text.\n",
  );
  return root;
}

/** Excuse a provider from both steps, as PENDING excuses the legacy providers. */
function excuse(root: string, name: string, steps: readonly ("step1" | "step2")[] = ["step1", "step2"]) {
  const path = join(root, "test/provider-pending-baseline.json");
  let baseline = { step1: [] as string[], step2: [] as string[] };
  try {
    baseline = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // The first excused provider creates the baseline.
  }
  for (const step of steps) baseline[step] = [...new Set([...baseline[step], name])].sort();
  writeFileSync(path, JSON.stringify(baseline));
}

/** A provider written to the legacy shapes, excused from both steps. */
function provider(root: string, name: string, node = false) {
  excuse(root, name);
  const folder = `src/providers/${name}`;
  mkdirSync(join(root, folder));
  write(
    root,
    `${folder}/index.ts`,
    `import { skill } from "./skill.generated.js";
export const factory = Object.assign((id: string, options: object) => ({ id, kind: "api", options, staticTools: [{ name: "list_items" }] }), {
  definition: { name: ${JSON.stringify(name)}, title: ${JSON.stringify(name.toUpperCase())}, readme: ${JSON.stringify(`Vendor ${name}`)}, kind: "api", skill,
    bundle: { baselineGzip: 17, note: ${JSON.stringify(`./providers/${name} reviewed baseline`)} } }
});\n`,
  );
  write(
    root,
    `${folder}/SKILL.md`,
    `---\n${JSON.stringify({ name, instructionsHeading: "Deployment instructions" })}\n---\n\n<!-- fragment: content -->\n  Keep spaces.\n\n<!-- endfragment -->\n\n<!-- fragment: footer -->\nTail without final newline<!-- endfragment -->\n`,
  );
  write(
    root,
    `${folder}/fixtures.ts`,
    `import { factory } from "./index.js";
export const fixture = { name: ${JSON.stringify(name)}, options: { purpose: "fixture" }, cases: [{ label: "default", options: {} }],
  create(id = "fixture", overrides = {}) { return factory(id, { purpose: "fixture", ...overrides }); }
};
export const createAuthored = () => factory("fixture", {});\n`,
  );
  write(root, `${folder}/drift.json`, '{"kind":"manual","reason":"fixture"}\n');
  write(
    root,
    `${folder}/provider${node ? ".node" : ""}.test.ts`,
    node ? "// Node-only: fixture.\n" : "// Portable fixture.\n",
  );
}

function snapshot(root: string, prefix = ""): Record<string, { content: string; mtime: number }> {
  const files: Record<string, { content: string; mtime: number }> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else files[path] = { content: read(root, path), mtime: statSync(join(root, path)).mtimeMs };
  }
  return files;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("provider folder generation", () => {
  it("preserves workspace-specific Knip entries and provider indentation", () => {
    const root = repository();
    write(
      root,
      "knip.jsonc",
      `{
  "workspaces": {
    ".": {
      "entry": [
        "src/index.ts",
        "src/providers/retired.ts",
        "src/worker.ts"
      ]
    },
    "packages/connecta-eve": { "entry": ["src/index.ts"] }
  }
}\n`,
    );
    provider(root, "alpha");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(read(root, "knip.jsonc")).toContain('        "src/providers/alpha/index.ts",');
    expect(json(root, "knip.jsonc").workspaces["packages/connecta-eve"]).toEqual({ entry: ["src/index.ts"] });
    expect(run(root, true).status).toBe(0);
  });

  it("adds a provider to every generated membership without central edits and excludes _shared", () => {
    const root = repository();
    provider(root, "alpha");
    const first = run(root);
    expect(first.status, first.stderr).toBe(0);
    provider(root, "beta", true);
    const second = run(root);
    expect(second.status, second.stderr).toBe(0);
    const manifest = json(root, "package.json");
    expect(Object.keys(manifest.exports)).toEqual([".", "./providers/alpha", "./providers/beta", "./worker"]);
    expect(manifest.exports["./providers/beta"]).toEqual({
      types: "./dist/providers/beta/index.d.ts",
      import: "./dist/providers/beta/index.js",
    });
    expect(manifest.exports["./worker"]).toEqual({ types: "./dist/worker.d.ts", import: "./dist/worker.js" });
    const knip = read(root, "knip.jsonc");
    expect(knip).toContain("// Keep this comment and the Worker entry.");
    expect(knip).toContain('"src/worker.ts"');
    expect(knip).toContain('"src/providers/beta/index.ts"');
    expect(knip).not.toContain("retired");
    const budgets = json(root, "scripts/bundle-budget.json");
    expect(budgets.entries["./providers/beta"]).toEqual({ baselineGzip: 17 });
    expect(budgets.entries["."]).toEqual({ baselineGzip: 50, maxGzip: 101 });
    expect(budgets.entries["./worker"]).toEqual({ baselineGzip: 30, maxGzip: 75 });
    expect(budgets.notes).toEqual([
      "Root note",
      "Worker note",
      "./providers/alpha reviewed baseline",
      "./providers/beta reviewed baseline",
    ]);
    const fixtures = read(root, "test/providers.generated.ts");
    expect(fixtures).toContain("../src/providers/beta/fixtures.js");
    expect(fixtures).toContain("export const providerFixtures");
    const smoke = read(root, "scripts/provider-smoke.generated.mjs");
    expect(smoke).toContain('"@zackbart/connecta/providers/beta"');
    expect(smoke).toContain("export {\n  fixtures\n}");
    expect(smoke).not.toContain("definition:");
    expect(fixtures + smoke + knip + JSON.stringify(manifest.exports)).not.toContain("_shared");
    expect(read(root, "README.md")).toContain("Vendor alpha, and Vendor beta");
    expect(read(root, "README.md")).toContain("Unrelated text.");
    expect(run(root, true).status).toBe(0);
    // Run the bundled fixtures with fake installed subpaths. Their factory is
    // deliberately different from the source factory: bundling that source
    // accidentally would make this fail even though the import smoke passed.
    const installed = join(root, "node_modules/@zackbart/connecta");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          "./providers/alpha": "./alpha.mjs",
          "./providers/beta": "./beta.mjs",
        },
      }),
    );
    for (const name of ["alpha", "beta"]) {
      writeFileSync(
        join(installed, `${name}.mjs`),
        'export const factory = (id, options) => ({ id, options, kind: "installed" });\n',
      );
    }
    const packed = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { fixtures } from "./scripts/provider-smoke.generated.mjs";
      if (fixtures.length !== 2 || fixtures.some((fixture) => fixture.create("packed").kind !== "installed")) process.exit(1);
    `,
      ],
      { cwd: root, encoding: "utf8", timeout: 10_000 },
    );
    expect(packed.status, packed.stderr).toBe(0);
  });

  it.each(["index.ts", "drift.json"])("rejects a missing required %s with a provider-specific error", (file) => {
    const root = repository();
    provider(root, "alpha");
    unlinkSync(join(root, "src/providers/alpha", file));
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `src/providers/alpha: missing required file ${file === "provider.test.ts" ? "provider.node.test.ts" : file}`,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("checks each operation index against its pinned source offline and never regenerates it", async () => {
    const { buildOperationIndex, renderOpenApiModule, sha256 } = await generator();
    const root = repository();
    provider(root, "alpha");
    expect(run(root).status).toBe(0);
    const document = JSON.stringify({ openapi: "3.0.0", info: { version: "1" }, paths: { "/v1/items": { get: {} } } });
    const source = { url: "https://vendor.example/openapi.json", revision: "r1", digest: sha256(document) };
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify(source));
    const stale = run(root, true);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Operation indexes differ from their OpenAPI pins (run providers:spec)");
    expect(stale.stderr).toContain("src/providers/alpha/openapi.generated.ts");
    const generated = renderOpenApiModule(buildOperationIndex(JSON.parse(document), source), source);
    write(root, "src/providers/alpha/openapi.generated.ts", generated);
    expect(run(root, true).status).toBe(0);
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify({ ...source, options: { depth: 1 } }));
    expect(run(root, true).stderr).toContain("src/providers/alpha/openapi.generated.ts");
    write(root, "src/providers/alpha/openapi.source.json", JSON.stringify({ ...source, revision: "r2" }));
    const before = snapshot(root);
    const moved = run(root, true);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("src/providers/alpha/openapi.generated.ts");
    // The offline pass reports; only the network-backed providers:spec writes an index.
    expect(snapshot(root)).toEqual(before);
    expect(run(root).status).toBe(1);
    expect(read(root, "src/providers/alpha/openapi.generated.ts")).toBe(generated);
  });
});

interface StandardOptions {
  kind?: "api";
  /** TypeScript spread into the definition: blocks and kit. */
  definition?: string;
  skill?: string;
  checks?: unknown[];
  files?: Record<string, string>;
}

/** A provider past both steps: a standard guide, a version-2 drift record, and its providers.md section. */
// Standard providers declare their error meanings and idempotency fact for the Conventions.
const KIT_FACTS = `errors: { unknownId: "connector_call_failed", provesAbsence: false, conflicts: [] }, idempotencyKey: false`;
const DEFAULT_KIT = `kit: { operations: [], ${KIT_FACTS} },`;

function standardProvider(root: string, name: string, options: StandardOptions = {}) {
  const folder = `src/providers/${name}`;
  mkdirSync(join(root, folder, "evidence"), { recursive: true });
  write(
    root,
    `${folder}/index.ts`,
    `import { skill } from "./skill.generated.js";
export const factory = Object.assign((id: string) => ({ id }), {
  definition: { name: ${JSON.stringify(name)}, title: ${JSON.stringify(name.toUpperCase())}, readme: ${JSON.stringify(`Vendor ${name}`)},
    kind: ${JSON.stringify(options.kind ?? "api")}, skill, bundle: { baselineGzip: 17 }, ${options.definition ?? DEFAULT_KIT} }
});\n`,
  );
  write(
    root,
    `${folder}/SKILL.md`,
    `---\n${JSON.stringify({ name, instructionsHeading: "Deployment instructions" })}\n---\n\n${
      options.skill ?? "## Identity\n\nResolve an account id before any write.\n"
    }`,
  );
  write(
    root,
    `${folder}/fixtures.ts`,
    `import { factory } from "./index.js";
export const fixture = { name: ${JSON.stringify(name)}, options: { purpose: "fixture" }, cases: [{ label: "default", options: {} }],
  create(id = "fixture") { return factory(id); }
};
export const createAuthored = () => ({ staticTools: [{ name: "get_item", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} } }] });\n`,
  );
  write(
    root,
    `${folder}/drift.json`,
    JSON.stringify({
      version: 2,
      provider: name,
      checks: options.checks ?? [
        {
          type: "manual",
          source: "https://vendor.example/reference",
          reason: "The reference is hand-written HTML.",
          lastVerified: "2026-10-01",
        },
      ],
    }),
  );
  write(root, `${folder}/provider.test.ts`, "// Portable fixture.\n");
  for (const [path, content] of Object.entries(options.files ?? {})) write(root, `${folder}/${path}`, content);
  mkdirSync(join(root, "documentation"), { recursive: true });
  const docs = join(root, "documentation/providers.md");
  let existing = "# Providers\n";
  try {
    existing = readFileSync(docs, "utf8");
  } catch {
    // The first standard provider creates the page.
  }
  writeFileSync(docs, `${existing}\n## Vendor ${name}\n\nSetup for operators.\n`);
}

const generatedSkill = (root: string, name: string) => {
  const source = read(root, `src/providers/${name}/skill.generated.ts`);
  return JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
};

describe("decision 0011 guides and drift records", () => {
  const KIT = `kit: { operations: ["POST /b", "GET /a", "GET /a"], pageSize: { default: 25, max: 100 }, ${KIT_FACTS},
    hatch: { name: "alpha", verdicts: { "GET /a": "read", "POST /b": "write", "DELETE /c": "refuse" } } },`;

  it.each([
    [
      "an undeclared when-block key",
      { skill: "<!-- when: region -->\nUS only.\n<!-- end -->\n" },
      "G2: SKILL.md uses the when-block region, which blocks.keys omits",
    ],

    [
      "an endpoint row the manifest does not send",
      {
        checks: [
          {
            type: "endpoints",
            specification: { url: "https://vendor.example/openapi.json" },
            endpoints: [{ operation: "GET /unsent", specRevision: "1" }],
          },
        ],
      },
      "D4: checks[0] entries are keyed by an operation in generated.operations",
    ],
  ])("refuses %s past its step before writing anything", (_label, options, finding) => {
    const root = repository();
    standardProvider(root, "alpha", options);
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`providers/alpha: ${finding}`);
    expect(snapshot(root)).toEqual(before);
    expect(run(root, true).status).toBe(1);
  });

  it.each([{ unknown: "services" }, { get_item: "unknown" }, { get_item: ["services", "groups"] }])(
    "refuses invalid convention tool ownership %j before writing",
    (toolBlocks) => {
      const root = repository();
      standardProvider(root, "alpha");
      const fixture = read(root, "src/providers/alpha/fixtures.ts");
      write(
        root,
        "src/providers/alpha/fixtures.ts",
        fixture + `\nexport const conventionToolBlocks=${JSON.stringify(toolBlocks)};\n`,
      );
      const before = snapshot(root),
        result = run(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("conventionToolBlocks");
      expect(snapshot(root)).toEqual(before);
    },
  );

  it("generates an endpoint row awaiting its contract, which providers:check --record then writes", async () => {
    const { driftViolations } = await import("./provider-standard.js");
    const root = repository();
    const pages = join(root, "pages");
    mkdirSync(pages);
    for (const [file, method, path] of [
      ["list-a", "get", "/a"],
      ["create-b", "post", "/b"],
    ]) {
      const snippet = {
        openapi: "3.1.0",
        info: { version: "3" },
        paths: { [path!]: { [method!]: { responses: {} } } },
      };
      write(root, `pages/${file}.md`, `# OpenAPI definition\n\n\`\`\`json\n${JSON.stringify(snippet)}\n\`\`\`\n`);
    }
    standardProvider(root, "alpha", {
      definition: KIT,
      checks: [
        {
          type: "endpoints",
          specification: { url: "https://docs.vendor.example/reference/", format: "readme-operation-pages" },
          endpoints: [
            { operation: "GET /a", page: "list-a", specRevision: "0" },
            { operation: "POST /b", page: "create-b", specRevision: "0" },
          ],
        },
      ],
    });
    const facts = () => ({
      name: "alpha",
      kind: "api",
      display: "Vendor alpha",
      files: ["drift.json"],
      read: (path: string) => (path === "drift.json" ? read(root, "src/providers/alpha/drift.json") : undefined),
    });
    write(
      root,
      "src/providers/alpha/fixtures.ts",
      read(root, "src/providers/alpha/fixtures.ts").replace("export const createAuthored", "const originalAuthored") +
        `
export const createAuthored = () => ({ staticTools: [
  { name: "get_widget", inputSchema: { properties: { cursor: { type: "string" } } }, outputSchema: { type: "object", properties: { page: { type: "object", properties: { hasMore: { type: "boolean" } } } } } },
  { name: "list_terminal", outputSchema: { properties: { page: { properties: { hasMore: { const: false } } } } } },
  { name: "alpha_api_read", inputSchema: { properties: { query: { type: "object" } } }, outputSchema: { properties: { page: { properties: { hasMore: { type: "boolean" }, param: { type: "string" }, in: { enum: ["query", "body"] } } } } } },
  { name: "get_summary", outputSchema: { type: "object", properties: { title: { type: "string" } } } }
] });
`,
    );
    const authoredFixture = read(root, "src/providers/alpha/fixtures.ts");
    for (const replacement of [
      "export const noAuthored",
      "export const createAuthored = () => ({}); const ignoredAuthored",
      "export const createAuthored = () => ({ staticTools: [] }); const ignoredAuthored",
    ]) {
      write(
        root,
        "src/providers/alpha/fixtures.ts",
        authoredFixture.replace("export const createAuthored", replacement),
      );
      const before = snapshot(root);
      const invalid = run(root);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/providers\/alpha: .*createAuthored/);
      expect(snapshot(root)).toEqual(before);
    }
    write(root, "src/providers/alpha/fixtures.ts", authoredFixture);
    // Generation accepts the rows --record will complete; the suite does not accept them committed.
    expect(run(root).status).toBe(0);
    const guide = generatedSkill(root, "alpha").content;
    expect(guide).toContain("For `get_widget`, pass it as the top-level `cursor`");
    expect(guide).toContain("For `alpha_api_read`, put it in `query[page.param]`");
    expect(guide).not.toContain("`list_terminal`");
    expect(guide.match(/\*\*Paging:\*\*/g)).toHaveLength(1);
    expect(guide).toContain("`query[page.param]` or `body[page.param]`");
    expect(guide).not.toContain("`get_summary`");
    expect(guide).toContain("before the call that would exceed it and continue in the next program; don't restart");
    const { renderConventions } = await import(new URL("../scripts/provider-guide.mjs", import.meta.url).href);
    const kit = {
      idempotencyKey: false,
      errors: { unknownId: "connector_call_failed", provesAbsence: false, conflicts: [] },
    };
    const pagingTools = ["list_common", "list_services"].map((name) => ({
      name,
      inputSchema: { properties: { cursor: { type: "string" } } },
      outputSchema: { properties: { page: { properties: { hasMore: { type: "boolean" } } } } },
    }));
    const ordinary = { name: "alpha", kind: "api", kit, tools: pagingTools };
    expect(renderConventions({ ...ordinary, toolBlocks: undefined })).toBe(renderConventions(ordinary));
    const conditional = renderConventions({
      ...ordinary,
      keys: ["services"],
      toolBlocks: { list_services: "services" },
    });
    expect(conditional).toContain("<!-- when: services -->\n- **Paging:** For `list_services`");
    expect(conditional).toContain("For `list_common`, pass it as the top-level `cursor`");
    for (const toolBlocks of [
      { unknown: "services" },
      { list_services: "unknown" },
      { list_services: ["services", "groups"] },
      [],
    ])
      expect(() => renderConventions({ ...ordinary, keys: ["services"], toolBlocks })).toThrow(/conventionToolBlocks/);
    for (const count of [0, 1, 70, 10000]) {
      const rendered = renderConventions({
        name: "alpha",
        kind: "api",
        kit: {
          ...kit,
          hatch: {
            name: "widgets",
            verdicts: Object.fromEntries(Array.from({ length: count }, (_, i) => [`DELETE /widgets/${i}`, "refuse"])),
          },
        },
      });
      const line = rendered.split("\n").find((line: string) => line.startsWith("- **Hatch:**"))!;
      if (count) {
        expect(line).toContain(`${count} ${count === 1 ? "operation is" : "operations are"} refused by design`);
        expect(line).toContain("use `widgets_api_details` with the method and path");
      } else expect(line).not.toContain("refused by design");
      expect(line).toContain("An operation without a reviewed verdict is refused");
      expect(line).not.toContain("DELETE /widgets");
      expect(new TextEncoder().encode(line).length).toBeLessThan(550);
    }
    expect(driftViolations(facts(), "2026-10-20")).toEqual([
      "D3: providers:check rejects checks[0]: invalid contract digest: GET /a",
    ]);
    const recorded = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/drift-check.mjs", import.meta.url)),
        "--specs",
        "--record",
        "--provider-dir",
        join(root, "src/providers"),
        "--provider",
        "alpha",
        "--spec",
        `alpha=${pages}/`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(recorded.status, recorded.stdout + recorded.stderr).toBe(0);
    expect(json(root, "src/providers/alpha/drift.json").checks[0].endpoints).toEqual([
      { operation: "GET /a", page: "list-a", specRevision: "3", contract: expect.stringMatching(/^sha256:/) },
      { operation: "POST /b", page: "create-b", specRevision: "3", contract: expect.stringMatching(/^sha256:/) },
    ]);
    expect(driftViolations(facts(), "2026-10-20")).toEqual([]);
    expect(run(root, true).status).toBe(0);
  });

  it("refuses a version-1 record past step 1, and excuses G only while step 2 is pending", () => {
    const root = repository();
    standardProvider(root, "alpha");
    write(root, "src/providers/alpha/drift.json", '{"version":1,"provider":"alpha","checks":[]}\n');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("providers/alpha: D1: drift.json needs version 2 and this provider's name");
    // Excused from step 1 only: D waits, and a legacy guide is still G's business.
    excuse(root, "alpha", ["step1"]);
    expect(run(root).status).toBe(0);
    write(
      root,
      "src/providers/alpha/SKILL.md",
      read(root, "src/providers/alpha/SKILL.md").replace("## Identity", "# Identity"),
    );
    expect(run(root).stderr).toContain("providers/alpha: G3: SKILL.md headings start at ##");
    // Excused from step 2 as well: the fragment guide and its parser stay.
    excuse(root, "alpha", ["step2"]);
    write(
      root,
      "src/providers/alpha/SKILL.md",
      `---\n${JSON.stringify({ name: "alpha", instructionsHeading: "Notes" })}\n---\n<!-- fragment: content -->\n# Legacy\n<!-- endfragment -->\n`,
    );
    expect(run(root).status).toBe(0);
    expect(generatedSkill(root, "alpha")).toEqual({
      content: "# Legacy\n",
      instructionsHeading: "Notes",
      fragments: { content: "# Legacy\n" },
    });
  });
});

describe("OpenAPI operation index generation", () => {
  const document = {
    openapi: "3.0.0",
    info: { version: "2026-09-30.test" },
    servers: [{ url: "https://api.vendor.example/" }],
    components: {
      schemas: {
        address: {
          type: "object",
          description: "<p>Postal address.</p> More prose.",
          properties: { city: { type: "string", maxLength: 5000 }, line1: { type: "string" } },
        },
      },
    },
    paths: {
      "/v1/things": {
        get: {
          operationId: "GetThings",
          summary: "List things",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer" }, description: "A limit. Ignored prose." },
            {
              name: "created",
              in: "query",
              style: "deepObject",
              schema: { type: "object", properties: { gte: { type: "integer" } } },
            },
          ],
        },
        post: {
          operationId: "PostThings",
          summary: "Create a thing",
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", description: "The name." },
                    shipping: { $ref: "#/components/schemas/address" },
                    billing: { $ref: "#/components/schemas/address" },
                    deep: {
                      type: "object",
                      properties: { inner: { type: "object", properties: { leaf: { type: "string" } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/things/{thing}": {
        delete: {
          operationId: "DeleteThing",
          summary: "Delete a thing",
          parameters: [{ name: "thing", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: { "application/x-www-form-urlencoded": { schema: { type: "object", properties: {} } } },
          },
        },
        get: { operationId: "GetThing", summary: "Old", deprecated: true },
      },
      "/v1/uploads": {
        post: {
          operationId: "PostUploads",
          summary: "Upload",
          servers: [{ url: "https://files.vendor.example/" }],
          requestBody: {
            content: {
              "multipart/form-data": {
                schema: { type: "object", properties: { file: { type: "string", format: "binary" } } },
              },
            },
          },
        },
      },
    },
  };
  const source = { url: "https://vendor.example/r1.json", revision: "r1", digest: `sha256:${"0".repeat(64)}` };

  it("drops deprecated operations, records per-operation servers, and shares repeated schema nodes", async () => {
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const { buildOperationIndex } = await generator();
    const { normalizeDiscovery, discoveryMethods } = await import(
      new URL("../scripts/google-discovery.mjs", import.meta.url).href
    );
    const pins = JSON.parse(
      readFileSync(new URL("./fixtures/google-discovery/manifest.json", import.meta.url), "utf8"),
    );
    let operations = 0,
      requiredAnnotations = 0;
    for (const pin of pins) {
      const bytes = readFileSync(new URL(`./fixtures/google-discovery/${pin.provider}.json`, import.meta.url));
      expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(pin.digest);
      const original = JSON.parse(bytes.toString());
      const normalized = normalizeDiscovery(original);
      const deprecations = (raw: any, converted: any) => {
        if (raw?.deprecated === true) expect(converted?.deprecated).toBe(true);
        for (const [name, field] of Object.entries(raw?.properties ?? {}))
          deprecations(field, converted?.properties?.[name]);
        if (raw?.items) deprecations(raw.items, converted?.items);
        if (raw?.additionalProperties && typeof raw.additionalProperties === "object")
          deprecations(raw.additionalProperties, converted?.additionalProperties);
      };
      for (const [name, schema] of Object.entries(original.schemas))
        deprecations(schema, normalized.components.schemas[name]);
      const compiled = buildOperationIndex(normalized, {
        ...pin,
        options: { depth: 5, numericBounds: true, formats: true, requestGraph: true, deprecations: true },
      });
      expect(compiled.ops).toHaveLength(pin.methods);
      expect(new Set(compiled.ops.map((row: string[]) => `${row[0]} ${row[1]}`)).size).toBe(pin.methods);
      const names = { vendor: pin.provider, title: pin.provider };
      const legacyIndex = new OperationIndex(compiled, names);
      const index = new OperationIndex(compiled, { ...names, pathMatching: "uri-template" });
      expect(await index.cursorRevision()).not.toBe(await legacyIndex.cursorRevision());
      for (const row of normalized["x-google-discovery"].mapping) {
        operations++;
        const op = index.ops.find((op) => op.operationId === row.id)!;
        expect(`${op.method} ${op.path}`).toBe(row.operation);
        const operation = normalized.paths[op.path][op.method.toLowerCase()];
        const contract = index.contract(op);
        const variables = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
        expect(
          operation.parameters
            .filter((p: any) => p.in === "path")
            .map((p: any) => p.name)
            .sort(),
        ).toEqual(variables);
        expect(
          contract.parameters
            .filter((p) => p.in === "path")
            .map((p) => p.name)
            .sort(),
        ).toEqual(variables);
        for (const parameter of operation.parameters.filter((p: any) => p.deprecated))
          expect(contract.parameters.find((p) => p.name === parameter.name)?.schema).toHaveProperty("deprecated", true);
        const ref = operation.responses[200].content?.["application/json"]?.schema?.$ref;
        if (ref) {
          const properties = normalized.components.schemas[ref.split("/").at(-1)].properties ?? {};
          for (const root of Object.keys(properties)) expect(index.responseRoots(op)?.has(root)).toBe(true);
        }
        expect(index.contract(op).parameters.map((p) => p.name)).not.toEqual(expect.arrayContaining(["access_token"]));
        const concrete = op.path.replace(/\{([^}]+)\}/g, (_whole, name) => {
          const schema = contract.parameters.find(
            (parameter) => parameter.in === "path" && parameter.name === name,
          )!.schema;
          return String(
            (schema["enum"] as unknown[] | undefined)?.[0] ??
              (schema["type"] === "integer" ? Math.max(1, Number(schema["minimum"] ?? 1)) : "fixture-id"),
          );
        });
        expect(index.resolve(op.method, concrete).op.operationId).toBe(op.operationId);
        if (operation.requestBody) {
          expect(index.contract(op).body?.schema).toHaveProperty("properties");
          expect(JSON.stringify(index.contract(op).body?.schema)).not.toContain('"truncated":true');
          const method = discoveryMethods(original).find((method: any) => method.id === op.operationId);
          const full = contract.body!.schema as any;
          const verify = (raw: any, node: any, seen = new Set<string>()) => {
            if (raw?.$ref) {
              if (seen.has(raw.$ref)) return;
              seen = new Set([...seen, raw.$ref]);
              raw = original.schemas[raw.$ref];
            }
            while (node?.$ref) node = full.$defs[node.$ref.split("/").at(-1)];
            for (const [name, value] of Object.entries(raw?.properties ?? {}) as [string, any][]) {
              if (value.annotations?.required?.includes(op.operationId)) {
                requiredAnnotations++;
                expect(node?.required, `${op.operationId}.${name}`).toContain(name);
              } else if (value.annotations?.required && value.required !== true && !raw.required?.includes(name)) {
                expect(node?.required ?? [], `${op.operationId}.${name} must remain optional`).not.toContain(name);
              }
              if (node?.properties?.[name]) verify(value, node.properties[name], seen);
            }
            if (raw?.items) verify(raw.items, node?.items, seen);
            if (raw?.additionalProperties && typeof raw.additionalProperties === "object")
              verify(raw.additionalProperties, node?.additionalProperties, seen);
          };
          verify(method.request, full);
        }
      }
      if (pin.provider === "drive") {
        expect(legacyIndex.resolve("GET", "/files/%67enerateCseToken").op.operationId).toBe("drive.files.get");
        expect(index.resolve("GET", "/files/generateCseToken").op.operationId).toBe("drive.files.generateCseToken");
        expect(index.resolve("GET", "/files/%67enerateCseToken").op.operationId).toBe("drive.files.generateCseToken");
      }
      if (pin.provider === "docs") {
        expect(index.resolve("POST", "/documents/id:batchUpdate").params).toEqual({ documentId: "id" });
        expect(normalized.components.schemas.Document.properties.headers.additionalProperties).toHaveProperty("$ref");
        expect(() => index.resolve("POST", "/documents/id")).toThrow();
      }
      if (pin.provider === "forms") {
        expect(legacyIndex.resolve("POST", "/forms/f:setPublishSettings").op.operationId).toBe(
          "forms.forms.batchUpdate",
        );
        expect(index.resolve("POST", "/forms/f:setPublishSettings").op.operationId).toBe(
          "forms.forms.setPublishSettings",
        );
        expect(normalized.components.schemas.FormResponse.properties.answers.additionalProperties).toHaveProperty(
          "$ref",
        );
      }
      expect(JSON.stringify(normalized)).toBe(JSON.stringify(normalizeDiscovery(JSON.parse(JSON.stringify(original)))));
    }
    expect(operations).toBe(178);
    expect(requiredAnnotations).toBeGreaterThan(10);
    const data = buildOperationIndex(document, { ...source, options: { depth: 2, descriptions: 40 } });
    expect(data.fields).toBeUndefined();
    const { renderOpenApiModule } = await generator();
    expect(renderOpenApiModule(data, source)).not.toContain("fields:");
    expect(data.version).toBe("2026-09-30.test");
    expect(data.servers).toEqual(["https://api.vendor.example", "https://files.vendor.example"]);
    expect(data.ops.map((row: unknown[]) => `${row[0]} ${row[1]}`)).toEqual([
      "GET /v1/things",
      "POST /v1/things",
      "DELETE /v1/things/{thing}",
      "POST /v1/uploads",
    ]);
    expect(data.ops[3]).toEqual(["POST", "/v1/uploads", "PostUploads", "Upload", 1, 1]);
    const details = JSON.parse(data.details);
    // The repeated address schema is one shared node referenced twice.
    const create = details.o[1][1][1];
    expect(create.p.shipping).toEqual({ $: expect.any(Number) });
    expect(create.p.billing).toEqual(create.p.shipping);
    expect(details.d[create.p.shipping.$]).toEqual({
      t: "object",
      d: "Postal address.",
      p: { city: { t: "string" }, line1: { t: "string" } },
    });
    // Past the depth an object keeps its type and is marked truncated; top-level descriptions are clipped.
    expect(create.p.deep).toEqual({ t: "object", p: { inner: { t: "object", x: 1 } } });
    expect(details.o[0][0]).toEqual([
      ["limit", "query", 0, { t: "integer" }, "A limit."],
      ["created", "query", 0, { t: "object", p: { gte: { t: "integer" } } }],
    ]);
    // An empty form body is no body at all.
    expect(details.o[2]).toEqual([[["thing", "path", 1, { t: "string" }]], 0]);
    // Response metadata is independent of request depth, shared, deterministic,
    // and consumable by the standard hatch's field search and preflight.
    const success = {
      content: {
        "application/json": {
          schema: {
            allOf: [
              { properties: { has_more: { type: "boolean" } } },
              { properties: { data: { type: "array", items: { $ref: "#/components/schemas/address" } } } },
            ],
          },
        },
      },
    };
    const withResponses = structuredClone(document) as any;
    withResponses.paths["/v1/things"].get.responses = {
      "400": { content: { "application/json": { schema: { properties: { failure_only: {} } } } } },
      "200": success,
    };
    withResponses.paths["/v1/uploads"].post.responses = { "201": success };
    const compiled = buildOperationIndex(withResponses, { ...source, options: { depth: 0 } });
    const index = new OperationIndex(compiled, { vendor: "fixture", title: "Fixture" });
    expect(index.fields(index.ops[0]!)).toEqual([
      { in: "response", path: "data" },
      { in: "response", path: "data[].city" },
      { in: "response", path: "data[].line1" },
      { in: "response", path: "has_more" },
    ]);
    expect([...index.responseRoots(index.ops[0]!)!]).toEqual(["data", "has_more"]);
    expect(index.responseRoots(index.ops[1]!)).toBeUndefined();
    const packed = JSON.parse(compiled.fields);
    expect(packed.o[0]).toBe(packed.o[3]);
    const reversed = structuredClone(withResponses);
    reversed.components.schemas.address.properties = {
      line1: { type: "string" },
      city: { type: "string", maxLength: 5000 },
    };
    expect(buildOperationIndex(reversed, source).fields).toBe(compiled.fields);
    const successes = structuredClone(withResponses);
    successes.paths["/v1/things"].get.responses["202"] = {
      content: { "application/json": { schema: { properties: { accepted_only: {} } } } },
    };
    expect(buildOperationIndex(successes, source).fields).toBe(compiled.fields);
    const union = new OperationIndex(
      buildOperationIndex(successes, { ...source, options: { allSuccessResponses: true } }),
      { vendor: "fixture", title: "Fixture" },
    );
    expect(union.responseRoots(union.ops[0]!)?.has("accepted_only")).toBe(true);
    // Root arrays, union variants, local response refs and recursive schemas.
    withResponses.components.responses = {
      list: {
        content: {
          "application/problem+json": {
            schema: {
              type: "array",
              items: {
                oneOf: [
                  { $ref: "#/components/schemas/address" },
                  { properties: { widget_id: {}, recursive: { $ref: "#/components/schemas/address" } } },
                ],
              },
            },
          },
        },
      },
    };
    withResponses.paths["/v1/things"].get.responses = { "200": { $ref: "#/components/responses/list" } };
    const arrays = new OperationIndex(buildOperationIndex(withResponses, source), {
      vendor: "fixture",
      title: "Fixture",
    });
    expect([...arrays.responseRoots(arrays.ops[0]!)!]).toEqual(["city", "line1", "recursive", "widget_id"]);
    const wildcard = structuredClone(withResponses);
    wildcard.components.responses.list.content = { "*/*": { schema: { properties: { reviewed_name: {} } } } };
    const wildcardIndex = (options = {}) =>
      new OperationIndex(buildOperationIndex(wildcard, { ...source, options }), {
        vendor: "fixture",
        title: "Fixture",
      });
    expect(wildcardIndex().responseRoots(wildcardIndex().ops[0]!)).toBeUndefined();
    const admitted = wildcardIndex({ additionalResponseMediaTypes: ["*/*"] });
    expect([...admitted.responseRoots(admitted.ops[0]!)!]).toEqual(["reviewed_name"]);
    // Only the provider opt-in opens an explicitly empty, implicitly open object.
    const emptyRequests = structuredClone(document) as any;
    emptyRequests.paths["/v1/uploads"].post.requestBody = {
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              implicit: { type: "object", properties: {} },
              closed: { type: "object", properties: {}, additionalProperties: false },
              named: { type: "object", properties: { known: { type: "string" } } },
            },
          },
        },
      },
    };
    const emptyIndex = (options = {}) =>
      new OperationIndex(buildOperationIndex(emptyRequests, { ...source, options: { depth: 3, ...options } }), {
        vendor: "fixture",
        title: "Fixture",
      });
    const closed = emptyIndex();
    const open = emptyIndex({ emptyObjectsOpen: true });
    expect(() =>
      closed.check(closed.operation("POST", "/v1/uploads")!, {}, { implicit: { vendor_filter: 1 } }),
    ).toThrow(/vendor_filter/);
    expect(() =>
      open.check(open.operation("POST", "/v1/uploads")!, {}, { implicit: { vendor_filter: 1 } }),
    ).not.toThrow();
    for (const key of ["closed", "named"])
      expect(() => open.check(open.operation("POST", "/v1/uploads")!, {}, { [key]: { vendor_filter: 1 } })).toThrow(
        /vendor_filter/,
      );
    // Bound pathological documents without treating a partial root set as complete.
    withResponses.components.responses.list.content["application/problem+json"].schema = {
      properties: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`field_${i}`, {}])),
    };
    const bounded = new OperationIndex(buildOperationIndex(withResponses, source), {
      vendor: "fixture",
      title: "Fixture",
    });
    expect(bounded.responseRoots(bounded.ops[0]!)).toBeUndefined();
    // Open roots (also through refs/composition or root-array items) have no
    // exhaustive property set against which fields can safely refuse a key.
    for (const schema of [
      { properties: { known: {} }, additionalProperties: true },
      { allOf: [{ properties: { known: {} } }, { additionalProperties: {} }] },
      { type: "array", items: { properties: { known: {} }, additionalProperties: true } },
    ]) {
      withResponses.components.responses.list.content["application/problem+json"].schema = schema;
      const open = new OperationIndex(buildOperationIndex(withResponses, source), {
        vendor: "fixture",
        title: "Fixture",
      });
      expect(open.responseRoots(open.ops[0]!)).toBeUndefined();
    }
  });

  it("reads the API version from a named header parameter when info.version is not the sent version", async () => {
    const { buildOperationIndex } = await generator();
    const versioned = (values: string[]) => ({
      openapi: "3.1.0",
      info: { title: "Vendor", version: "1.0.0" },
      servers: [{ url: "https://api.vendor.example" }],
      components: {
        parameters: { version: { name: "Vendor-Version", in: "header", required: true, schema: { enum: values } } },
      },
      paths: { "/v1/things": { get: { parameters: [{ $ref: "#/components/parameters/version" }] } } },
    });
    const options = { versionHeader: "vendor-version" };
    expect(buildOperationIndex(versioned(["2026-03-11"]), { ...source, options }).version).toBe("2026-03-11");
    expect(buildOperationIndex(versioned(["2026-03-11"]), source).version).toBe("1.0.0");
    // Two offered versions would pin one silently, so generation refuses.
    expect(() => buildOperationIndex(versioned(["2025-09-03", "2026-03-11"]), { ...source, options })).toThrow(
      "expected one vendor-version header value in the document, found 2",
    );
  });

  // Shapes from Cloudflare's and Vercel's documents: DNS records are oneOf
  // allOf (shared fields plus per-type fields), KV bulk writes take a root
  // array, uploads take binary, and Vercel serves HEAD for artifacts.
  const vendor = {
    openapi: "3.0.0",
    info: { version: "1" },
    servers: [{ url: "https://api.vendor.example/client/v4" }],
    components: {
      schemas: {
        base: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" }, ttl: { type: "number" }, proxied: { type: "boolean" } },
        },
        a: {
          allOf: [
            { $ref: "#/components/schemas/base" },
            {
              type: "object",
              required: ["type", "content"],
              properties: { type: { type: "string", enum: ["A"] }, content: { type: "string", format: "ipv4" } },
            },
          ],
        },
        cname: {
          allOf: [
            { $ref: "#/components/schemas/base" },
            {
              properties: { type: { type: "string", enum: ["CNAME"] }, content: { type: "string" } },
              required: ["type", "content"],
            },
          ],
        },
      },
    },
    paths: {
      "/zones/{zone_id}/dns_records": {
        post: {
          operationId: "dns-records-create",
          parameters: [{ name: "zone_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { oneOf: [{ $ref: "#/components/schemas/a" }, { $ref: "#/components/schemas/cname" }] },
              },
            },
          },
        },
      },
      "/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/bulk": {
        put: {
          operationId: "kv-bulk-write",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["key", "value"],
                    properties: { key: { type: "string" }, value: { type: "string" }, metadata: {} },
                  },
                },
              },
            },
          },
        },
      },
      "/accounts/{account_id}/scripts/{name}/content": {
        put: {
          operationId: "script-content",
          requestBody: { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        },
      },
      "/accounts/{account_id}/settings": {
        patch: {
          operationId: "settings",
          requestBody: {
            content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
          },
        },
      },
      "/v8/artifacts/{hash}": { head: { operationId: "artifactExists", summary: "Check an artifact" } },
    },
  };

  it("folds allOf into complete oneOf alternatives, so misspelled and missing DNS fields are refused", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(buildOperationIndex(vendor, source), { vendor: "cf", title: "Cloudflare" });
    const create = index.resolve("POST", "/zones/z1/dns_records").op;
    const body = index.contract(create).body!;
    expect(body.required).toBe(true);
    expect((body.schema as any).anyOf).toHaveLength(2);
    expect((body.schema as any).anyOf[0]).toMatchObject({
      type: "object",
      required: ["name", "type", "content"],
      properties: { name: {}, ttl: {}, proxied: {}, type: { enum: ["A"] }, content: {} },
    });
    expect(() => index.check(create, {}, { type: "A", name: "www", content: "192.0.2.1", ttl: 60 })).not.toThrow();
    expect(() => index.check(create, {}, { type: "CNAME", name: "www", content: "example.com" })).not.toThrow();
    let refusal: any;
    try {
      index.check(create, {}, { typ: "A", nmae: "x", contnet: "192.0.2.1" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal?.code).toBe("invalid_args");
    expect(refusal.validation.issues.map((issue: any) => `${issue.path} ${issue.code}`)).toEqual(
      expect.arrayContaining(["/body/typ additionalProperties", "/body/nmae additionalProperties"]),
    );
    expect(() => index.check(create, {}, undefined)).toThrow("/body (required: a application/json body)");
  });

  it("keeps array, binary, and open bodies with their requiredness, and HEAD operations", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const data = buildOperationIndex(vendor, source);
    expect(data.ops.map((row: unknown[]) => `${row[0]} ${row[1]}`)).toContain("HEAD /v8/artifacts/{hash}");
    const index = new OperationIndex(data, { vendor: "cf", title: "Cloudflare" });
    const bulk = index.resolve("PUT", "/accounts/a1/storage/kv/namespaces/n1/bulk").op;
    expect(index.contract(bulk).body).toMatchObject({ contentType: "application/json", required: true });
    expect(() => index.check(bulk, {}, [{ key: "k", value: "v" }])).not.toThrow();
    expect(() => index.check(bulk, {}, [{ key: "k" }])).toThrow("/body/0/value (required: a value)");
    expect(() => index.check(bulk, {}, { key: "k", value: "v" })).toThrow("/body (type: array)");
    const script = index.resolve("PUT", "/accounts/a1/scripts/s/content").op;
    expect(index.bodyType(script)).toBe("application/octet-stream");
    const settings = index.resolve("PATCH", "/accounts/a1/settings").op;
    expect(() => index.check(settings, {}, { anything: { goes: true } })).not.toThrow();
    expect(index.resolve("HEAD", "/v8/artifacts/abc").op.operationId).toBe("artifactExists");
  });

  it("intersects duplicate enum and type constraints under allOf, so a narrowed value is refused", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const narrowing = {
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/records": {
          post: {
            operationId: "create",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      {
                        type: "object",
                        properties: {
                          type: { type: "string", enum: ["A", "CNAME"] },
                          kind: { type: "string", enum: ["A"] },
                          ttl: { type: "number" },
                          priority: { type: "string" },
                        },
                      },
                      {
                        properties: {
                          type: { enum: ["A"] },
                          kind: { const: "MX" },
                          ttl: { type: "integer" },
                          priority: { type: "integer" },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    };
    const index = new OperationIndex(buildOperationIndex(narrowing, source), { vendor: "cf", title: "Cloudflare" });
    const create = index.resolve("POST", "/records").op;
    const properties = (index.contract(create).body!.schema as any).properties;
    expect(properties.type).toEqual({ type: "string", enum: ["A"] });
    expect(properties.kind.enum).toEqual([]);
    expect(properties.ttl.type).toBe("integer");
    expect(properties.priority.enum).toEqual([]);
    expect(() => index.check(create, {}, { type: "A" })).not.toThrow();
    expect(() => index.check(create, {}, { type: "CNAME" })).toThrow("/body/type (enum: one of A)");
    // Disjoint constraints admit nothing, and say so rather than naming an empty list.
    for (const value of ["A", "MX", "anything"]) {
      expect(() => index.check(create, {}, { kind: value })).toThrow(
        "/body/kind (enum: no value: this field's combined constraints admit none)",
      );
    }
    expect(() => index.check(create, {}, { priority: 5 })).toThrow("admit none");
  });

  it("distributes outer enum constraints into union branches and drops branches they empty", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const body = (field: unknown) => ({
      openapi: "3.0.0",
      info: { version: "1" },
      paths: {
        "/records": {
          post: {
            operationId: "create",
            requestBody: {
              content: {
                "application/json": { schema: { type: "object", properties: { kind: field } } },
              },
            },
          },
        },
      },
    });
    const narrowed = new OperationIndex(
      buildOperationIndex(body({ allOf: [{ enum: ["A"] }, { anyOf: [{ enum: ["A"] }, { enum: ["B"] }] }] }), source),
      { vendor: "cf", title: "Cloudflare" },
    );
    const create = narrowed.resolve("POST", "/records").op;
    expect(() => narrowed.check(create, {}, { kind: "A" })).not.toThrow();
    expect(() => narrowed.check(create, {}, { kind: "B" })).toThrow("/body/kind (enum: one of A)");
    const emptied = new OperationIndex(
      buildOperationIndex(body({ allOf: [{ enum: ["C"] }, { anyOf: [{ enum: ["A"] }, { enum: ["B"] }] }] }), source),
      { vendor: "cf", title: "Cloudflare" },
    );
    for (const kind of ["A", "B", "C"]) {
      expect(() => emptied.check(emptied.resolve("POST", "/records").op, {}, { kind })).toThrow("admit none");
    }
  });
});

describe("value-safety candidate detection", () => {
  const detection = async () =>
    (await import(new URL("../scripts/value-safety.mjs", import.meta.url).href)) as {
      VALUE_SAFETY_FORMAT: number;
      valueSafetyCandidates(document: unknown, options?: object): Record<string, { fields: string[]; named: boolean }>;
      renderValueSafety(document: unknown, source: object, reviewed?: object): { text: string; problems: string[] };
      reviewedPaths(
        document: unknown,
        table: object,
        options?: object,
      ): {
        operations: Record<string, string[]>;
        resources: Record<string, string[]>;
        bindings: Record<string, string[]>;
        unresolved: string[];
      };
    };

  it("INV-5: flags what either former detector flagged: suffixes on value-carrying fields, containment on any", async () => {
    const { valueSafetyCandidates } = await detection();
    const document = {
      openapi: "3.0.0",
      components: { schemas: { Intent: { type: "object", properties: { client_secret: { type: "string" } } } } },
      paths: {
        "/v1/keys": {
          post: {
            summary: "Create a thing",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        result: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            client_secret: { type: "string" },
                            // Containment (Vercel's former rule) reads every field.
                            password: { type: "string", writeOnly: true },
                            has_token: { type: "boolean" },
                            // Suffixes (Cloudflare's) read only fields that carry a value back.
                            headers: { type: "object" },
                            header_count: { type: "integer", description: "Counts api keys." },
                            stream_keys: { type: "integer" },
                            items: { type: "array", items: { properties: { apiKey: { type: "string" } } } },
                            marked: { type: "string", "x-sensitive": true },
                            note: { type: "string", description: "The bearer value." },
                            intent: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/Intent" }] },
                          },
                        },
                      },
                    },
                  },
                },
              },
              "400": { content: { "application/json": { schema: { properties: { token: { type: "string" } } } } } },
            },
          },
        },
        "/v1/plain": { get: { summary: "Plain", responses: { "200": { description: "ok" } } } },
        "/zones/{id}/presign": { get: { summary: "Rotate", responses: { "200": { description: "ok" } } } },
      },
    };
    const fields = [
      "result.client_secret",
      "result.has_token",
      "result.headers",
      "result.items[].apiKey",
      "result.marked",
      "result.note",
      "result.password",
    ];
    expect(valueSafetyCandidates(document)).toEqual({
      "POST /v1/keys": { fields: [...fields, "result.intent.client_secret"].sort(), named: true },
      "GET /zones/{id}/presign": { fields: [], named: true },
    });
    // Stripe: an id-or-object expansion is its own operation's candidate.
    expect(valueSafetyCandidates(document, { expansions: false })["POST /v1/keys"]?.fields).toEqual(fields);
  });

  it("INV-5: checks every reviewed path against the pinned response schema, and refuses unacknowledged misses", async () => {
    const { reviewedPaths, renderValueSafety } = await detection();
    const hook = {
      type: "object",
      properties: { object: { type: "string", enum: ["hook"] }, secret: { type: "string" }, url: { type: "string" } },
    };
    const document = {
      openapi: "3.0.0",
      components: { schemas: { Hook: hook } },
      paths: {
        "/v1/hooks/{id}": { get: ok({ $ref: "#/components/schemas/Hook" }) },
        "/v1/hooks": {
          get: ok({
            type: "object",
            properties: { data: { type: "array", items: { $ref: "#/components/schemas/Hook" } } },
          }),
        },
        "/v1/wrapped": { get: ok({ type: "object", properties: { result: { $ref: "#/components/schemas/Hook" } } }) },
      },
    };
    const table = {
      operations: {
        "GET /v1/hooks/{id}": { verdict: "redact", reason: "r", paths: ["secret", "origin:url", "url.missing"] },
        // A named segment reaches through a list, as the engine applies it.
        "GET /v1/hooks": { verdict: "redact", reason: "r", paths: ["data.secret", "data[].url#url"] },
        "GET /v1/wrapped": { verdict: "safe", reason: "r", keep: ["secret"] },
      },
      resources: { key: "object", rules: { hook: { reason: "r", paths: ["secret", "nope"] }, ghost: { reason: "r" } } },
    };
    expect(reviewedPaths(document, table, { dataRoot: "result" })).toEqual({
      operations: {
        "GET /v1/hooks/{id}": ["origin:url", "secret"],
        "GET /v1/hooks": ["data.secret", "data[].url#url"],
        "GET /v1/wrapped": ["secret"],
      },
      resources: { hook: ["secret"], ghost: [] },
      bindings: {},
      unresolved: ["GET /v1/hooks/{id}: url.missing", "resource hook: nope", "resource ghost: no schema declares it"],
    });
    // A guest condition is held to the schema's binding fields: identity-named fields and Customer or Account references.
    const sessionDocument = {
      openapi: "3.0.0",
      components: {
        schemas: {
          customer: { type: "object", properties: { object: { type: "string", enum: ["customer"] } } },
          session: {
            type: "object",
            properties: {
              object: { type: "string", enum: ["session"] },
              customer: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/customer" }] },
              payer: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/customer" }] },
              customer_account: { type: "string" },
              saved_payment_method_options: { type: "object" },
              mode: { type: "string" },
              url: { type: "string" },
            },
          },
        },
      },
      paths: {},
    };
    const guarded = {
      operations: {},
      resources: {
        key: "object",
        rules: { session: { reason: "r", verbatim: ["url"], guest: { bindings: { customer: [] }, unbound: {} } } },
      },
    };
    expect(reviewedPaths(sessionDocument, guarded).bindings).toEqual({
      session: ["customer", "customer_account", "payer", "saved_payment_method_options"],
    });
    // Without the envelope's data root, the wrapped keep names nothing.
    expect(reviewedPaths(document, table).unresolved).toContain("GET /v1/wrapped: secret");
    // An acknowledged absence passes; one that resolves, or a miss nobody acknowledged, is a problem.
    const { problems } = renderValueSafety(
      document,
      { digest: "sha256:x", options: { valueSafety: { dataRoot: "result" } } },
      {
        table,
        absent: { operations: { "GET /v1/hooks/{id}": ["url.missing", "secret"] }, resources: { hook: ["nope"] } },
      },
    );
    expect(problems).toEqual([
      "resource ghost: no schema declares it (not in the response schema)",
      "GET /v1/hooks/{id}: secret (acknowledged absent, but it resolves or the table lacks it)",
    ]);
  });
  const ok = (schema: object) => ({ responses: { "200": { content: { "application/json": { schema } } } } });

  it("INV-5: flags credential fields by name or description, keyed values, env containers, and secret-family names or descriptions, not metadata", async () => {
    const { valueSafetyCandidates } = await detection();
    const document = {
      openapi: "3.0.3",
      components: {
        schemas: { Hook: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } } } },
      },
      paths: {
        "/v1/things": {
          get: ok({
            type: "object",
            properties: {
              tokenId: { type: "string" },
              partialKeyValue: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    clientSecret: { type: "object" },
                    pair: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } } },
                    newEnvVar: { type: "object" },
                    deployHooks: { type: "array", items: { $ref: "#/components/schemas/Hook" } },
                  },
                },
              },
            },
          }),
        },
        "/v1/plain": { get: ok({ type: "object", properties: { name: { type: "string" } } }) },
        "/v1/stores/{id}/rotate-secret": { post: ok({ type: "object" }) },
        "/v1/projects/{id}/handoff": {
          post: {
            ...ok({ type: "object", properties: { code: { type: "string" } } }),
            description: "Returns a `code` that remains valid for 24 hours and can be used to accept the handoff.",
          },
        },
        "/v1/sessions": {
          get: ok({
            type: "object",
            properties: {
              handle: { type: "string", description: "A bearer value that grants access to the session." },
              handleId: { type: "string", description: "The id of the token." },
              inviteCode: { type: "string" },
              teamCode: { type: "string", description: "Code that can be used to join this Team." },
            },
          }),
        },
        "/v1/config/{id}/items": { get: ok({ type: "object" }) },
        "/v1/old": { get: { ...ok({ type: "object", properties: { token: { type: "string" } } }), deprecated: true } },
      },
    };
    expect(valueSafetyCandidates(document, { operationWords: "config/\\{id\\}/items" })).toEqual({
      "GET /v1/config/{id}/items": { fields: [], named: true },
      "GET /v1/things": {
        fields: ["items[].clientSecret", "items[].deployHooks[].url", "items[].newEnvVar", "items[].pair.value"],
        named: false,
      },
      "POST /v1/stores/{id}/rotate-secret": { fields: [], named: true },
      "POST /v1/projects/{id}/handoff": { fields: [], named: true },
      "GET /v1/sessions": { fields: ["handle", "inviteCode", "teamCode"], named: false },
    });
  });
});

describe("decision 0011 evidence names in providers:spec and value safety", () => {
  interface Spec {
    composeOpenApi(directory: string, source: object): Promise<{ document: any; digest: string }>;
    checkOpenApiOutputs(root: string, providers: { directory: string }[]): Promise<string[]>;
    openApiEvidence(directory: string): Promise<{ pin: string } | undefined>;
    readOpenApiSource(directory: string): Promise<unknown>;
    sha256(bytes: string): string;
    specProvider(
      provider: { name: string; directory: string },
      options?: { file?: string; record?: boolean },
    ): Promise<{ problems: string[]; summary: string }>;
  }
  const spec = async () => (await import(new URL("../scripts/generate-openapi.mjs", import.meta.url).href)) as Spec;
  const document = JSON.stringify({
    openapi: "3.0.0",
    info: { version: "1" },
    paths: {
      "/v1/keys": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": { schema: { type: "object", properties: { secret: { type: "string" } } } },
              },
            },
          },
        },
      },
    },
  });
  const table = (absent: boolean) =>
    `export const TABLE = { title: "Acme", operations: { "GET /v1/keys": { verdict: "redact", reason: "Signing secret.", paths: ["secret", "legacy_secret"] } }${
      absent ? ', absent: { reason: "A shared verdict path.", operations: { "GET /v1/keys": ["legacy_secret"] } }' : ""
    } };\n`;

  function folder(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "connecta-evidence-"));
    directories.push(root);
    const directory = join(root, "acme");
    mkdirSync(join(directory, "evidence"), { recursive: true });
    for (const [path, content] of Object.entries(files)) writeFileSync(join(directory, path), content);
    return { root, directory, provider: { name: "acme", directory } };
  }

  it("compiles evidence/openapi.json, writes evidence/value-safety.json, and records a moved pin there", async () => {
    const { checkOpenApiOutputs, sha256, specProvider } = await spec();
    const pin = {
      url: "https://vendor.example/openapi.json",
      revision: "r1",
      digest: sha256(document),
      options: { valueSafety: true },
    };
    const { root, directory, provider } = folder({
      "evidence/openapi.json": JSON.stringify(pin),
      "safety.ts": table(true),
      "document.json": document,
    });
    const file = join(directory, "document.json");
    expect((await specProvider(provider, { file })).problems).toEqual([]);
    expect(readFileSync(join(directory, "openapi.generated.ts"), "utf8").split("\n")[0]).toBe(
      "// Generated by scripts/generate-openapi.mjs from evidence/openapi.json; do not edit.",
    );
    const candidates = JSON.parse(readFileSync(join(directory, "evidence/value-safety.json"), "utf8"));
    expect(candidates).toMatchObject({ digest: pin.digest, reviewed: { operations: { "GET /v1/keys": ["secret"] } } });
    expect(readdirSync(directory)).not.toContain("value-safety.candidates.json");
    expect(await checkOpenApiOutputs(root, [provider])).toEqual([]);
    // Without its absent acknowledgement, a path the schema lacks fails the review.
    const unacknowledged = folder({ "evidence/openapi.json": JSON.stringify(pin), "safety.ts": table(false) });
    expect((await specProvider(unacknowledged.provider, { file })).problems).toEqual([
      "GET /v1/keys: legacy_secret (not in the response schema)",
    ]);
    const moved = document.replace('"version":"1"', '"version":"2"');
    writeFileSync(file, moved);
    await expect(specProvider(provider, { file })).rejects.toThrow("does not match the pinned");
    await specProvider(provider, { file, record: true });
    expect(JSON.parse(readFileSync(join(directory, "evidence/openapi.json"), "utf8")).digest).toBe(sha256(moved));
    expect(readdirSync(directory)).not.toContain("openapi.source.json");
  });

  it("compiles a vendored document offline and moves its pin only by review", async () => {
    const { readOpenApiSource, sha256, specProvider } = await spec();
    const { normalizeDiscovery, GOOGLE_DISCOVERY_FORMAT } = await import(
      new URL("../scripts/google-discovery.mjs", import.meta.url).href
    );
    const original = readFileSync(new URL("./fixtures/google-discovery/forms.json", import.meta.url), "utf8");
    const originalPin = {
      url: "https://forms.googleapis.com/$discovery/rest?version=v1",
      documentation: "https://developers.google.com/forms/api",
      revision: JSON.parse(original).revision,
      digest: sha256(original),
      vendored: true,
    };
    const normalized = JSON.stringify(normalizeDiscovery(JSON.parse(original)), null, 2) + "\n";
    const derived = folder({
      "evidence/openapi.json": JSON.stringify({
        ...originalPin,
        discovery: { pin: "discovery.json", format: GOOGLE_DISCOVERY_FORMAT },
      }),
      "evidence/discovery.json": JSON.stringify(originalPin),
      "evidence/discovery.document.json": original,
      "evidence/openapi.document.json": normalized,
    });
    await specProvider(derived.provider);
    writeFileSync(
      join(derived.directory, "evidence/openapi.document.json"),
      normalized.replace('"openapi": "3.1.0"', '"openapi": "3.0.0"'),
    );
    await expect(specProvider(derived.provider)).rejects.toThrow("Discovery conversion differs");
    writeFileSync(join(derived.directory, "evidence/openapi.document.json"), normalized);
    writeFileSync(join(derived.directory, "evidence/discovery.document.json"), original + " ");
    await expect(specProvider(derived.provider)).rejects.toThrow("Discovery source bytes");
    const yaml = "openapi: 3.0.0\n";
    const pin = { url: "https://vendor.example/openapi.yaml", revision: "1.0.0", digest: sha256(yaml), vendored: true };
    const { directory, provider } = folder({
      "evidence/openapi.json": JSON.stringify(pin),
      "evidence/openapi.document.json": document,
    });
    await specProvider(provider);
    expect(readFileSync(join(directory, "openapi.generated.ts"), "utf8")).toContain(`// digest: ${pin.digest}`);
    await expect(specProvider(provider, { record: true })).rejects.toThrow("a vendored pin moves by review");
    unlinkSync(join(directory, "evidence/openapi.document.json"));
    await expect(readOpenApiSource(directory)).rejects.toThrow("evidence/openapi.document.json is missing");
    const legacy = folder({ "openapi.source.json": JSON.stringify(pin) });
    await expect(readOpenApiSource(legacy.directory)).rejects.toThrow("vendored is true, beside");
  });

  it("reads a vendored index as stale once its conversion document changes", async () => {
    const { checkOpenApiOutputs, sha256, specProvider } = await spec();
    const pin = {
      url: "https://vendor.example/openapi.yaml",
      revision: "1.0.0",
      digest: sha256("openapi: 3.0.0\n"),
      vendored: true,
    };
    const { root, directory, provider } = folder({
      "evidence/openapi.json": JSON.stringify(pin),
      "evidence/openapi.document.json": document,
    });
    await specProvider(provider);
    const output = join(directory, "openapi.generated.ts");
    expect(await checkOpenApiOutputs(root, [provider])).toEqual([]);
    // The published-byte pin is unchanged, but the index it would compile is not.
    const moved = document.replace('"version":"1"', '"version":"2"');
    writeFileSync(join(directory, "evidence/openapi.document.json"), moved);
    expect(await checkOpenApiOutputs(root, [provider])).toEqual(["acme/openapi.generated.ts"]);
    await specProvider(provider);
    expect(readFileSync(output, "utf8")).toContain('version: "2"');
    expect(readFileSync(output, "utf8")).toContain(`// document: ${sha256(moved)}`);
    expect(await checkOpenApiOutputs(root, [provider])).toEqual([]);
    // A non-vendored module states no conversion digest.
    writeFileSync(join(directory, "evidence/openapi.json"), JSON.stringify({ ...pin, vendored: undefined }));
    unlinkSync(join(directory, "evidence/openapi.document.json"));
    expect(await checkOpenApiOutputs(root, [provider])).toEqual(["acme/openapi.generated.ts"]);
    // A multi-document API keeps every actual public URL and namespaces local
    // refs, rather than pinning an invented combined public specification.
    const { composeOpenApi } = await spec();
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const part = (prefix: string, property: string) =>
      JSON.stringify({
        openapi: "3.1.0",
        info: { title: prefix, version: "1" },
        servers: [{ url: `https://vendor.example/${prefix}/v2` }],
        paths: {
          "": { post: { summary: "Uncallable source artifact" } },
          "/things": {
            summary: "Thing",
            get: {
              parameters: [
                {
                  name: "per_page",
                  in: "query",
                  schema: {
                    allOf: [
                      { type: "integer", minimum: 0, maximum: 200 },
                      { minimum: 1, maximum: 100 },
                    ],
                  },
                },
              ],
              responses: {
                "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Thing" } } } },
              },
            },
          },
        },
        components: { schemas: { Thing: { type: "object", properties: { [property]: { type: "string" } } } } },
      });
    const alpha = part("alpha", "name"),
      beta = part("beta", "title");
    const composition = {
      revision: "alpha@1,beta@1",
      documents: [
        { pin: "alpha.json", prefix: "/alpha/v2" },
        { pin: "beta.json", prefix: "/beta/v2" },
      ],
    };
    const pinFor = (name: string, value: string) =>
      JSON.stringify({
        url: `https://vendor.example/${name}.json`,
        documentation: `https://vendor.example/${name}/docs`,
        digest: sha256(value),
        vendored: true,
      });
    const multi = folder({
      "evidence/openapi.json": JSON.stringify(composition),
      "evidence/alpha.json": pinFor("alpha", alpha),
      "evidence/alpha.document.json": alpha,
      "evidence/beta.json": pinFor("beta", beta),
      "evidence/beta.document.json": beta,
    });
    await specProvider(multi.provider);
    expect(await checkOpenApiOutputs(multi.root, [multi.provider])).toEqual([]);
    const composed = await composeOpenApi(multi.directory, composition);
    const index = new OperationIndex(
      buildOperationIndex(composed.document, {
        url: "Actual sources",
        revision: "1",
        digest: composed.digest,
        options: { numericBounds: true },
      }),
      { vendor: "fixture", title: "Fixture" },
    );
    expect(index.ops.map((op) => op.path)).toEqual(["/alpha/v2/things", "/beta/v2/things"]);
    expect(index.contract(index.ops[0]!).parameters[0]?.schema).toEqual({ type: "integer", minimum: 1, maximum: 100 });
    for (const per_page of [0, 101, 1.5, "invalid", "", null])
      expect(() => index.check(index.ops[0]!, { per_page }, undefined)).toThrow("Not sent");
    for (const per_page of [1, "1", 100, "100"])
      expect(() => index.check(index.ops[0]!, { per_page }, undefined)).not.toThrow();
    expect(index.fields(index.ops[0]!)).toContainEqual({ in: "response", path: "name" });
    expect(index.fields(index.ops[1]!)).toContainEqual({ in: "response", path: "title" });
    expect(index.ops.every((op) => op.summary.includes("Thing"))).toBe(true);
    await expect(specProvider(multi.provider, { record: true })).rejects.toThrow("a composed pin moves by review");
    await expect(specProvider(multi.provider, { file: "ignored" })).rejects.toThrow("a composed pin moves by review");
    writeFileSync(join(multi.directory, "evidence/beta.document.json"), beta.replace('"title"', '"label"'));
    await expect(checkOpenApiOutputs(multi.root, [multi.provider])).rejects.toThrow("does not match the pinned");
    const movedBeta = beta.replace('"title"', '"label"');
    writeFileSync(join(multi.directory, "evidence/beta.json"), pinFor("beta", movedBeta));
    expect(await checkOpenApiOutputs(multi.root, [multi.provider])).toEqual(["acme/openapi.generated.ts"]);
    await specProvider(multi.provider);
    expect(await checkOpenApiOutputs(multi.root, [multi.provider])).toEqual([]);
    for (const documents of [
      [{ pin: "../alpha.json", prefix: "/alpha/v2" }],
      [composition.documents[0], composition.documents[0]],
      [{ pin: "alpha.json", prefix: "/alpha/../v2" }],
    ]) {
      writeFileSync(join(multi.directory, "evidence/openapi.json"), JSON.stringify({ ...composition, documents }));
      await expect(specProvider(multi.provider)).rejects.toThrow("unique supplemental document pins");
    }
  });
});
