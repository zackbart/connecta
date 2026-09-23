/**
 * `npm run eval:perf -- [--samples 40] [--out path]` — the two numbers P1 must
 * not regress without saying so: the size of the core a Worker ships, and how
 * long the common requests take on a running deployment.
 *
 * Bundle: esbuild bundles `src/index.ts` — the root entry, which is everything
 * a Worker imports before any subpath — the way wrangler would (neutral
 * platform, worker conditions, ESM, every dependency inlined), minified, then
 * gzip level 9. No LLM, no network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { startNodeDeployment } from "./deploy/node.js";
import { World } from "./fakes/world.js";
import type { PerfResultFile } from "./report/summary.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";

const args = flags(process.argv.slice(2));
const samples = Number(args.get("samples") ?? 40);
const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `perf-${stamp()}.json`));

async function bundleSize(): Promise<PerfResultFile["bundle"]> {
  const entry = "src/index.ts";
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    mainFields: ["browser", "module", "main"],
    external: ["node:*", "cloudflare:*"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const output = result.outputFiles[0]!.contents;
  const inputs = Object.values(result.metafile.outputs)[0]!.inputs;
  const grouped = new Map<string, number>();
  for (const [path, info] of Object.entries(inputs)) {
    const key = path.startsWith("node_modules/")
      ? path.split("/").slice(0, path.split("/")[1]!.startsWith("@") ? 3 : 2).join("/")
      : path;
    grouped.set(key, (grouped.get(key) ?? 0) + info.bytesInOutput);
  }
  return {
    entry,
    platform: "neutral (workerd, worker, browser conditions)",
    minifiedBytes: output.byteLength,
    gzipBytes: gzipSync(output, { level: 9 }).byteLength,
    topInputs: [...grouped]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([path, bytes]) => ({ path, bytes })),
  };
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

async function latency(): Promise<PerfResultFile["latency"]> {
  const world = new World();
  await world.start();
  const deployment = await startNodeDeployment(world.connectorSpecs());
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(deployment.mcpUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deployment.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    if (!response.ok || text.includes('"isError":true')) {
      throw new Error(`${method} failed: ${response.status} ${text.slice(0, 300)}`);
    }
  };
  const operations: [string, () => Promise<void>][] = [
    ["tools/list", () => rpc("tools/list", {})],
    ["search_tools (compact schemas)", () => rpc("tools/call", { name: "search_tools", arguments: { query: "search issues", includeSchemas: "compact" } })],
    ["call_tool (one read)", () => rpc("tools/call", { name: "call_tool", arguments: { address: "chat.list_channels", args: {} } })],
    [
      "execute_code (search + 2 reads + reduce)",
      () =>
        rpc("tools/call", {
          name: "execute_code",
          arguments: {
            code: `async () => {
  const found = await connecta.search("search issues", { connector: "tracker" });
  const open = await connecta.call("tracker.search_issues", { status: "open", label: "bug", limit: 50 });
  const accounts = await connecta.call("analytics.list_accounts", { limit: 25 });
  return { tools: found.tools.length, bugs: open.issues.length, accounts: accounts.accounts.length };
}`,
          },
        }),
    ],
  ];
  try {
    const results: PerfResultFile["latency"]["operations"] = [];
    for (const [name, run] of operations) {
      for (let warm = 0; warm < 3; warm += 1) await run();
      const times: number[] = [];
      for (let index = 0; index < samples; index += 1) {
        const started = performance.now();
        await run();
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      results.push({
        name,
        p50Ms: percentile(times, 0.5),
        p90Ms: percentile(times, 0.9),
        minMs: times[0]!,
        maxMs: times.at(-1)!,
      });
    }
    return { deployment: `${deployment.kind}, six loopback fake MCP servers`, samples, operations: results };
  } finally {
    await deployment.close();
    await world.stop();
  }
}

const file: PerfResultFile = {
  kind: "connecta-eval/perf",
  version: 1,
  meta: runMeta(),
  bundle: await bundleSize(),
  latency: await latency(),
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(file, null, 1)}\n`);
console.error(
  `[perf] core bundle ${(file.bundle.minifiedBytes / 1024).toFixed(1)} KB min, ${(file.bundle.gzipBytes / 1024).toFixed(1)} KB gzip`,
);
for (const op of file.latency.operations) {
  console.error(`[perf] ${op.name.padEnd(42)} p50 ${op.p50Ms.toFixed(1)}ms  p90 ${op.p90Ms.toFixed(1)}ms`);
}
console.error(`[perf] results: ${out}`);
