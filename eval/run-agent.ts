/**
 * `pnpm run eval:agent [options]` runs fake-only tasks through Codex or Claude Code.
 *
 *   --runner       codex (default) or claude
 *   --target       node (default) or worker: the deployment shape each trial
 *                  boots; worker runs workerd under wrangler dev
 *   --no-build     skip `pnpm run build` before a worker batch
 *   --latency-ms   delay every downstream fake response by this many ms
 *   --hung-connector          add connector `stalled`, which never answers
 *   --unauthorized-connector  add connector `revoked`, which answers 401
 *   --d1-latency-ms           delay each D1 round trip (worker target only)
 *   --models       comma-separated model ids; see eval/README.md for defaults
 *   --repeats      trials per task × model (default 1)
 *   --tasks        comma-separated task ids (default every active task)
 *   --concurrency  parallel trials (default 1)
 *   --timeout-min  per-trial wall budget in minutes (default 8)
 *   --effort       Codex reasoning effort (default model setting)
 *   --out          result JSON path (default eval/results/agent-<time>.json)
 *   --report       also write an HTML report
 *   --baseline     previous result file for that report
 *
 * Both runners use existing CLI sign-ins. Codex isolates its home; Claude
 * isolates settings and tools with CLI flags. Only the fake MCP endpoint loads. Completed trials are written
 * atomically as they finish. The exit status is nonzero unless every declared
 * trial ran once, completed normally and passed.
 */
import { parseSurface } from "./agent/surface.js";
import { parseTarget, workerRefusal } from "./deploy/targets.js";
import { describeInjection, parseInjection } from "./fakes/injection.js";
import { killAllProcesses } from "./support/workerd.js";
import { spawnSync } from "node:child_process";
import { parseGrading } from "./tasks/grading.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { claudeVersion, CLAUDE_MODELS } from "./agent/claude.js";
import { codexVersion } from "./agent/codex.js";
import { runBatch } from "./agent/run.js";
import { batchFailures } from "./agent/verdict.js";
import { renderReport } from "./report/html.js";
import { summarize, type AgentResultFile, type ResultFile } from "./report/summary.js";
import { batchEfficiency, efficiencyLines } from "./report/efficiency.js";
import { flags, ROOT, runMeta, runProtocol, stamp } from "./support/meta.js";
import { ACTIVE_TASKS, PLANNED } from "./tasks/index.js";

const args = flags(process.argv.slice(2));
const surface = parseSurface(args.get("surface"));
const grading = parseGrading(args.get("grading"));
const target = parseTarget(args.get("target"));
const injection = parseInjection(args);
if (injection.d1LatencyMs && target !== "worker") throw new Error("--d1-latency-ms needs --target worker");
const runner = args.get("runner") ?? "codex";
if (runner !== "codex" && runner !== "claude") throw new Error("--runner must be codex or claude");
if (
  (runner === "codex" && args.has("max-budget-usd")) ||
  args.has("mcp-output-tokens") ||
  args.has("max-utilization")
) {
  throw new Error(
    "Unsupported runner option; --max-budget-usd is Claude-only, and MCP output/utilization flags are retired",
  );
}
const models = (args.get("models") ?? (runner === "claude" ? CLAUDE_MODELS.join(",") : "gpt-6-luna"))
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const repeats = Number(args.get("repeats") ?? 1);
const concurrency = Number(args.get("concurrency") ?? 1);
const timeoutMs = Number(args.get("timeout-min") ?? 8) * 60_000;
const effort = args.get("effort");
if (runner === "claude" && effort) throw new Error("--effort is Codex-only");
const maxBudgetUsd = args.has("max-budget-usd") ? Number(args.get("max-budget-usd")) : undefined;
if (maxBudgetUsd !== undefined && (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0))
  throw new Error("--max-budget-usd must be positive");
const skipFlags = new Set((args.get("include-skipped") ?? "").split(",").filter(Boolean));
const eligible = ACTIVE_TASKS.filter((task) => !task.skip || skipFlags.has(task.skip.flag));
const skipped = ACTIVE_TASKS.filter((task) => task.skip && !skipFlags.has(task.skip.flag)).map((task) => ({
  id: task.id,
  ...task.skip!,
}));
const wanted = args
  .get("tasks")
  ?.split(",")
  .map((id) => id.trim());
const selected = wanted ? eligible.filter((task) => wanted.includes(task.id)) : eligible;
if (wanted && selected.length !== wanted.length) {
  throw new Error(
    `Unknown task in --tasks. Eligible tasks: ${eligible.map((task) => task.id).join(", ")}. Skipped tasks need --include-skipped <flag>`,
  );
}
// The worker target refuses what it cannot serve: named tasks fail the run,
// and a default batch records the refused tasks rather than running them.
const refused =
  target === "worker"
    ? selected.flatMap((task) => {
        const reason = workerRefusal(task, surface);
        return reason ? [{ id: task.id, reason }] : [];
      })
    : [];
if (wanted && refused.length)
  throw new Error(
    `The worker target refuses ${refused.length} task(s):\n${refused.map((r) => `- ${r.id}: ${r.reason}`).join("\n")}`,
  );
const tasks = selected.filter((task) => !refused.some((r) => r.id === task.id));
if (!tasks.length) throw new Error("No task to run");
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-min must be a finite positive number");
if (!models.length) throw new Error("--models must name at least one model");

const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `agent-${stamp()}.json`));
const version = await (runner === "claude" ? claudeVersion() : codexVersion());
if (version === "unavailable") throw new Error(`${runner} CLI is unavailable`);
const file: AgentResultFile = {
  kind: "connecta-eval/agent",
  version: 1,
  meta: runMeta(),
  protocol: runProtocol(args.get("pair-id")),
  [runner === "claude" ? "claudeVersion" : "codexVersion"]: version,
  config: {
    runner,
    target,
    // Always recorded, zeros included, so a comparison can prove it matched.
    injection,
    surface,
    grading,
    models,
    repeats,
    tasks: tasks.map((task) => task.id),
    concurrency,
    timeoutMs,
    ...(effort ? { effort } : {}),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
  },
  tasks: tasks.map(({ id, title, measures, introducedIn }) => ({ id, title, measures, introducedIn })),
  planned: PLANNED,
  skipped,
  ...(refused.length ? { refused } : {}),
  trials: [],
};
if (target === "worker" && !args.has("no-build")) {
  // The Worker imports the package by name, which resolves to dist/.
  console.error("[eval] pnpm run build");
  const built = spawnSync("pnpm", ["run", "build"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  if (built.status !== 0) throw new Error("pnpm run build failed");
}
for (const r of refused) console.error(`[eval] REFUSED on worker: ${r.id}: ${r.reason}`);
await mkdir(dirname(out), { recursive: true });
const save = async () => {
  const temporary = `${out}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 1)}\n`);
  await rename(temporary, out);
};
await save();
console.error(
  `[eval] ${tasks.length} task(s) × ${models.length} model(s) × ${repeats} repeat(s) on ${target}, ${describeInjection(injection)}, concurrency ${concurrency}, ${version}`,
);
const interrupted = new AbortController();
// The first signal stops the batch in order; a second kills workerd and exits.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (!interrupted.signal.aborted) return interrupted.abort();
    killAllProcesses();
    process.exit(130);
  });
let saving = Promise.resolve();
const { trials, stopped } = await runBatch(tasks, models, repeats, {
  runner,
  target,
  injection,
  surface,
  grading,
  concurrency,
  timeoutMs,
  signal: interrupted.signal,
  ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
  ...(effort ? { effort } : {}),
  onTrial: async (trial, done, total) => {
    file.trials.push(trial);
    saving = saving.then(save);
    await saving;
    const failed = trial.checks
      .filter((item) => !item.pass && !item.advisory && !(grading === "outcome" && item.kind === "route"))
      .map((item) => item.id);
    console.error(
      `[eval] ${done}/${total} ${trial.status.toUpperCase()} ${trial.task} ${trial.model} #${trial.repeat} ` +
        `${(trial.metrics.wallMs / 1000).toFixed(0)}s${failed.length ? ` failed: ${failed.join(",")}` : ""}` +
        `${trial.error ? ` error: ${trial.error}` : ""}`,
    );
  },
});
if (stopped) file.stopped = stopped;
await saving;
await save();
console.error(`[eval] results: ${out}`);
if (stopped) console.error(`[eval] stopped early: ${stopped}`);
for (const cell of summarize(trials)) {
  console.error(
    `[eval] ${cell.task.padEnd(28)} ${cell.model.padEnd(28)} ${cell.passed}/${cell.trials - cell.errored - cell.skipped} pass` +
      `${cell.errored ? ` (${cell.errored} error)` : ""}${cell.skipped ? ` (${cell.skipped} N/A)` : ""}`,
  );
}
{
  const efficiency = batchEfficiency(trials, repeats);
  for (const line of efficiencyLines(efficiency.models, efficiency.reliability)) console.error(`[eval] ${line}`);
}
const problems = batchFailures(file);
for (const problem of problems) console.error(`[eval] FAIL ${problem}`);
console.error(
  problems.length
    ? `[eval] batch FAILED: ${problems.length} problem(s); diagnostics in ${out}`
    : `[eval] batch passed: ${file.trials.length} trial(s)`,
);
if (problems.length) process.exitCode = 1;
const reportPath = args.get("report");
if (reportPath) {
  const baselinePath = args.get("baseline");
  const baseline = baselinePath ? [JSON.parse(await readFile(resolve(baselinePath), "utf8")) as ResultFile] : [];
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), renderReport({ current: [file], baseline }));
  console.error(`[eval] report: ${resolve(reportPath)}`);
}
