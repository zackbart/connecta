// Preparation only. This script cannot deploy, mint live tokens, or call models.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const index = process.argv.indexOf("--output");
assert.ok(index >= 0 && process.argv[index + 1], "Supply --output outside the checkout");
const output = resolve(process.argv[index + 1]);
assert.ok(output !== root && !output.startsWith(`${root}/`), "Machine evidence belongs outside the checkout");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node 24+");
await mkdir(output); // Refuse to replace prior evidence or a linked deployment.
const helper = join(root, "packages/connecta-eve");
const core = JSON.parse(await readFile(join(root, "package.json")));
const manifest = JSON.parse(await readFile(join(helper, "package.json")));
assert.equal(core.version, manifest.version);
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8", timeout: 180_000 });
const sha = (value) => createHash("sha256").update(value).digest("hex");
await mkdir(join(output, "artifacts"));
const artifacts = {};
for (const cwd of [root, helper]) {
  const packed = JSON.parse(
    run("pnpm", ["pack", "--ignore-scripts", "--pack-destination", join(output, "artifacts"), "--json"], cwd),
  );
  artifacts[cwd === root ? core.name : manifest.name] = `artifacts/${packed.filename.split("/").at(-1)}`;
}
await cp(join(helper, "scripts/workload-fixture"), output, { recursive: true });
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "assistant-workload-proof",
      private: true,
      type: "module",
      engines: { node: "24.x" },
      packageManager: "pnpm@12.4.2",
      scripts: { check: "node local-check.mjs" },
      dependencies: {
        ...Object.fromEntries(Object.entries(artifacts).map(([key, file]) => [key, `file:${file}`])),
        eve: manifest.devDependencies.eve,
        "@vercel/oidc": "4.0.3",
        "@vercel/functions": "3.10.3",
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  join(output, "pnpm-workspace.yaml"),
  `minimumReleaseAgeExclude:\n  - eve@${manifest.devDependencies.eve}\noverrides:\n  "eve@${manifest.devDependencies.eve}>undici": 8.12.3\n  "@vercel/cli-config@0.3.3>zod": 4.6.6\n`,
);
await writeFile(join(output, ".gitignore"), "node_modules/\n.vercel/\nlocal-results.json\n");
await writeFile(join(output, ".vercelignore"), "local-check.mjs\nlocal-results.json\nprovenance.json\n");
await mkdir(join(output, "public"));
await writeFile(join(output, "public/.gitkeep"), "");
run("pnpm", ["install", "--ignore-scripts"], output);
run(process.execPath, ["local-check.mjs"], output);
const files = [
  "endpoint.mjs",
  "proof.mjs",
  "handler.mjs",
  "api/index.mjs",
  "local-check.mjs",
  "vercel.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".gitignore",
  ".vercelignore",
  "public/.gitkeep",
  "README.md",
  ...Object.values(artifacts),
];
const hashes = Object.fromEntries(
  await Promise.all(files.map(async (file) => [file, sha(await readFile(join(output, file)))])),
);
await writeFile(
  join(output, "provenance.json"),
  JSON.stringify(
    {
      source: run("git", ["rev-parse", "HEAD"], root).trim(),
      tree: run("git", ["rev-parse", "HEAD^{tree}"], root).trim(),
      dirty: run("git", ["status", "--porcelain"], root).trim(),
      preparationSha256: sha(await readFile(fileURLToPath(import.meta.url))),
      node: process.version,
      pnpm: run("pnpm", ["--version"], root).trim(),
      core: core.version,
      helper: manifest.version,
      eve: manifest.devDependencies.eve,
      oidc: "4.0.3",
      functions: "3.10.3",
      undiciOverride: "8.12.3",
      cliConfigZodOverride: "4.6.6",
      hashes,
      live: false,
      paidCalls: 0,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared installed-package workload fixture at ${output}; no live resources or tokens.`);
