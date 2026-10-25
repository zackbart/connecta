// Fixed-input diagnostics. Run with Node 22: pnpm exec tsx scripts/measure-index-compaction.mjs <artifact-directory>.
// Bundle bytes are retained for gzip in the official, offline node:22-slim image.
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { discoverProviders, repositoryRoot as root } from "./providers.mjs";
import { sha256 } from "./generate-openapi.mjs";
import { OperationIndex } from "../src/providers/_shared/rest/operation-index.ts";

const output = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const providers = await discoverProviders();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const external = [...Object.keys(manifest.peerDependencies), "cloudflare:*", "node:*"];
const report = {
  head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  node: process.version,
  esbuild: (await import("esbuild")).version,
  providers: [],
  bundles: [],
};
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const provider of providers) {
  const generated = join(provider.directory, "openapi.generated.ts");
  let data;
  try {
    await access(generated);
    data = (await import(pathToFileURL(generated).href)).openapi;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { createAuthored } = await import(pathToFileURL(provider.fixtures).href);
  const factory = [];
  const construction = [],
    first = [],
    repeat = [],
    all = [],
    heap = [];
  // Alternating operation traversal controls cache/order effects; timing thresholds never gate CI.
  for (let round = 0; round < 9; round++) {
    let start = performance.now();
    createAuthored();
    factory.push(performance.now() - start);
    if (!data) continue;
    const before = process.memoryUsage().heapUsed;
    start = performance.now();
    const index = new OperationIndex(data, {
      vendor: provider.name,
      title: provider.name,
      pathMatching: "uri-template",
    });
    construction.push(performance.now() - start);
    const ops = round % 2 ? [...index.ops].reverse() : index.ops;
    const op = ops.find((op) => op.method === "POST") ?? ops[0];
    start = performance.now();
    index.contract(op);
    first.push(performance.now() - start);
    start = performance.now();
    index.contract(op);
    repeat.push(performance.now() - start);
    start = performance.now();
    for (const operation of ops) index.contract(operation);
    all.push(performance.now() - start);
    heap.push(process.memoryUsage().heapUsed - before);
  }
  const row = { provider: provider.name, factoryMs: median(factory), generated: Boolean(data) };
  if (data) {
    const logical = JSON.stringify(data);
    await writeFile(join(output, `${provider.name}.logical.json`), logical);
    const module = await readFile(generated);
    Object.assign(row, {
      operations: data.ops.length,
      logicalSha256: sha256(logical),
      generatedBytes: module.length,
      generatedSha256: sha256(module),
      constructionMs: median(construction),
      firstDetailsMs: median(first),
      repeatedDetailsMs: median(repeat),
      allDetailsMs: median(all),
      heapDeltaBytes: median(heap),
    });
  } else {
    const api = await import(pathToFileURL(join(provider.directory, "api.ts")).href);
    const index = api[`${provider.name.toUpperCase()}_INDEX`];
    const logical = JSON.stringify({
      ops: index.ops,
      contracts: index.ops.map((op) => index.contract(op)),
      fields: index.ops.map((op) => index.fields(op)),
      cursorRevision: await index.cursorRevision(),
    });
    await writeFile(join(output, `${provider.name}.logical.json`), logical);
    Object.assign(row, { operations: index.ops.length, logicalSha256: sha256(logical), generatedBytes: 0 });
  }
  report.providers.push(row);
  console.error(provider.name);
}
const sourceFor = (name) =>
  join(root, manifest.exports[name].import.replace("./dist/", "src/").replace(/\.js$/, ".ts"));
const targets = [
  ...providers.map((p) => ({ name: p.name, entry: p.index })),
  ...[".", "./ui"].map((name) => ({ name: name === "." ? "root" : "ui", entry: sourceFor(name) })),
  { name: "worker", entry: join(root, "examples/worker/src/index.ts") },
];
for (const target of targets) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [target.entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser", "import"],
    mainFields: ["module", "main"],
    minify: true,
    write: false,
    outfile: "out.js",
    logLevel: "silent",
    external,
    plugins: [
      {
        name: "self",
        setup(b) {
          b.onResolve({ filter: /^@zackbart\/connecta(\/.*)?$/ }, (args) => ({
            path: sourceFor(`.${args.path.slice("@zackbart/connecta".length)}`),
          }));
        },
      },
    ],
  });
  const bytes = result.outputFiles[0].contents;
  await writeFile(join(output, `${target.name}.bundle.js`), bytes);
  report.bundles.push({ name: target.name, bytes: bytes.length, sha256: sha256(bytes) });
}
await writeFile(join(output, "measurements.json"), JSON.stringify(report, null, 2) + "\n");
