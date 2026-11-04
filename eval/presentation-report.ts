/**
 * `pnpm run eval:presentation` runs or reports the catalog presentation plan.
 *
 *   --run                 execute the plan, one batch at a time
 *   --dir                 result directory (default eval/results/presentation)
 *   --runner              claude or codex (with --run)
 *   --pair-id             the batch window every file shares (with --run)
 *   --experiments         comma-separated subset of the plan
 *   --max-load            wait before a batch while the 1-minute load is above this (default 30)
 *   --budget              refuse to plan past this many trials across --dir (default 150)
 *
 * The run spends only what is missing: it counts valid trials per arm and task,
 * so an interrupted batch resumes without repeating a paid trial.
 *
 * The report refuses files that fail the comparator's measured provenance or
 * that differ in anything but the arm, task set and repeat count. It reaches no
 * decision: it prints how many trials separate each arm from its control.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TrialResult } from "./agent/run.js";
import { trialOutcome } from "./agent/verdict.js";
import { measuredProvenance, settingMismatches } from "./compare.js";
import {
  PRESENTATION_PLAN,
  plannedBatches,
  type ExperimentId,
  type PresentationExperiment,
} from "./presentation-plan.js";
import { mean, median, trialEfficiency } from "./report/efficiency.js";
import type { AgentResultFile } from "./report/summary.js";
import { flags, ROOT } from "./support/meta.js";
import { PRESENTATION_TARGETS } from "./tasks/presentation.js";

const utf8 = new TextEncoder();
const size = (value: unknown) => utf8.encode(typeof value === "string" ? value : (JSON.stringify(value) ?? "")).length;

interface SearchPage {
  scoped: boolean;
  rows: number;
  distinct: number;
}

export interface PresentationMetrics {
  /** Addresses whose first attempt failed `invalid_args`, by route. */
  firstAttemptInvalidArgs: number;
  addressesCalled: number;
  errorsBeforeFirstSuccess: number;
  /** Search and describe bytes the deployment served, on either route. */
  discoveryBytes: number;
  responseBytes: number;
  totalTokens: number;
  firstRequestTokens: number | undefined;
  searchPages: SearchPage[];
  wrongCalls: number;
  wrongWrites: number;
}

function page(args: unknown, value: unknown): SearchPage | undefined {
  const tools = (value as { tools?: { name?: string; description?: string }[] } | undefined)?.tools;
  if (!Array.isArray(tools)) return undefined;
  return {
    scoped: typeof (args as { connector?: unknown } | undefined)?.connector === "string",
    rows: tools.length,
    // Same-named padding tools on different connectors differ in their description.
    distinct: new Set(tools.map((tool) => `${tool.name}\0${tool.description}`)).size,
  };
}

const parsed = (text: string | undefined) => {
  try {
    return JSON.parse(text ?? "") as unknown;
  } catch {
    return undefined;
  }
};

/** Everything here is derived from fields a saved trial already holds. */
export function presentationMetrics(trial: TrialResult): PresentationMetrics {
  const uses = trial.saved?.trace.toolUses ?? [];
  const programs = trial.saved?.world.programs ?? [];
  const firstAttempt = new Map<string, boolean>();
  const attempt = (address: unknown, invalid: boolean) => {
    if (typeof address === "string" && !firstAttempt.has(address)) firstAttempt.set(address, invalid);
  };
  const searchPages: SearchPage[] = [];
  let discoveryBytes = 0;
  for (const use of uses) {
    if (use.tool === "call_tool" || use.tool === "call_destructive_tool")
      attempt(use.input.address, use.isError === true && /"?invalid_args"?/.test(use.resultText ?? ""));
    if (use.tool === "search_tools") {
      discoveryBytes += size(use.resultText ?? "");
      const row = page(use.input, parsed(use.resultText));
      if (row) searchPages.push(row);
    }
  }
  for (const program of programs)
    for (const call of program.calls) {
      if (call.name === "connecta.call") {
        const first = call.args[0];
        const address = typeof first === "string" ? first : (first as { address?: unknown } | undefined)?.address;
        attempt(address, call.outcome === "error" && call.errorCode === "invalid_args");
      }
      if (call.name === "connecta.search" || call.name === "connecta.describe") discoveryBytes += size(call.result);
      if (call.name === "connecta.search") {
        const row = page(call.args[0], call.result);
        if (row) searchPages.push(row);
      }
    }
  const target = PRESENTATION_TARGETS[trial.task];
  const wrong = (trial.saved?.world.calls ?? []).filter(
    (call) => target?.wrong.includes(call.service) && !target.neutral.includes(call.tool),
  );
  const efficiency = trialEfficiency(trial);
  const tokens = trial.metrics.tokens;
  return {
    firstAttemptInvalidArgs: [...firstAttempt.values()].filter(Boolean).length,
    addressesCalled: firstAttempt.size,
    errorsBeforeFirstSuccess: trial.metrics.toolErrorsBeforeFirstSuccess ?? 0,
    discoveryBytes,
    responseBytes: efficiency.responseBytes ?? 0,
    totalTokens: tokens.input + tokens.cacheRead + tokens.cacheCreation + tokens.output,
    firstRequestTokens: trial.metrics.firstTurnInputTokens,
    searchPages,
    wrongCalls: wrong.length,
    wrongWrites: wrong.filter((call) => call.kind === "write").length,
  };
}

const numbers = (values: (number | undefined)[]) => values.filter((v): v is number => typeof v === "number");
const round = (value: number | undefined, digits = 0) => (value === undefined ? "n/a" : value.toFixed(digits));

export interface ArmSummary {
  arm: string;
  ran: number;
  passed: number;
  invalid: number;
  timeouts: number;
  firstAttemptInvalidArgs: number;
  addressesCalled: number;
  errorsBeforeFirstSuccess: number | undefined;
  discoveryBytes: number | undefined;
  responseBytes: number | undefined;
  totalTokens: number | undefined;
  firstRequestTokens: number | undefined;
  wrongCalls: number;
  wrongWrites: number;
  unscopedRows: number | undefined;
  unscopedDistinct: number | undefined;
  unscopedPages: number;
  scopedPages: number;
}

/**
 * Infrastructure errors and timeouts are invalid, never failures of the arm:
 * they leave the rates and are reported. Medians are over every valid trial, so
 * a cheap failure cannot flatter an arm silently; pass counts sit beside them.
 */
export function summarizeArm(arm: string, runner: "claude" | "codex", trials: TrialResult[]): ArmSummary {
  const valid = trials.filter((trial) => !trialOutcome(trial, runner).infrastructure);
  const metrics = valid.map(presentationMetrics);
  const pages = metrics.flatMap((m) => m.searchPages);
  const unscoped = pages.filter((p) => !p.scoped);
  const sum = (pick: (m: PresentationMetrics) => number) => metrics.reduce((n, m) => n + pick(m), 0);
  return {
    arm,
    ran: valid.length,
    passed: valid.filter((trial) => trialOutcome(trial, runner).pass).length,
    invalid: trials.length - valid.length,
    timeouts: trials.filter((trial) => (runner === "claude" ? trial.claude?.timedOut : trial.codex?.timedOut)).length,
    firstAttemptInvalidArgs: sum((m) => m.firstAttemptInvalidArgs),
    addressesCalled: sum((m) => m.addressesCalled),
    errorsBeforeFirstSuccess: mean(metrics.map((m) => m.errorsBeforeFirstSuccess)),
    discoveryBytes: median(metrics.map((m) => m.discoveryBytes)),
    responseBytes: median(metrics.map((m) => m.responseBytes)),
    totalTokens: median(metrics.map((m) => m.totalTokens)),
    firstRequestTokens: median(numbers(metrics.map((m) => m.firstRequestTokens))),
    wrongCalls: sum((m) => m.wrongCalls),
    wrongWrites: sum((m) => m.wrongWrites),
    unscopedRows: mean(unscoped.map((p) => p.rows)),
    unscopedDistinct: mean(unscoped.map((p) => p.distinct)),
    unscopedPages: unscoped.length,
    scopedPages: pages.length - unscoped.length,
  };
}

function table(summaries: ArmSummary[]): string[] {
  const control = summaries[0]!;
  const lines = [
    "| Arm | Pass (valid) | Invalid | Δpass vs control | 1st-attempt invalid_args / addresses | Errors before 1st success (mean) | Discovery bytes (median) | Response bytes (median) | Total tokens (median) | 1st-request tokens (median) | Wrong-target calls (writes) | Unscoped rows/distinct per page (pages) | Scoped pages |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const s of summaries) {
    const delta = s.passed - control.passed;
    lines.push(
      `| ${s.arm} | ${s.passed}/${s.ran} | ${s.invalid}${s.timeouts ? ` (${s.timeouts} timeout)` : ""} | ${s === control ? "–" : `${delta >= 0 ? "+" : ""}${delta} trial(s)`} | ${s.firstAttemptInvalidArgs}/${s.addressesCalled} | ${round(s.errorsBeforeFirstSuccess, 2)} | ${round(s.discoveryBytes)} | ${round(s.responseBytes)} | ${round(s.totalTokens)} | ${round(s.firstRequestTokens)} | ${s.wrongCalls} (${s.wrongWrites}) | ${round(s.unscopedRows, 1)}/${round(s.unscopedDistinct, 1)} (${s.unscopedPages}) | ${s.scopedPages} |`,
    );
  }
  return lines;
}

const armOf = (file: AgentResultFile) => file.config.presentation ?? "control";

/**
 * Every file must be a fresh measured batch; files may differ only in arm, task
 * set and repeat count. An early stop leaves its finished trials valid: the
 * report counts each cell against the plan, so a missing trial still shows.
 */
export function presentationProvenance(files: AgentResultFile[]): string[] {
  const reasons: string[] = [];
  for (const file of files) {
    const label = `${armOf(file)}/${file.config.runner}/${file.config.tasks[0]}`;
    reasons.push(...measuredProvenance(label, "six", file));
    if (file.config.target !== PRESENTATION_PLAN.target) reasons.push(`${label}: must run on the worker target`);
    if (file.config.injection?.catalogTools !== PRESENTATION_PLAN.catalogTools)
      reasons.push(`${label}: must pad the catalog with ${PRESENTATION_PLAN.catalogTools} tools`);
  }
  for (const runner of new Set(files.map((file) => file.config.runner))) {
    const same = files.filter((file) => file.config.runner === runner);
    for (const other of same.slice(1))
      // A top-up file holds only the trials an interrupted batch lacked.
      for (const label of settingMismatches(same[0]!, other, ["presentation", "tasks", "repeats"]))
        reasons.push(`${runner}: arms must share ${label}`);
  }
  return [...new Set(reasons)];
}

export function presentationReport(files: AgentResultFile[], options: { allowMismatch?: boolean } = {}): string {
  const reasons = presentationProvenance(files);
  if (reasons.length && !options.allowMismatch)
    throw new Error(`Presentation report refused:\n${reasons.map((r) => `- ${r}`).join("\n")}`);
  const lines = reasons.length ? ["NON-COMPARABLE diagnostics:", ...reasons.map((r) => `- ${r}`), ""] : [];
  const experiments = PRESENTATION_PLAN.experiments as Record<ExperimentId, PresentationExperiment>;
  for (const id of Object.keys(experiments) as ExperimentId[]) {
    const experiment = experiments[id];
    const arms = [experiment.control, ...experiment.treatments];
    lines.push(`## ${id}: ${experiment.question}`, "");
    for (const runner of ["claude", "codex"] as const) {
      const summaries = arms.flatMap((arm) => {
        const trials = files
          .filter((file) => file.config.runner === runner && armOf(file) === arm)
          .flatMap((file) => file.trials)
          .filter((trial) => experiment.tasks.includes(trial.task));
        return trials.length ? [summarizeArm(arm, runner, trials)] : [];
      });
      if (!summaries.length || summaries[0]!.arm !== experiment.control) continue;
      const expected = experiment.tasks.length * PRESENTATION_PLAN.repeats;
      const short = summaries.filter((s) => s.ran + s.invalid !== expected);
      lines.push(`### ${PRESENTATION_PLAN.models[runner]}`, "", ...table(summaries), "");
      if (short.length)
        lines.push(`Incomplete: ${short.map((s) => `${s.arm} ${s.ran + s.invalid}/${expected}`).join(", ")}.`, "");
      for (const task of experiment.tasks) {
        const cells = arms.map((arm) => {
          const trials = files
            .filter((file) => file.config.runner === runner && armOf(file) === arm)
            .flatMap((file) => file.trials)
            .filter((trial) => trial.task === task);
          return `${arm} ${trials.filter((trial) => trialOutcome(trial, runner).pass).length}/${trials.length}`;
        });
        lines.push(`- ${task}: ${cells.join(", ")}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function readPresentationFiles(dir: string): AgentResultFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as AgentResultFile);
}

const ACCOUNT_LIMIT = /auth|rate.?limit|usage limit|quota/i;
const MAX_ATTEMPTS = 3;

async function runPlan(args: Map<string, string>, dir: string): Promise<void> {
  const runner = args.get("runner");
  const pairId = args.get("pair-id");
  if (runner !== "claude" && runner !== "codex") throw new Error("--run needs --runner claude or codex");
  if (!pairId) throw new Error("--run needs --pair-id");
  const maxLoad = Number(args.get("max-load") ?? 30);
  const budget = Number(args.get("budget") ?? 150);
  const only = args.get("experiments")?.split(",") as ExperimentId[] | undefined;
  await mkdir(dir, { recursive: true });
  const validTrials = (arm: string, task: string) =>
    readPresentationFiles(dir)
      .filter((file) => file.config.runner === runner && armOf(file) === arm)
      .flatMap((file) => file.trials)
      .filter((trial) => trial.task === task && !trialOutcome(trial, runner).infrastructure).length;
  for (const batch of plannedBatches(runner === "codex", only)) {
    for (let attempt = 0; ; attempt++) {
      const missing = batch.tasks
        .map((task) => ({ task, count: PRESENTATION_PLAN.repeats - validTrials(batch.arm, task) }))
        .filter(({ count }) => count > 0);
      if (!missing.length) break;
      if (attempt === MAX_ATTEMPTS) throw new Error(`Batch ${batch.id} still lacks trials`);
      for (const count of new Set(missing.map((entry) => entry.count))) {
        const tasks = missing.filter((entry) => entry.count === count).map((entry) => entry.task);
        for (let load = loadavg()[0]!; load > maxLoad; load = loadavg()[0]!) {
          console.error(`[presentation] 1-minute load ${load.toFixed(1)} > ${maxLoad}; waiting`);
          await delay(120_000);
        }
        const spent = readPresentationFiles(dir).reduce((n, file) => n + file.trials.length, 0);
        if (spent + tasks.length * count > budget)
          throw new Error(`${spent} trials on disk plus ${tasks.length * count} would pass the budget of ${budget}`);
        let out = join(dir, `${batch.id}-${runner}.json`);
        for (let part = 1; existsSync(out); part++) out = join(dir, `${batch.id}-${runner}-part${part}.json`);
        console.error(`[presentation] load ${loadavg()[0]!.toFixed(1)}: ${batch.id} ${tasks.join(",")} x${count}`);
        await new Promise<void>((resolved, reject) => {
          const child = spawn(
            "pnpm",
            [
              "run",
              "eval:agent",
              "--runner",
              runner,
              "--models",
              PRESENTATION_PLAN.models[runner],
              "--target",
              PRESENTATION_PLAN.target,
              "--no-build",
              "--surface",
              PRESENTATION_PLAN.surface,
              "--grading",
              PRESENTATION_PLAN.grading,
              "--catalog-tools",
              String(PRESENTATION_PLAN.catalogTools),
              "--presentation",
              batch.arm,
              "--tasks",
              tasks.join(","),
              "--repeats",
              String(count),
              "--concurrency",
              String(PRESENTATION_PLAN.concurrency),
              "--pair-id",
              pairId,
              "--out",
              out,
            ],
            { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] },
          );
          child.once("error", reject);
          // A failed trial is data, and eval:agent exits nonzero for it.
          child.once("exit", () => resolved());
        });
        const { stopped, trials } = JSON.parse(readFileSync(out, "utf8")) as AgentResultFile;
        console.error(`[presentation] ${out}: ${trials.length} trial(s)${stopped ? ", stopped early" : ""}`);
        if (stopped && ACCOUNT_LIMIT.test(String(stopped).slice(0, 300)))
          throw new Error(`Stopped on an account limit: ${String(stopped).slice(0, 300)}`);
        if (stopped) await delay(60_000);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, "eval/presentation-report.ts")) {
  const args = flags(process.argv.slice(2));
  const dir = resolve(args.get("dir") ?? join(ROOT, "eval", "results", "presentation"));
  if (args.has("run")) await runPlan(args, dir);
  else console.log(presentationReport(readPresentationFiles(dir), { allowMismatch: args.has("allow-mismatch") }));
}
