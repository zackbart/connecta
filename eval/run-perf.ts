/**
 * `pnpm run eval:perf [--runs 1] [--samples 5] [--update-baseline] [--out path]`
 * measures the built package: the root bundle a Worker ships, and the request
 * matrix in eval/perf/matrix.ts. Each cell runs in its own process. Its
 * deterministic counts are checked against eval/baselines/perf.json; latency
 * is printed and written to the results file only. No LLM, no network.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { assertBuiltPackage } from "./perf/built.js";
import { baselineDifferences, baselineOf, formatBaseline } from "./perf/compare.js";
import { CELLS, OPERATIONS, type Cell, type CellResult } from "./perf/matrix.js";
import type { PerfResultFile } from "./report/summary.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";

const BASELINE = join(ROOT, "eval", "baselines", "perf.json");
const CELL_SCRIPT = join(ROOT, "eval", "perf", "cell.ts");
const CELL_TIMEOUT_MS = 180_000;
const RESULT_MARKER = "PERF_RESULT ";

const args = flags(process.argv.slice(2));
const runs = Number(args.get("runs") ?? 1);
const samples = Number(args.get("samples") ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

async function bundleSize(): Promise<PerfResultFile["bundle"]> {
  const entry = "dist/index.js";
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
      ? path
          .split("/")
          .slice(0, path.split("/")[1]!.startsWith("@") ? 3 : 2)
          .join("/")
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

function runCell(cell: Cell): Promise<CellResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, CELL_SCRIPT, JSON.stringify(cell), String(samples)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), CELL_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`cell ${cell.id} exited ${signal ?? code}`));
        return;
      }
      const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_MARKER));
      if (!line) {
        reject(new Error(`cell ${cell.id} exited 0 without a ${RESULT_MARKER.trim()} line`));
        return;
      }
      try {
        resolvePromise(JSON.parse(line.slice(RESULT_MARKER.length)) as CellResult);
      } catch (error) {
        reject(new Error(`cell ${cell.id} wrote a truncated or invalid result: ${String(error)}`));
      }
    });
  });
}

async function main() {
  assertBuiltPackage();
  const started = performance.now();
  const bundle = await bundleSize();
  console.log(
    `[perf] root bundle ${(bundle.minifiedBytes / 1024).toFixed(1)} KB min, ${(bundle.gzipBytes / 1024).toFixed(1)} KB gzip`,
  );
  const results = new Map<string, CellResult[]>();
  for (let run = 1; run <= runs; run++) {
    for (const cell of CELLS) {
      const cellStarted = performance.now();
      const result = await runCell(cell);
      results.set(cell.id, [...(results.get(cell.id) ?? []), result]);
      console.log(
        `[perf] run ${run}/${runs} ${cell.id.padEnd(24)} ${((performance.now() - cellStarted) / 1000).toFixed(1)}s`,
      );
    }
  }

  const runBaseline = (run: number) =>
    baselineOf(CELLS.map((cell) => ({ cell, counts: results.get(cell.id)![run]!.counts })));
  const current = runBaseline(0);
  const failures: string[] = [];
  for (let run = 1; run < runs; run++) {
    failures.push(
      ...baselineDifferences(current, runBaseline(run)).map(
        (difference) => `nondeterministic: run ${run + 1} vs run 1: ${difference}`,
      ),
    );
  }

  console.log(
    "\nwarm counts: storage round trips/statements (traced trips), downstream requests/listings, response bytes; p50",
  );
  for (const cell of CELLS) {
    const result = results.get(cell.id)![0]!;
    for (const operation of OPERATIONS) {
      const warm = result.counts[operation].warm;
      const latency = result.latency.find((entry) => entry.operation === operation)!;
      console.log(
        `  ${cell.id.padEnd(24)} ${operation.padEnd(13)} storage ${String(warm.storageRoundTrips).padStart(4)}/${String(warm.storageStatements).padEnd(4)} (${String(warm.tracedRoundTrips).padStart(3)}) downstream ${String(warm.downstreamRequests).padStart(3)}/${String(warm.downstreamListings).padEnd(3)} bytes ${String(warm.responseBytes).padStart(7)}  p50 ${latency.p50Ms.toFixed(1)}ms`,
      );
    }
  }

  let baseline: unknown;
  try {
    baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const file: PerfResultFile = {
    kind: "connecta-eval/perf",
    version: 2,
    meta: runMeta(),
    bundle,
    runs,
    cells: CELLS.map((cell) => ({ cell, ...results.get(cell.id)![0]! })),
  };
  const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `perf-${stamp()}.json`));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(file, null, 1)}\n`);
  console.log(`[perf] results: ${out}`);

  if (args.has("update-baseline")) {
    if (failures.length) {
      for (const failure of failures) console.log(`FAIL ${failure}`);
      throw new Error("Refusing to write a baseline while counts differ between runs.");
    }
    await writeFile(BASELINE, formatBaseline(current));
    console.log(`Wrote ${BASELINE}`);
  } else if (baseline === undefined) {
    failures.push(`no baseline at ${BASELINE}; run with --update-baseline`);
  } else {
    failures.push(
      ...baselineDifferences(baseline, current).map((difference) => `differs from baseline: ${difference}`),
    );
    if (failures.length)
      console.log(
        "\nA change that moves a count reruns `pnpm run eval:perf --update-baseline` in the same PR and explains the change.",
      );
  }
  console.log(`[perf] ${CELLS.length} cells x ${runs} run(s) in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log("perf counts: pass");
}

await main();
