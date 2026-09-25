/**
 * `npm run eval:agent -- [options]` runs fake-only tasks through Codex.
 *
 *   --models       Codex model ids, comma-separated (default gpt-6-sol)
 *   --repeats      trials per task × model (default 3)
 *   --tasks        comma-separated task ids (default every active task)
 *   --concurrency  parallel trials (default 1)
 *   --timeout-min  per-trial wall budget in minutes (default 8)
 *   --effort       Codex reasoning effort (default model setting)
 *   --out          result JSON path (default eval/results/agent-<time>.json)
 *   --report       also write an HTML report
 *   --baseline     previous result file for that report
 *
 * Uses the existing Codex CLI sign-in. Each trial creates a separate Codex
 * home containing only its fake MCP endpoint. Completed trials are written
 * atomically as they finish.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { codexVersion } from "./agent/codex.js";
import { runBatch } from "./agent/run.js";
import { renderReport } from "./report/html.js";
import { summarize, type AgentResultFile, type ResultFile } from "./report/summary.js";
import { flags, ROOT, runMeta, stamp } from "./support/meta.js";
import { ACTIVE_TASKS, PLANNED } from "./tasks/index.js";

const args = flags(process.argv.slice(2));
if (args.has("max-budget-usd") || args.has("mcp-output-tokens") || args.has("max-utilization")) {
  throw new Error("Codex app-server does not support --max-budget-usd, --mcp-output-tokens, or --max-utilization");
}
const models = (args.get("models") ?? "gpt-6-sol")
  .split(",").map(model => model.trim()).filter(Boolean);
const repeats = Number(args.get("repeats") ?? 3);
const concurrency = Number(args.get("concurrency") ?? 1);
const timeoutMs = Number(args.get("timeout-min") ?? 8) * 60_000;
const effort = args.get("effort");
const wanted = args.get("tasks")?.split(",").map(id => id.trim());
const tasks = wanted ? ACTIVE_TASKS.filter(task => wanted.includes(task.id)) : ACTIVE_TASKS;
if (wanted && tasks.length !== wanted.length) {
  throw new Error(`Unknown task in --tasks. Active tasks: ${ACTIVE_TASKS.map(task => task.id).join(", ")}`);
}
if (!Number.isInteger(repeats) || repeats < 1) throw new Error("--repeats must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-min must be a finite positive number");
if (!models.length) throw new Error("--models must name at least one Codex model");

const out = resolve(args.get("out") ?? join(ROOT, "eval", "results", `agent-${stamp()}.json`));
const version = await codexVersion();
const file: AgentResultFile = {
  kind: "connecta-eval/agent", version: 1, meta: runMeta(), codexVersion: version,
  config: { runner: "codex", models, repeats, tasks: tasks.map(task => task.id),
    concurrency, timeoutMs, ...(effort ? { effort } : {}) },
  tasks: tasks.map(({ id, title, measures, introducedIn }) => ({ id, title, measures, introducedIn })),
  planned: PLANNED,
  trials: [],
};
await mkdir(dirname(out), { recursive: true });
const save = async () => {
  const temporary = `${out}.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 1)}\n`);
  await rename(temporary, out);
};
await save();
console.error(`[eval] ${tasks.length} task(s) × ${models.length} model(s) × ${repeats} repeat(s), concurrency ${concurrency}, ${version}`);
const interrupted = new AbortController();
process.once("SIGINT", () => interrupted.abort());
process.once("SIGTERM", () => interrupted.abort());
let saving = Promise.resolve();
const { trials, stopped } = await runBatch(tasks, models, repeats, {
  concurrency, timeoutMs, maxUtilization: 0.97, signal: interrupted.signal,
  ...(effort ? { effort } : {}),
  onTrial: async (trial, done, total) => {
    file.trials.push(trial);
    saving = saving.then(save);
    await saving;
    const failed = trial.checks.filter(item => !item.pass && !item.advisory).map(item => item.id);
    console.error(`[eval] ${done}/${total} ${trial.status.toUpperCase()} ${trial.task} ${trial.model} #${trial.repeat} ` +
      `${(trial.metrics.wallMs / 1000).toFixed(0)}s${failed.length ? ` failed: ${failed.join(",")}` : ""}` +
      `${trial.error ? ` error: ${trial.error}` : ""}`);
  },
});
if (stopped) file.stopped = stopped;
await saving;
await save();
console.error(`[eval] results: ${out}`);
if (stopped) console.error(`[eval] stopped early: ${stopped}`);
for (const cell of summarize(trials)) {
  console.error(`[eval] ${cell.task.padEnd(28)} ${cell.model.padEnd(28)} ${cell.passed}/${cell.trials - cell.errored} pass` +
    `${cell.errored ? ` (${cell.errored} error)` : ""}`);
}
const reportPath = args.get("report");
if (reportPath) {
  const baselinePath = args.get("baseline");
  const baseline = baselinePath
    ? [JSON.parse(await readFile(resolve(baselinePath), "utf8")) as ResultFile] : [];
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  await writeFile(resolve(reportPath), renderReport({ current: [file], baseline }));
  console.error(`[eval] report: ${resolve(reportPath)}`);
}
