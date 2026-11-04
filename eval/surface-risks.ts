/**
 * Run the fixed surface-risk batches, or summarize their saved results.
 *
 *   pnpm exec tsx eval/surface-risks.ts run [--only e1-deny,e3] [--parallel 2] [--max-load 30] [--out-dir dir]
 *   pnpm exec tsx eval/surface-risks.ts summary [--out-dir dir]
 *
 * `run` waits while the 1-minute load is over the limit, because load distorts
 * timeouts, and skips any batch whose result file already holds every trial.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import {
  batchTrials,
  MAX_PAID_TRIALS,
  MODELS,
  plannedTrials,
  SURFACE_BATCHES,
  type SurfaceBatch,
} from "./surface-risks-plan.js";
import { flags, ROOT } from "./support/meta.js";

const command = process.argv[2];
const args = flags(process.argv.slice(3));
const outDir = resolve(args.get("out-dir") ?? join(ROOT, "eval", "results", "surface-risks"));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface SavedTrial {
  task: string;
  repeat: number;
  status: string;
  error?: string;
  surface?: string;
  checks: { id: string; pass: boolean; advisory?: boolean; kind?: string }[];
  finalAnswer?: string;
  metrics: {
    approvalPrompts?: { total: number; denied: number; byTool: Record<string, number> };
    firstTurnInputTokens?: number;
    hostSearchCalls?: number;
    modelTurns?: number;
    wallMs: number;
    toolErrors: number;
    metaTools: Record<string, number>;
    tokens: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number };
    downstream?: { duplicateWrites?: number };
  };
  ledger: { kind: string; outcome: string }[];
}

function resultPath(batch: SurfaceBatch): string {
  return join(outDir, `${batch.id}.json`);
}

function savedTrials(batch: SurfaceBatch): SavedTrial[] {
  if (!existsSync(resultPath(batch))) return [];
  try {
    return (JSON.parse(readFileSync(resultPath(batch), "utf8")) as { trials: SavedTrial[] }).trials;
  } catch {
    return [];
  }
}

function argv(batch: SurfaceBatch): string[] {
  return [
    "run",
    "eval:agent",
    "--runner",
    batch.runner,
    "--models",
    MODELS[batch.runner],
    "--target",
    "worker",
    "--no-build",
    "--grading",
    "outcome",
    "--surface",
    batch.surface,
    "--catalog-tools",
    String(batch.catalogTools),
    "--tasks",
    batch.tasks.join(","),
    "--repeats",
    String(batch.repeats),
    "--concurrency",
    "2",
    "--timeout-min",
    "12",
    "--out",
    resultPath(batch),
    ...(batch.approval ? ["--approval", batch.approval] : []),
    ...(batch.noToolSearch ? ["--no-tool-search"] : []),
  ];
}

async function run() {
  const planned = plannedTrials();
  if (planned > MAX_PAID_TRIALS) throw new Error(`The plan has ${planned} trials, over ${MAX_PAID_TRIALS}`);
  const only = args.get("only")?.split(",");
  const maxLoad = Number(args.get("max-load") ?? 30);
  const parallel = Number(args.get("parallel") ?? 2);
  await mkdir(outDir, { recursive: true });
  const queue = SURFACE_BATCHES.filter(
    (batch) =>
      (!only || only.some((prefix) => batch.id.startsWith(prefix))) && savedTrials(batch).length < batchTrials(batch),
  );
  console.error(
    `[surface-risks] ${queue.length} batch(es), ${queue.reduce((n, b) => n + batchTrials(b), 0)} trial(s); plan total ${planned}`,
  );
  const worker = async () => {
    for (;;) {
      const batch = queue.shift();
      if (!batch) return;
      while (loadavg()[0]! > maxLoad) {
        console.error(`[surface-risks] load ${loadavg()[0]!.toFixed(0)} over ${maxLoad}; holding ${batch.id}`);
        await sleep(180_000);
      }
      console.error(`[surface-risks] start ${batch.id} at load ${loadavg()[0]!.toFixed(0)}`);
      const code = await new Promise<number | null>((done) => {
        const child = spawn("pnpm", argv(batch), { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
        child.stderr.on("data", (chunk) => {
          for (const line of String(chunk).split("\n"))
            if (/^\[eval\] \d+\/\d+ /.test(line)) console.error(`  ${batch.id} ${line.slice(7)}`);
        });
        child.on("close", done);
      });
      console.error(`[surface-risks] done ${batch.id} exit ${code} load ${loadavg()[0]!.toFixed(0)}`);
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
}

const median = (values: number[]): number | undefined => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : undefined;
};
const totalTokens = (trial: SavedTrial) =>
  (trial.metrics.tokens.input ?? 0) +
  (trial.metrics.tokens.cacheRead ?? 0) +
  (trial.metrics.tokens.cacheCreation ?? 0) +
  (trial.metrics.tokens.output ?? 0);
const invalid = (trial: SavedTrial) => trial.status === "error" || trial.status === "skipped";
const k = (value: number | undefined) => (value === undefined ? "n/a" : `${Math.round(value / 1000)}k`);

function line(trials: SavedTrial[]) {
  const valid = trials.filter((trial) => !invalid(trial));
  const passed = valid.filter((trial) => trial.status === "pass");
  const prompts = valid.map((trial) => trial.metrics.approvalPrompts?.total ?? 0);
  return [
    `pass ${passed.length}/${valid.length}`,
    `invalid ${trials.length - valid.length}`,
    `prompts/trial ${valid.length ? (prompts.reduce((a, b) => a + b, 0) / valid.length).toFixed(1) : "n/a"}`,
    `tokens ${k(median(valid.map(totalTokens)))}`,
    `first ${k(median(valid.map((t) => t.metrics.firstTurnInputTokens ?? Number.NaN)))}`,
    `turns ${median(valid.map((t) => t.metrics.modelTurns ?? Number.NaN)) ?? "n/a"}`,
    `dup ${valid.filter((t) => (t.metrics.downstream?.duplicateWrites ?? 0) > 0).length}`,
  ].join(" | ");
}

function summary() {
  const grouped = new Map<string, Map<string, SavedTrial[]>>();
  for (const batch of SURFACE_BATCHES) {
    const trials = savedTrials(batch);
    if (!trials.length) continue;
    const key = `${batch.experiment}${batch.experiment === "E5" ? ` catalog ${batch.catalogTools}` : ""} ${batch.runner}`;
    const arms = grouped.get(key) ?? new Map<string, SavedTrial[]>();
    arms.set(batch.surface, [...(arms.get(batch.surface) ?? []), ...trials]);
    grouped.set(key, arms);
  }
  for (const [key, arms] of grouped) {
    console.log(`\n## ${key}`);
    for (const [arm, trials] of arms) {
      console.log(`${arm.padEnd(13)} ${line(trials)}`);
      for (const task of new Set(trials.map((trial) => trial.task))) {
        const cell = trials.filter((trial) => trial.task === task);
        const failed = [
          ...new Set(
            cell.flatMap((trial) =>
              trial.status === "fail"
                ? trial.checks.filter((c) => !c.pass && !c.advisory && c.kind !== "route").map((c) => c.id)
                : invalid(trial)
                  ? [`INVALID:${(trial.error ?? trial.status).slice(0, 40)}`]
                  : [],
            ),
          ),
        ];
        const byTool: Record<string, number> = {};
        for (const trial of cell)
          for (const [tool, count] of Object.entries(trial.metrics.approvalPrompts?.byTool ?? {}))
            byTool[tool] = (byTool[tool] ?? 0) + count;
        console.log(
          `  ${task.padEnd(26)} ${cell.filter((t) => t.status === "pass").length}/${cell.filter((t) => !invalid(t)).length}` +
            ` prompts ${JSON.stringify(byTool)}` +
            ` writes ${cell.map((t) => t.ledger.filter((c) => c.kind === "write" && c.outcome === "ok").length).join(",")}` +
            (failed.length ? ` failed: ${failed.join(",")}` : ""),
        );
      }
    }
  }
  const expected = new Set(SURFACE_BATCHES.map((batch) => `${batch.id}.json`));
  const stray = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".json") && !expected.has(f)) : [];
  if (stray.length) console.log(`\nFiles outside the plan: ${stray.join(", ")}`);
  const done = SURFACE_BATCHES.reduce((n, batch) => n + savedTrials(batch).length, 0);
  console.log(`\nTrials saved: ${done} of ${plannedTrials()} planned`);
}

if (command === "run") await run();
else if (command === "summary") summary();
else throw new Error("Usage: surface-risks.ts run|summary");
