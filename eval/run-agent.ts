/**
 * `npm run eval:agent -- [options]` — agent task evals with headless Claude Code.
 *
 *   --models   sonnet,opus,haiku or full ids (default: all three)
 *   --repeats  trials per task × model (default 3)
 *   --tasks    comma-separated task ids (default: every active task)
 *   --concurrency  parallel trials (default 3)
 *   --timeout-min  per-trial wall budget in minutes (default 8)
 *   --max-budget-usd  per-trial spend cap passed to Claude Code (default none)
 *   --effort   Claude Code effort level (default: the model's own default)
 *   --mcp-output-tokens  Claude Code's per-result cap, MAX_MCP_OUTPUT_TOKENS
 *                        (default: the host's own; baselines use the default)
 *   --max-utilization  stop scheduling when a rate-limit window reaches this
 *                      fraction (default 0.97), so a run never exhausts the quota
 *   --out      result JSON path (default eval/results/agent-<time>.json)
 *   --report   also write an HTML report to this path
 *   --baseline a result file to compare against in that report
 *
 * Needs a logged-in `claude` on PATH and network access; never part of
 * `npm run check`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { claudeVersion } from "./agent/claude.js";
import { runBatch } from "./agent/run.js";
import { renderReport } from "./report/html.js";
import { summarize, type AgentResultFile, type ResultFile } from "./report/summary.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";
import { ACTIVE_TASKS, PLANNED } from "./tasks/index.js";

const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-4-5-20251001",
};

const args = flags(process.argv.slice(2));
const models = (args.get("models") ?? "sonnet,opus,haiku")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean)
  .map((model) => MODEL_ALIASES[model] ?? model);
const repeats = Number(args.get("repeats") ?? 3);
const concurrency = Number(args.get("concurrency") ?? 3);
const timeoutMs = Number(args.get("timeout-min") ?? 8) * 60_000;
const maxUtilization = Number(args.get("max-utilization") ?? 0.97);
const maxBudgetUsd = args.has("max-budget-usd") ? Number(args.get("max-budget-usd")) : undefined;
const effort = args.get("effort");
const mcpOutputTokens = args.has("mcp-output-tokens") ? Number(args.get("mcp-output-tokens")) : undefined;
const wanted = args.get("tasks")?.split(",").map((id) => id.trim());
const tasks = wanted ? ACTIVE_TASKS.filter((task) => wanted.includes(task.id)) : ACTIVE_TASKS;
if (wanted && tasks.length !== wanted.length) {
  const known = ACTIVE_TASKS.map((task) => task.id).join(", ");
  throw new Error(`Unknown task in --tasks. Active tasks: ${known}`);
}
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");

const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `agent-${stamp()}.json`));
const version = await claudeVersion();
console.error(
  `[eval] ${tasks.length} task(s) × ${models.length} model(s) × ${repeats} repeat(s), concurrency ${concurrency}, ${version}`,
);
const meta = runMeta();
const { trials, stopped } = await runBatch(tasks, models, repeats, {
  concurrency,
  timeoutMs,
  maxUtilization,
  ...(maxBudgetUsd ? { maxBudgetUsd } : {}),
  ...(effort ? { effort } : {}),
  ...(mcpOutputTokens ? { mcpOutputTokens } : {}),
  onTrial: (trial, done, total) => {
    const failed = trial.checks.filter((item) => !item.pass && !item.advisory).map((item) => item.id);
    console.error(
      `[eval] ${done}/${total} ${trial.status.toUpperCase().padEnd(5)} ${trial.task} ${trial.model} #${trial.repeat} ` +
        `${(trial.metrics.wallMs / 1000).toFixed(0)}s $${(trial.metrics.costUsd ?? 0).toFixed(3)}` +
        `${failed.length ? ` failed: ${failed.join(",")}` : ""}${trial.error ? ` error: ${trial.error}` : ""}`,
    );
  },
});
const file: AgentResultFile = {
  kind: "connecta-eval/agent",
  version: 1,
  meta,
  claudeVersion: version,
  config: {
    models,
    repeats,
    tasks: tasks.map((task) => task.id),
    concurrency,
    timeoutMs,
    ...(effort ? { effort } : {}),
    mcpOutputTokens: mcpOutputTokens ?? "host default",
  },
  tasks: tasks.map(({ id, title, measures, introducedIn }) => ({ id, title, measures, introducedIn })),
  planned: PLANNED,
  trials,
  ...(stopped ? { stopped } : {}),
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(file, null, 1)}\n`);
console.error(`[eval] results: ${out}`);
if (stopped) console.error(`[eval] stopped early: ${stopped}`);
for (const cell of summarize(trials)) {
  console.error(
    `[eval] ${cell.task.padEnd(28)} ${cell.model.padEnd(28)} ${cell.passed}/${cell.trials - cell.errored} pass` +
      `${cell.errored ? ` (${cell.errored} error)` : ""}`,
  );
}
const reportPath = args.get("report");
if (reportPath) {
  const baselinePath = args.get("baseline");
  const baseline = baselinePath
    ? [JSON.parse(await readFile(resolve(baselinePath), "utf8")) as ResultFile]
    : [];
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), renderReport({ current: [file], baseline }));
  console.error(`[eval] report: ${resolve(reportPath)}`);
}
