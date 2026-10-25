// Exact-version offline compatibility proof. No production source is written.
// Node 22: node scripts/probes/effect-core-compatibility.mjs /absolute/report.json
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = join(root, "test/fixtures/effect-proof");
const requireWrangler = createRequire(import.meta.resolve("wrangler"));
const { Miniflare, Log, LogLevel } = requireWrangler("miniflare");
const external = ["@clerk/backend", "@cloudflare/codemode", "quickjs-emscripten", "cloudflare:*", "node:*"];

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Proof transform drift: ${before.slice(0, 70)}`);
  return source.replace(before, after);
}

/** Only the local compiled candidate changes; source checkout is untouched. */
export function candidateSource(source) {
  const start = source.indexOf("  const route = (context: RouteContext)");
  const end = source.indexOf("  const serve = (", start);
  if (start < 0 || end < 0) throw new Error("Proof route transform drift");
  source =
    source.slice(0, start) +
    "  const route = (context: RouteContext) => routeWithHttpRouter(context, routeMcp.handle, metadata, health);\n\n" +
    source.slice(end);
  return `import { routeWithHttpRouter } from ${JSON.stringify(join(fixture, "router.ts"))};\n` + source;
}

export function routerCandidate() {
  return {
    name: "proof-router-candidate",
    setup(bundle) {
      bundle.onLoad({ filter: /\/src\/server\.ts$/ }, async ({ path }) => {
        return { contents: candidateSource(await readFile(path, "utf8")), loader: "ts" };
      });
    },
  };
}

const edgeCounter = {
  name: "proof-edge-counter",
  setup(bundle) {
    bundle.onLoad({ filter: /\/src\/runtime\/run\.ts$/ }, async ({ path }) => ({
      loader: "ts",
      contents: replaceOnce(
        await readFile(path, "utf8"),
        "  const exit = await runExit(effect, options.signal ? { signal: options.signal } : undefined);",
        "  globalThis.__proofEdges = (globalThis.__proofEdges ?? 0) + 1;\n  const exit = await runExit(effect, options.signal ? { signal: options.signal } : undefined);",
      ),
    }));
  },
};

const baseBuild = {
  absWorkingDir: root,
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "browser", "import"],
  mainFields: ["module", "main"],
  external,
  write: false,
  metafile: true,
  logLevel: "silent",
};

function compare(before, after) {
  const differences = [];
  if (before.length !== after.length) differences.push({ length: [before.length, after.length] });
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i]))
      differences.push({ baseline: before[i], candidate: after[i] });
  }
  return { cases: before.length, equal: differences.length === 0, differences };
}

async function workerRequest(worker, path, body) {
  const response = await worker.dispatchFetch(
    "https://proof.test" + path,
    body === undefined ? undefined : { method: "POST", body: JSON.stringify(body) },
  );
  if (!response.ok) throw new Error(`Worker ${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
}

async function queueProof(worker) {
  const held = await worker.dispatchFetch("https://proof.test/mcp");
  let settled = false;
  const waiting = worker
    .dispatchFetch("https://proof.test/mcp", {
      method: "POST",
      headers: { "x-proof-waiter": "yes" },
      body: "waiter-owned",
    })
    .then(async (response) => {
      settled = true;
      return { status: response.status, body: await response.text() };
    });
  // A state observation gives the waiter a separate real request boundary.
  let state;
  for (let i = 0; i < 20; i++) {
    state = await workerRequest(worker, "/queue-state");
    if (state.waiterArrived) break;
  }
  const pending = !settled && state.secondReads === 0 && state.waiterArrived;
  await workerRequest(worker, "/queue-release");
  const first = await held.text();
  const result = await waiting;
  return { pending, first, result, state: await workerRequest(worker, "/queue-state") };
}

async function measure() {
  const entries = [
    ["root", join(root, "src/index.ts")],
    ["worker", join(root, "examples/worker/src/index.ts")],
  ];
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const self = {
    name: "proof-self",
    setup(bundle) {
      bundle.onResolve({ filter: /^@zackbart\/connecta(?:\/.*)?$/ }, ({ path }) => {
        const target = manifest.exports["." + path.slice("@zackbart/connecta".length)].import;
        return { path: join(root, "src", target.slice("./dist/".length).replace(/\.js$/, ".ts")) };
      });
    },
  };
  const rows = [];
  for (const [name, entry] of entries)
    for (const candidate of [false, true]) {
      const result = await build({
        ...baseBuild,
        entryPoints: [entry],
        minify: true,
        plugins: [self, ...(candidate ? [routerCandidate()] : [])],
      });
      rows.push({
        name,
        candidate,
        raw: result.outputFiles[0].contents.length,
        gzip: gzipSync(result.outputFiles[0].contents, { level: 9 }).length,
        imports: Object.values(result.metafile.outputs).flatMap((o) =>
          o.imports.filter((i) => i.external).map((i) => i.path),
        ),
        effectCopies: [
          ...new Set(
            Object.keys(result.metafile.inputs)
              .filter((p) => p.includes("node_modules/effect/"))
              .map((p) => p.split("node_modules/effect/")[0]),
          ),
        ],
        effectAreas: [
          ...new Set(
            Object.values(result.metafile.outputs).flatMap((o) =>
              Object.entries(o.inputs)
                .filter(([p, v]) => v.bytesInOutput > 0 && p.includes("node_modules/effect/"))
                .map(([p]) => p.split("node_modules/effect/")[1].split("/")[1]),
            ),
          ),
        ].sort(),
      });
    }
  // Incremental adoption cost, retaining the SDK and existing deployed entry.
  // Deliberately not a replacement estimate or an approval to change caps.
  for (const [name, entry] of entries) {
    const result = await build({
      ...baseBuild,
      stdin: {
        contents: `export ${name === "worker" ? "{ default }" : "*"} from ${JSON.stringify(entry)}; export { effectMcp } from ${JSON.stringify(join(fixture, "observations.ts"))};`,
        resolveDir: root,
      },
      minify: true,
      plugins: [self],
    });
    rows.push({
      name,
      candidate: "effect-mcp-incremental",
      raw: result.outputFiles[0].contents.length,
      gzip: gzipSync(result.outputFiles[0].contents, { level: 9 }).length,
      imports: Object.values(result.metafile.outputs).flatMap((o) =>
        o.imports.filter((i) => i.external).map((i) => i.path),
      ),
    });
  }
  return rows;
}

export async function runProof() {
  const effect = JSON.parse(await readFile(join(root, "node_modules/effect/package.json"))).version;
  const sdk = JSON.parse(await readFile(join(root, "node_modules/@modelcontextprotocol/server/package.json"))).version;
  if (effect !== "4.0.5" || sdk !== "2.3.1")
    throw new Error(`Proof requires Effect4.0.5/SDK2.3.1, got ${effect}/${sdk}`);
  const work = await mkdtemp(join(tmpdir(), "connecta-effect-proof-"));
  const workers = [];
  try {
    const node = [];
    let importEdges = 0;
    const logs = [];
    const savedConsole = { ...console };
    try {
      for (const level of ["log", "warn", "error", "info", "debug"])
        console[level] = (...args) => logs.push({ level, args: args.map(String) });
      for (const candidate of [false, true]) {
        const bundle = await build({
          ...baseBuild,
          entryPoints: [join(fixture, "observations.ts")],
          plugins: [...(candidate ? [routerCandidate()] : []), edgeCounter],
        });
        const path = join(work, candidate ? "candidate.mjs" : "baseline.mjs");
        await writeFile(path, bundle.outputFiles[0].contents);
        globalThis.__proofEdges = 0;
        const api = await import(pathToFileURL(path).href);
        importEdges += globalThis.__proofEdges;
        const routes = await api.runRoutes();
        const routeEdges = globalThis.__proofEdges;
        const agents = await api.runAgentNamespaces();
        node.push({ routes, routeEdges, agents, lifetimes: await api.runLifetimes(), api });
      }
      const tools = JSON.parse(node[0].routes.find((r) => r.label === "modern /mcp list").response.body).result.tools;
      node[1].mcp = await node[1].api.runMcp(tools);
      node[1].seam = await node[1].api.runRouterSeam();
    } finally {
      for (const level of ["log", "warn", "error", "info", "debug"]) console[level] = savedConsole[level];
    }
    const tools = JSON.parse(node[0].routes.find((r) => r.label === "modern /mcp list").response.body).result.tools;
    const native = [];
    for (const candidate of [false, true]) {
      const bundle = await build({
        ...baseBuild,
        entryPoints: [join(fixture, "worker.ts")],
        plugins: candidate ? [routerCandidate()] : [],
      });
      const worker = new Miniflare({
        modules: true,
        script: bundle.outputFiles[0].text,
        compatibilityDate: "2025-01-01",
        compatibilityFlags: [
          "nodejs_compat",
          "enable_request_signal",
          "enable_weak_ref",
          "unhandled_rejection_after_microtask_checkpoint",
        ],
        log: new Log(LogLevel.NONE),
        outboundService: (request) => new Response("native:" + new URL(request.url).pathname),
      });
      workers.push(worker);
      native.push({
        routes: await workerRequest(worker, "/proof/routes"),
        agents: await workerRequest(worker, "/proof/agents"),
        seam: await workerRequest(worker, "/proof/seam"),
        mcp: await workerRequest(worker, "/proof/mcp", tools),
        queue: await queueProof(worker),
        lifetimes: await workerRequest(worker, "/proof/lifetimes"),
      });
    }
    return {
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      baseline: "a471a2a6",
      node: process.version,
      zlib: process.versions.zlib,
      effect,
      sdk,
      router: {
        node: compare(node[0].routes, node[1].routes),
        workers: compare(native[0].routes, native[1].routes),
        nodeAgents: compare(node[0].agents, node[1].agents),
        workersAgents: compare(native[0].agents, native[1].agents),
        runners: { importEdges, baseline: node[0].routeEdges, candidate: node[1].routeEdges },
        seam: { node: node[1].seam, workers: native[1].seam },
        queue: native.map((n) => n.queue),
        logs,
        lifetimes: { node: node.map((n) => n.lifetimes), workers: native.map((n) => n.lifetimes) },
        oracle: node[0].routes.filter((r) =>
          /origin-first|upgrade |auth-before|unread|close|OPTIONS \/ui\/(credentials|oauth)/.test(r.label),
        ),
      },
      mcp: {
        tools,
        oracle: node[0].routes.filter((r) =>
          /list$|modern (server\/discover|resources|prompts|tasks|subscriptions|unknown)|mismatch|modern tool/.test(
            r.label,
          ),
        ),
        node: node[1].mcp,
        workers: native[1].mcp,
      },
      sizes: await measure(),
    };
  } finally {
    for (const worker of workers) await worker.dispose();
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runProof();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (process.argv[2]) {
    await writeFile(resolve(process.argv[2]), serialized);
    console.log(`Saved proof to ${resolve(process.argv[2])}`);
  } else console.log(serialized);
}
