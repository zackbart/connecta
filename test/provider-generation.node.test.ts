// Node-only: executes the generator against temporary provider folders.
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
          "./providers/retired": { baselineGzip: 10, maxGzip: 13 },
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

function provider(root: string, name: string, node = false) {
  const folder = `src/providers/${name}`;
  mkdirSync(join(root, folder));
  write(
    root,
    `${folder}/index.ts`,
    `import { skill } from "./skill.generated.js";
export const factory = Object.assign((id: string, options: object) => ({ id, kind: "api", options, staticTools: [{ name: "list_items" }] }), {
  definition: { name: ${JSON.stringify(name)}, title: ${JSON.stringify(name.toUpperCase())}, readme: ${JSON.stringify(`Vendor ${name}`)}, kind: "api", skill,
    bundle: { baselineGzip: 17, maxGzip: 23, note: ${JSON.stringify(`./providers/${name} reviewed cap`)} } }
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
    expect(budgets.entries["./providers/beta"]).toEqual({ baselineGzip: 17, maxGzip: 23 });
    expect(budgets.entries["."]).toEqual({ baselineGzip: 50, maxGzip: 101 });
    expect(budgets.entries["./worker"]).toEqual({ baselineGzip: 30, maxGzip: 75 });
    expect(budgets.notes).toEqual([
      "Root note",
      "Worker note",
      "./providers/alpha reviewed cap",
      "./providers/beta reviewed cap",
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
});
