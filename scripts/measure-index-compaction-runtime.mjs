// Prepare self-contained before/after runtime probes, then run them using an
// official offline Node image. No repository dependencies are needed to --run.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, directory, ref] = process.argv.slice(2);
const here = fileURLToPath(import.meta.url);
if (mode === "--sample") {
  globalThis.gc?.();
  const heap = process.memoryUsage().heapUsed;
  let start = performance.now();
  const module = await import(pathToFileURL(directory).href);
  const importMs = performance.now() - start;
  start = performance.now();
  module.createAuthored();
  const factoryMs = performance.now() - start;
  start = performance.now();
  const index = module.createIndex();
  const constructionMs = performance.now() - start;
  const ops = ref === "reverse" ? [...index.ops].reverse() : index.ops;
  const op = ops.find((op) => op.method === "POST") ?? ops[0];
  start = performance.now();
  index.contract(op);
  const firstDetailsMs = performance.now() - start;
  start = performance.now();
  index.contract(op);
  const repeatedDetailsMs = performance.now() - start;
  start = performance.now();
  for (const operation of ops) index.contract(operation);
  const allDetailsMs = performance.now() - start;
  globalThis.gc?.();
  console.log(
    JSON.stringify({
      importMs,
      factoryMs,
      constructionMs,
      firstDetailsMs,
      repeatedDetailsMs,
      allDetailsMs,
      heapDeltaBytes: process.memoryUsage().heapUsed - heap,
    }),
  );
} else if (mode === "--prepare") {
  const root = resolve(dirname(here), "..");
  const { discoverProviders } = await import("./providers.mjs");
  const { build } = await import("esbuild");
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const probes = [];
  mkdirSync(directory, { recursive: true });
  for (const provider of await discoverProviders()) {
    for (const phase of ["before", "after"]) {
      const base = join(provider.directory, "openapi.generated.ts");
      const isKit = ["overflow", "tithely"].includes(provider.name);
      const contents =
        `export {createAuthored} from ${JSON.stringify(provider.fixtures)};\n` +
        (isKit
          ? `import {${provider.name.toUpperCase()}_INDEX as index} from ${JSON.stringify(join(provider.directory, "api.ts"))}; export const createIndex=()=>index;`
          : `import {openapi} from ${JSON.stringify(base)}; import {OperationIndex} from ${JSON.stringify(join(root, "src/providers/_shared/rest/operation-index.ts"))}; export const createIndex=()=>new OperationIndex(openapi,{vendor:"crm",title:"CRM",pathMatching:"uri-template"});`);
      const plugins =
        phase === "before"
          ? [
              {
                name: "fixed-input",
                setup(b) {
                  b.onLoad({ filter: /\/src\/.+\.ts$/ }, ({ path }) => ({
                    contents: execFileSync("git", ["show", `${ref}:${path.slice(root.length + 1)}`], {
                      cwd: root,
                      encoding: "utf8",
                      maxBuffer: 32 * 1024 * 1024,
                    }),
                    loader: "ts",
                    resolveDir: dirname(path),
                  }));
                },
              },
            ]
          : [];
      const result = await build({
        stdin: { contents, loader: "js", resolveDir: root },
        bundle: true,
        format: "esm",
        platform: "neutral",
        conditions: ["workerd", "worker", "browser", "import"],
        mainFields: ["module", "main"],
        minify: true,
        write: false,
        logLevel: "silent",
        external: [...Object.keys(manifest.peerDependencies), "cloudflare:*", "node:*"],
        plugins,
      });
      const file = `${provider.name}-${phase}.mjs`;
      writeFileSync(join(directory, file), result.outputFiles[0].contents);
      probes.push({ provider: provider.name, phase, file });
    }
  }
  writeFileSync(join(directory, "runtime-manifest.json"), JSON.stringify({ ref, probes }, null, 2) + "\n");
  writeFileSync(join(directory, "runtime.mjs"), readFileSync(here));
} else if (mode === "--run") {
  const { probes, ref: baseline } = JSON.parse(readFileSync(join(directory, "runtime-manifest.json"), "utf8"));
  const samples = [];
  for (let round = 0; round < 7; round++) {
    for (const probe of round % 2 ? [...probes].reverse() : probes) {
      const sample = JSON.parse(
        execFileSync(
          process.execPath,
          ["--expose-gc", here, "--sample", join(directory, probe.file), round % 2 ? "reverse" : "forward"],
          { encoding: "utf8", timeout: 120_000 },
        ),
      );
      samples.push({ ...probe, round, ...sample });
    }
    console.error(`completed round ${round + 1}/7`);
  }
  console.log(JSON.stringify({ node: process.version, zlib: process.versions.zlib, baseline, samples }, null, 2));
} else throw new Error("Use --prepare <artifact-dir> <baseline-ref>, or --run <artifact-dir>");
