#!/usr/bin/env node
// What each public entry costs a Worker to load, and a cap on how much more.
//
// Every Web-facing export is bundled the way a Workers deployment's bundler
// would see it — esbuild, ESM, platform "neutral", the workerd/worker/import
// conditions, minified — straight from src/, so the number is the code a
// deployment ships rather than what tsc happened to emit. The Worker example
// is bundled too, as the composite a real deployment loads. The Node-only
// entries (/node, /quickjs) are reported for information and never capped.
//
// The report is a markdown table on stdout (and appended to
// $GITHUB_STEP_SUMMARY when set), with the minified bytes each entry spends on
// effect, zod, the MCP SDK, @cfworker, and connecta's own src/. It fails when a
// neutral bundle is left with an unresolved `node:` import, which would not
// load on Workers, or when an entry's gzip size passes its `maxGzip` in
// scripts/bundle-budget.json. Budgets move deliberately, in the change that
// explains why, never to make this pass.
//
// Optional peers (@clerk/backend, @cloudflare/codemode, quickjs-emscripten)
// stay external: a deployment installs and pays for them by choice, and
// measuring them would bill connecta for a dependency it does not ship.

import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const budget = JSON.parse(
  readFileSync(join(root, "scripts", "bundle-budget.json"), "utf8"),
).entries;

const NODE_ENTRIES = new Set(["./node", "./quickjs"]);
const OPTIONAL_PEERS = Object.keys(manifest.peerDependencies ?? {});
const WORKER_EXAMPLE = "examples/worker";

/** `./dist/x.js` in the exports map → `src/x.ts`. */
function sourceFor(subpath) {
  const target = manifest.exports?.[subpath];
  const file = typeof target === "string" ? target : target?.import;
  if (typeof file !== "string" || !file.startsWith("./dist/")) {
    throw new Error(`exports[${subpath}] has no ./dist/ import target`);
  }
  return join(root, "src", file.slice("./dist/".length).replace(/\.js$/, ".ts"));
}

/** Resolve the package's own name to src/, as the example's tsconfig does. */
const selfToSource = {
  name: "connecta-self",
  setup(context) {
    context.onResolve({ filter: /^@zackbart\/connecta(\/.*)?$/ }, (args) => {
      const subpath = `.${args.path.slice("@zackbart/connecta".length)}`;
      return { path: sourceFor(subpath) };
    });
  },
};

function categoryOf(input) {
  const path = input.split(sep).join("/");
  const inModules = path.lastIndexOf("node_modules/");
  if (inModules >= 0) {
    const name = path.slice(inModules + "node_modules/".length);
    if (name.startsWith("effect/")) return "effect";
    if (name.startsWith("zod/")) return "zod";
    if (name.startsWith("@modelcontextprotocol/")) return "mcp";
    if (name.startsWith("@cfworker/")) return "cfworker";
    return "other";
  }
  if (path.startsWith("src/")) return "src";
  return "other";
}

const CATEGORIES = ["effect", "zod", "mcp", "cfworker", "src", "other"];

async function measure({ name, entry, platform, extraPlugins = [] }) {
  const neutral = platform === "neutral";
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform,
    ...(neutral
      ? {
          conditions: ["workerd", "worker", "browser", "import"],
          mainFields: ["module", "main"],
        }
      : {}),
    minify: true,
    metafile: true,
    write: false,
    outfile: "out.js",
    logLevel: "silent",
    external: [...OPTIONAL_PEERS, "cloudflare:*", ...(neutral ? ["node:*"] : [])],
    plugins: extraPlugins,
  });
  const output = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const bytes = output.contents;
  const meta = Object.values(result.metafile.outputs).find(
    (candidate) => candidate.entryPoint !== undefined,
  );
  const attributed = Object.fromEntries(CATEGORIES.map((key) => [key, 0]));
  for (const [input, { bytesInOutput }] of Object.entries(meta.inputs)) {
    attributed[categoryOf(input)] += bytesInOutput;
  }
  const nodeImports = neutral
    ? meta.imports
        .filter((item) => item.external && item.path.startsWith("node:"))
        .map((item) => item.path)
    : [];
  return {
    name,
    platform,
    raw: bytes.byteLength,
    gzip: gzipSync(bytes, { level: 9 }).byteLength,
    attributed,
    nodeImports: [...new Set(nodeImports)].sort(),
  };
}

const targets = [];
for (const subpath of Object.keys(manifest.exports ?? {})) {
  if (subpath === "./package.json") continue;
  targets.push({
    name: subpath === "." ? "." : subpath,
    entry: sourceFor(subpath),
    platform: NODE_ENTRIES.has(subpath) ? "node" : "neutral",
  });
}
targets.push({
  name: WORKER_EXAMPLE,
  entry: join(root, WORKER_EXAMPLE, "src", "index.ts"),
  platform: "neutral",
  extraPlugins: [selfToSource],
});

const results = [];
for (const target of targets) results.push(await measure(target));

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;
const exact = (bytes) => `${bytes.toLocaleString("en-US")} B`;
const signed = (bytes) =>
  `${bytes >= 0 ? "+" : "−"}${Math.abs(bytes).toLocaleString("en-US")} B`;

const failures = [];
const rows = results.map((result) => {
  const limits = budget[result.name];
  let delta = "—";
  let cap = "info";
  if (result.platform === "neutral") {
    if (!limits) {
      failures.push(`${result.name}: no entry in scripts/bundle-budget.json`);
      cap = "missing";
    } else {
      delta = signed(result.gzip - limits.baselineGzip);
      cap = exact(limits.maxGzip);
      if (result.gzip > limits.maxGzip) {
        failures.push(
          `${result.name}: ${result.gzip} B gzip exceeds its ${limits.maxGzip} B cap`,
        );
      }
    }
    for (const path of result.nodeImports) {
      failures.push(`${result.name}: unresolved ${path} import in a Workers bundle`);
    }
  }
  return [
    `\`${result.name}\``,
    kb(result.raw),
    exact(result.gzip),
    delta,
    cap,
    ...CATEGORIES.map((key) => kb(result.attributed[key])),
  ];
});
for (const name of Object.keys(budget)) {
  if (!results.some((result) => result.name === name)) {
    failures.push(`${name}: budgeted in scripts/bundle-budget.json but not an entry`);
  }
}

const header = [
  "entry",
  "raw",
  "gzip",
  "Δ gzip",
  "cap",
  ...CATEGORIES.map((key) => `${key} (raw)`),
];
const table = [
  `| ${header.join(" | ")} |`,
  `|${header.map((_, index) => (index === 0 ? "---" : "---:")).join("|")}|`,
  ...rows.map((row) => `| ${row.join(" | ")} |`),
].join("\n");
const report =
  "### Bundle size\n\n" +
  table +
  "\n\nΔ is against `baselineGzip` in scripts/bundle-budget.json; `info` rows " +
  "are Node-only and uncapped. Attribution is minified bytes before gzip.\n";

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
if (failures.length) {
  console.error(
    `bundle-size: ${failures.length} failure(s):\n` +
      failures.map((failure) => `  ${failure}`).join("\n"),
  );
  process.exit(1);
}
