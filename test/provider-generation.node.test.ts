// Node-only: executes the generator against temporary provider folders.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
};\n`,
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

  it("computes current skills before imports and checks freshness without creating or changing files", () => {
    const root = repository();
    provider(root, "alpha");
    const before = snapshot(root);
    const missing = run(root, true);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("src/providers/alpha/skill.generated.ts");
    expect(missing.stderr).toContain("scripts/provider-smoke.generated.mjs");
    expect(snapshot(root)).toEqual(before);
    expect(run(root).status).toBe(0);
    const skillSource = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(skillSource.slice(skillSource.indexOf("= ") + 2, skillSource.lastIndexOf(" as const")));
    expect(skill.content).toBe("  Keep spaces.\n\n");
    expect(skill.fragments.footer).toBe("Tail without final newline");
    write(root, "src/providers/alpha/skill.generated.ts", 'throw new Error("stale skill must not load");\n');
    const staleSnapshot = snapshot(root);
    const stale = run(root, true);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("Stale provider outputs");
    expect(snapshot(root)).toEqual(staleSnapshot);
    expect(run(root).status).toBe(0);
    expect(run(root, true).status).toBe(0);
  });

  it.each(["index.ts", "SKILL.md", "drift.json", "fixtures.ts", "provider.test.ts"])(
    "rejects a missing required %s with a provider-specific error",
    (file) => {
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
    },
  );

  it("refuses a bundle cap on a provider, whose entry is reported rather than capped", () => {
    const root = repository();
    provider(root, "alpha");
    const index = "src/providers/alpha/index.ts";
    write(root, index, read(root, index).replace("baselineGzip: 17,", "baselineGzip: 17, maxGzip: 23,"));
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bundle baselineGzip and optional note, and no cap");
    expect(snapshot(root)).toEqual(before);
  });

  it("rejects malformed or duplicated skill fragments before writing outputs", () => {
    const root = repository();
    provider(root, "alpha");
    const skill = "src/providers/alpha/SKILL.md";
    write(root, skill, read(root, skill) + "<!-- fragment: content -->\nDuplicate<!-- endfragment -->\n");
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("providers/alpha: duplicate skill fragment content");
    expect(snapshot(root)).toEqual(before);
  });

  it("joins fragments verbatim when content is absent and checks all memberships for drift", () => {
    const root = repository();
    provider(root, "alpha");
    const path = "src/providers/alpha/SKILL.md";
    write(root, path, read(root, path).replace("fragment: content", "fragment: intro"));
    expect(run(root).status).toBe(0);
    const source = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
    expect(skill.content).toBe("  Keep spaces.\n\nTail without final newline");
    const outputs = [
      "package.json",
      "knip.jsonc",
      "scripts/bundle-budget.json",
      "README.md",
      "test/providers.generated.ts",
      "scripts/provider-smoke.generated.mjs",
    ];
    for (const output of outputs) {
      const original = read(root, output);
      const changed =
        output === "knip.jsonc"
          ? original.replace("src/providers/alpha/index.ts", "src/providers/retired.ts")
          : output === "README.md"
            ? original.replace("Vendor alpha", "Retired")
            : original + "\n";
      write(root, output, changed);
      const before = snapshot(root);
      const result = run(root, true);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(output);
      expect(snapshot(root)).toEqual(before);
      write(root, output, original);
    }
  });

  it("publishes the fragment the frontmatter names as content, so a dual guide never mixes modes", () => {
    const root = repository();
    provider(root, "alpha");
    const path = "src/providers/alpha/SKILL.md";
    const original = read(root, path);
    const named = (content: string) =>
      original.replace(
        '"instructionsHeading":"Deployment instructions"}',
        `"instructionsHeading":"Deployment instructions","content":${JSON.stringify(content)}}`,
      );
    write(root, path, named("footer"));
    expect(run(root).status).toBe(0);
    const source = read(root, "src/providers/alpha/skill.generated.ts");
    const skill = JSON.parse(source.slice(source.indexOf("= ") + 2, source.lastIndexOf(" as const")));
    expect(skill.content).toBe("Tail without final newline");
    expect(Object.keys(skill.fragments)).toEqual(["content", "footer"]);
    write(root, path, named("missing"));
    const before = snapshot(root);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("providers/alpha: SKILL.md frontmatter content must name one of its fragments");
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
  kind?: "api" | "mcp" | "dual";
  /** TypeScript spread into the definition: blocks, kit, classify. */
  definition?: string;
  skill?: string;
  checks?: unknown[];
  files?: Record<string, string>;
}

/** A provider past both steps: a standard guide, a version-2 drift record, and its providers.md section. */
function standardProvider(root: string, name: string, options: StandardOptions = {}) {
  const folder = `src/providers/${name}`;
  mkdirSync(join(root, folder, "evidence"), { recursive: true });
  write(
    root,
    `${folder}/index.ts`,
    `import { skill } from "./skill.generated.js";
export const factory = Object.assign((id: string) => ({ id }), {
  definition: { name: ${JSON.stringify(name)}, title: ${JSON.stringify(name.toUpperCase())}, readme: ${JSON.stringify(`Vendor ${name}`)},
    kind: ${JSON.stringify(options.kind ?? "api")}, skill, bundle: { baselineGzip: 17 }, ${options.definition ?? ""} }
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
};\n`,
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
const digestOf = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

describe("decision 0011 guides and drift records", () => {
  const KIT = `kit: { operations: ["POST /b", "GET /a", "GET /a"], pageSize: { default: 25, max: 100 },
    hatch: { name: "alpha", verdicts: { "GET /a": "read", "POST /b": "write", "DELETE /c": "refuse" } } },`;

  it("renders a standard guide's Conventions from its declarations and writes drift.json's generated block", () => {
    const root = repository();
    const safety = '{ "format": 5 }\n';
    standardProvider(root, "alpha", {
      definition: KIT,
      files: { "safety.ts": "export const table = {};\n", "evidence/value-safety.json": safety },
    });
    const first = run(root);
    expect(first.status, first.stderr).toBe(0);
    const skill = generatedSkill(root, "alpha");
    expect(Object.keys(skill)).toEqual(["content", "instructionsHeading"]);
    expect(
      skill.content.startsWith("## Identity\n\nResolve an account id before any write.\n\n## Conventions\n\n"),
    ).toBe(true);
    expect(skill.content.split("\n").filter((line: string) => line.startsWith("- **"))).toEqual([
      expect.stringContaining(
        "**Paging:** a paged `list_*` or `search_*` read takes `limit` (default 25, at most 100)",
      ),
      expect.stringContaining("**Results:** `fields` narrows"),
      expect.stringMatching(
        /^- \*\*Hatch:\*\* `alpha_api_search` .*`alpha_api_write` calls a reviewed write, and every call to it needs approval\. .*refused by design: `DELETE \/c`\.$/,
      ),
      expect.stringContaining("**Writes:** a write is sent once and never retried"),
      expect.stringContaining('**Withheld values:** a value withheld for safety reads `"[redacted]"`'),
    ]);
    const drift = json(root, "src/providers/alpha/drift.json");
    expect(Object.keys(drift)).toEqual(["version", "provider", "generated", "checks"]);
    expect(drift.generated).toEqual({
      operations: ["GET /a", "POST /b"],
      hosted: [],
      evidence: { "value-safety.json": digestOf(safety) },
    });
    expect(run(root, true).status).toBe(0);
    // Tools own the generated block: a hand edit, or evidence bytes that moved, is stale.
    const path = "src/providers/alpha/drift.json";
    const generated = read(root, path);
    write(root, path, generated.replace('"GET /a",', '"GET /a",\n      "GET /typed-by-hand",'));
    const handEdited = run(root, true);
    expect(handEdited.status).toBe(1);
    expect(handEdited.stderr).toContain(path);
    write(root, path, generated);
    write(root, "src/providers/alpha/evidence/value-safety.json", '{ "format": 6 }\n');
    expect(run(root, true).stderr).toContain(path);
    expect(run(root).status).toBe(0);
    expect(json(root, path).generated.evidence).toEqual({ "value-safety.json": digestOf('{ "format": 6 }\n') });
    // So does a Conventions section whose declaration moved.
    const index = "src/providers/alpha/index.ts";
    write(root, index, read(root, index).replace("default: 25", "default: 50"));
    const moved = run(root, true);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("src/providers/alpha/skill.generated.ts");
  });

  it("keys a dual guide's API and hosted Conventions to its declared blocks, and lists served hosted names", () => {
    const root = repository();
    standardProvider(root, "alpha", {
      kind: "dual",
      definition: `blocks: { keys: ["api", "hosted"], select: () => ["api"] },
        classify: { tools: { list_items: "read", edit_item: "write" } },`,
      skill: "## Identity\n\n<!-- when: hosted -->\nSelect the workspace first.\n<!-- end -->\n",
      files: {
        "evidence/catalog.json": JSON.stringify({
          capturedAt: "2026-10-01",
          method: "tools/list",
          source: "https://vendor.example/mcp",
          tools: [{ name: "edit_item" }, { name: "list_items" }],
        }),
      },
    });
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(generatedSkill(root, "alpha").content.split("\n")).toEqual([
      "## Identity",
      "",
      "<!-- when: hosted -->",
      "Select the workspace first.",
      "<!-- end -->",
      "",
      "## Conventions",
      "",
      "<!-- when: api -->",
      expect.any(String),
      "<!-- end -->",
      expect.stringContaining("- **Writes:**"),
      "<!-- when: hosted -->",
      expect.stringContaining("- **Hosted tools:** the hosted catalog varies by plan and permission"),
      "<!-- end -->",
    ]);
    expect(json(root, "src/providers/alpha/drift.json").generated).toMatchObject({
      operations: [],
      hosted: ["edit_item", "list_items"],
      evidence: { "catalog.json": expect.stringMatching(/^sha256:/) },
    });
  });

  it.each([
    [
      "a fragment guide",
      { skill: "<!-- fragment: content -->\nText.\n<!-- endfragment -->\n" },
      "G2: SKILL.md uses retired fragment markers",
    ],
    [
      "an undeclared when-block key",
      { skill: "<!-- when: region -->\nUS only.\n<!-- end -->\n" },
      "G2: SKILL.md uses the when-block region, which blocks.keys omits",
    ],
    [
      "an inline when-block",
      { skill: "Text <!-- when: api -->inline<!-- end -->\n" },
      "G2: a when-block marker stands alone on its line",
    ],
    [
      "a written Conventions section",
      { skill: "## Conventions\n\nPage with cursors.\n" },
      "G3: the Conventions section",
    ],
    [
      "operator setup",
      { skill: "## Setup\n\nImport it from `@zackbart/connecta/providers/alpha`.\n" },
      "G4: SKILL.md carries operator setup",
    ],
    [
      "a dual guide without hosted and api keys",
      { kind: "dual" as const, definition: 'classify: { tools: { list_items: "read" } },' },
      "G2: a dual provider declares the hosted and api block keys",
    ],
    [
      "a manual check without lastVerified",
      { checks: [{ type: "manual", source: "https://vendor.example", reason: "Prose." }] },
      "D3: checks[0] manual check needs lastVerified",
    ],
    [
      "a hand-kept reviewed list",
      {
        checks: [{ type: "mcp-docs", setup: "https://vendor.example/mcp", endpoints: ["https://x"], reviewed: ["a"] }],
      },
      "D4: checks[0] hand-keeps a reviewed list",
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
    [
      "a ReadMe endpoint row without its page, which providers:check cannot read",
      {
        definition: KIT,
        checks: [
          {
            type: "endpoints",
            specification: { url: "https://docs.vendor.example/reference/", format: "readme-operation-pages" },
            endpoints: [{ operation: "GET /a", specRevision: "1", contract: `sha256:${"0".repeat(64)}` }],
          },
        ],
      },
      "D3: providers:check rejects checks[0]: GET /a names its reference page",
    ],
    [
      "reviewed access to a tool generated.hosted does not serve",
      {
        kind: "mcp" as const,
        definition: 'classify: { tools: { list_items: "read" } },',
        checks: [
          {
            type: "mcp-docs",
            setup: "https://vendor.example/mcp",
            endpoints: ["https://mcp.vendor.example/mcp"],
            reviewedAccess: { ghost: "read" },
          },
        ],
      },
      "D3: providers:check rejects checks[0]: reviewed access must name generated hosted tools",
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
    // Generation accepts the rows --record will complete; the suite does not accept them committed.
    expect(run(root).status).toBe(0);
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

describe("the generated Conventions", () => {
  const conventions = async () =>
    (await import(new URL("../scripts/provider-guide.mjs", import.meta.url).href)) as {
      renderConventions(input: object): string;
    };
  const labels = (text: string) => [...text.matchAll(/^- \*\*([A-Za-z ]+):\*\*/gm)].map((match) => match[1]);

  it("states the hosted conventions for mcp, and only the declared API ones for api", async () => {
    const { renderConventions } = await conventions();
    expect(labels(renderConventions({ name: "acme", kind: "mcp" }))).toEqual(["Writes", "Hosted tools"]);
    expect(labels(renderConventions({ name: "acme", kind: "api" }))).toEqual(["Results", "Writes"]);
    const kit = { operations: [], pageSize: { default: 10, max: 50 }, hatch: { name: "acme", verdicts: {} } };
    const full = renderConventions({ name: "acme", kind: "api", kit, withheld: true });
    expect(labels(full)).toEqual(["Paging", "Results", "Hatch", "Writes", "Withheld values"]);
    // A hatch with no write verdict offers no write tool and asks no approval.
    expect(full).not.toContain("acme_api_write");
    expect(full).toContain("An operation without a reviewed verdict is refused.");
  });

  it("refuses kit facts it cannot state truthfully", async () => {
    const { renderConventions } = await conventions();
    expect(() =>
      renderConventions({ name: "acme", kind: "api", kit: { operations: [], pageSize: { default: 50, max: 10 } } }),
    ).toThrow("kit.pageSize default exceeds its maximum");
    expect(() =>
      renderConventions({ name: "acme", kind: "api", kit: { operations: [], hatch: { name: "Acme", verdicts: {} } } }),
    ).toThrow("snake_case tool prefix");
    expect(() =>
      renderConventions({
        name: "acme",
        kind: "api",
        kit: { operations: [], hatch: { name: "acme", verdicts: { "GET /a": "maybe" } } },
      }),
    ).toThrow("read, write, destructive, or refuse");
    expect(() => renderConventions({ name: "acme", kind: "composed" })).toThrow("mcp, api, or dual");
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
    const { buildOperationIndex } = await generator();
    const data = buildOperationIndex(document, { ...source, options: { depth: 2, descriptions: 40 } });
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

  it("shrinks a large document on request: no restated ids, implied path parameters, and a per-operation budget", async () => {
    const { buildOperationIndex } = await generator();
    const options = { depth: 2, descriptions: 0, operationIds: false, pathParams: "typed", opBudget: 60 };
    const data = buildOperationIndex(document, { ...source, options });
    expect(data.ops.map((row: unknown[]) => row[2])).toEqual(["", "", "", ""]);
    const details = JSON.parse(data.details);
    // The plain-string path parameter is dropped; the template still names it.
    expect(details.o[2]).toEqual(0);
    // Past the budget, the create body falls back to a shallower depth.
    expect(JSON.stringify(details.o[1]).length).toBeLessThan(
      JSON.stringify(JSON.parse(buildOperationIndex(document, { ...source, options: { depth: 2 } }).details).o[1])
        .length,
    );
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(data, { vendor: "acme", title: "Acme" });
    const contract = index.contract(index.resolve("DELETE", "/v1/things/t_1").op);
    expect(contract.parameters).toEqual([{ name: "thing", in: "path", required: true, schema: { type: "string" } }]);
  });

  it("ships no value-safety candidates in the index; they live in the reviewed candidates file", async () => {
    const { buildOperationIndex } = await generator();
    const data = buildOperationIndex(document, { ...source, options: { valueSafety: true } });
    expect(Object.keys(data)).toEqual(["source", "revision", "digest", "version", "servers", "tags", "ops", "details"]);
  });

  it("round-trips through the runtime index: resolve, search, contract, and validation", async () => {
    const { buildOperationIndex } = await generator();
    const { OperationIndex } = await import("../src/providers/_shared/rest/operation-index.js");
    const index = new OperationIndex(buildOperationIndex(document, source), { vendor: "acme", title: "Acme" });
    expect(index.resolve("DELETE", "/v1/things/th_1")).toMatchObject({
      op: { path: "/v1/things/{thing}" },
      params: { thing: "th_1" },
    });
    expect(index.search("create thing", { limit: 5 }).map((op) => op.operationId)).toEqual(["PostThings"]);
    expect(index.contract(index.operation("POST", "/v1/things")!).body?.schema).toMatchObject({
      required: ["name"],
      properties: { shipping: { type: "object", properties: { city: { type: "string" } } } },
    });
    expect(() => index.check(index.operation("POST", "/v1/things")!, {}, { name: "x", shiping: {} })).toThrow(
      "/body/shiping (additionalProperties: shipping? one of",
    );
    expect(() => index.check(index.operation("POST", "/v1/things")!, {}, { deep: { inner: { anything: 1 } } })).toThrow(
      "/body/name (required: a value)",
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

  it("stamps the candidates file with the detector format, the pinned digest, and the detector options", async () => {
    const { renderValueSafety, VALUE_SAFETY_FORMAT } = await detection();
    const rendered = JSON.parse(
      renderValueSafety(
        { openapi: "3.0.0", paths: {} },
        { digest: "sha256:x", options: { valueSafety: { expansions: false } } },
      ).text,
    );
    expect(rendered).toEqual({
      format: VALUE_SAFETY_FORMAT,
      digest: "sha256:x",
      options: { expansions: false },
      candidates: {},
    });
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
  const safetyScript = async () =>
    (await import(new URL("../scripts/value-safety.mjs", import.meta.url).href)) as {
      reviewedTable(directory: string): Promise<{ table: unknown; absent: Record<string, unknown> } | undefined>;
    };
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
  });

  it("refuses a folder that pins OpenAPI under both names, and keeps legacy names until step 1", async () => {
    const { openApiEvidence } = await spec();
    const pin = JSON.stringify({
      url: "https://vendor.example/openapi.json",
      revision: "r1",
      digest: `sha256:${"0".repeat(64)}`,
    });
    const both = folder({ "evidence/openapi.json": pin, "openapi.source.json": pin });
    await expect(openApiEvidence(both.directory)).rejects.toThrow("pins OpenAPI twice");
    const legacy = folder({ "openapi.source.json": pin });
    expect(await openApiEvidence(legacy.directory)).toEqual({
      pin: "openapi.source.json",
      candidates: "value-safety.candidates.json",
    });
  });

  it("reads the reviewed table and its absent paths from safety.ts, legacy files until step 1, never both", async () => {
    const { reviewedTable } = await safetyScript();
    const standard = folder({ "safety.ts": table(true) });
    expect((await reviewedTable(standard.directory))?.absent).toEqual({
      operations: { "GET /v1/keys": ["legacy_secret"] },
      resources: {},
      reason: "A shared verdict path.",
    });
    writeFileSync(join(standard.directory, "value-safety.absent.json"), "{}");
    await expect(reviewedTable(standard.directory)).rejects.toThrow("remove value-safety.*");
    const legacy = folder({
      "value-safety.ts": table(false),
      "value-safety.absent.json": JSON.stringify({
        reason: "Shared.",
        operations: { "GET /v1/keys": ["legacy_secret"] },
      }),
    });
    expect((await reviewedTable(legacy.directory))?.absent).toMatchObject({
      operations: { "GET /v1/keys": ["legacy_secret"] },
      resources: {},
    });
    expect(await reviewedTable(folder({}).directory)).toBeUndefined();
  });
});
