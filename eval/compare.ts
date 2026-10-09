/** Offline paired A/B report. Route-only verdicts never enter the decision rule. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { regradeTrial } from "./agent/regrade.js";
import type { TrialResult } from "./agent/run.js";
import type { AgentResultFile } from "./report/summary.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { downstreamMetrics } from "./agent/trace.js";
import { restoreGradeInputs } from "./agent/saved.js";
import { flags } from "./support/meta.js";

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const average = (values: (number | undefined)[]) => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? `${(sum(known) / known.length).toFixed(1)} (n=${known.length})` : "N/A";
};
const key = (t: TrialResult) => JSON.stringify([t.model, t.task, t.repeat]);

function validate(file: AgentResultFile, surface: "six" | "code"): Map<string, TrialResult> {
  if (file.kind !== "connecta-eval/agent" || file.version !== 1)
    throw new Error("Expected agent result file version 1");
  if ((file.config.surface ?? "six") !== surface) throw new Error(`Expected ${surface} input`);
  if (file.stopped) throw new Error(`Incomplete ${surface} batch: ${file.stopped}`);
  if (
    !Number.isInteger(file.config.repeats) ||
    file.config.repeats < 1 ||
    !file.config.models.length ||
    new Set(file.config.models).size !== file.config.models.length ||
    new Set(file.config.tasks).size !== file.config.tasks.length
  )
    throw new Error("Invalid batch dimensions");
  const trials = new Map<string, TrialResult>();
  for (const trial of file.trials) {
    if ((trial.surface ?? file.config.surface ?? "six") !== surface) throw new Error("Mixed surface arms in input");
    if (
      !file.config.models.includes(trial.model) ||
      !file.config.tasks.includes(trial.task) ||
      !Number.isInteger(trial.repeat) ||
      trial.repeat < 1 ||
      trial.repeat > file.config.repeats
    )
      throw new Error(`Trial outside declared batch ${key(trial)}`);
    if (trials.has(key(trial))) throw new Error(`Duplicate trial ${key(trial)}`);
    const task = ACTIVE_TASKS.find((t) => t.id === trial.task);
    if (!task) throw new Error(`No grader for ${trial.task}`);
    // Normal completed trials are validated by the regrader. Validate rows
    // that it deliberately skips too, because their state still feeds safety.
    const runner = file.config.runner ?? (file.claudeVersion ? "claude" : "codex");
    if (trial.saved && (trial.status === "error" || task.runnerSkips?.[runner])) restoreGradeInputs(trial.saved);
    const graded = regradeTrial(task, trial, runner, "outcome", surface);
    if (
      graded.status !== "error" &&
      graded.regrade?.unavailable.some((id) => graded.checks.find((c) => c.id === id)?.kind !== "route")
    )
      throw new Error(`Incomplete outcome evidence for ${key(trial)}`);
    trials.set(key(trial), graded);
  }
  for (const model of file.config.models)
    for (const task of file.config.tasks)
      for (let repeat = 1; repeat <= file.config.repeats; repeat++)
        if (!trials.has(JSON.stringify([model, task, repeat])))
          throw new Error(`Missing ${surface} trial ${model}/${task}/${repeat}`);
  if (!trials.size) throw new Error("No trials to compare");
  return trials;
}

function safety(trials: TrialResult[]) {
  const calls = (trial: TrialResult) =>
    trial.saved?.world.calls ??
    trial.ledger.map((call) => {
      if (call.kind !== "write") return { ...call, args: {} };
      try {
        return { ...call, args: JSON.parse(call.args) };
      } catch {
        throw new Error(`Incomplete write-safety evidence for ${key(trial)}`);
      }
    });
  return {
    duplicates: sum(trials.map((t) => downstreamMetrics(calls(t), []).duplicateWrites)),
    exports: trials.filter(
      (t) =>
        t.checks.some((c) => c.id === "export-once" && !c.pass) ||
        calls(t).filter((c) => c.service === "audit" && c.tool === "export_events").length > 1,
    ).length,
  };
}

export function compare(a: AgentResultFile, b: AgentResultFile): string {
  const six = validate(a, "six"),
    code = validate(b, "code");
  if (six.size !== code.size || [...six.keys()].some((k) => !code.has(k)))
    throw new Error("Arms must have identical model/task/repeat pairs");
  const runner = a.config.runner ?? (a.claudeVersion ? "claude" : "codex");
  if (runner !== (b.config.runner ?? (b.claudeVersion ? "claude" : "codex")))
    throw new Error("Arms must use the same runner");
  const versionA = runner === "claude" ? a.claudeVersion : a.codexVersion;
  const versionB = runner === "claude" ? b.claudeVersion : b.codexVersion;
  if (!versionA || versionA !== versionB) throw new Error("Arms must record the same CLI version");
  for (const field of ["effort", "timeoutMs", "concurrency", "maxBudgetUsd"] as const)
    if (a.config[field] !== b.config[field]) throw new Error(`Arms must use the same ${field}`);
  if ((a.config.mcpOutputTokens ?? "host default") !== (b.config.mcpOutputTokens ?? "host default"))
    throw new Error("Arms must use the same MCP output limit");
  const fullScope = ACTIVE_TASKS.every((t) => a.config.tasks.includes(t.id));
  const lines: string[] = [];
  for (const model of [...new Set([...six.values()].map((t) => t.model))].sort()) {
    const pairs = [...six.values()].filter((t) => t.model === model).map((t) => [t, code.get(key(t))!] as const);
    if (pairs.some(([x, y]) => (x.status === "skipped") !== (y.status === "skipped")))
      throw new Error(`N/A mismatch for ${model}`);
    const eligible = pairs.filter(([t]) => t.status !== "skipped");
    const left = eligible.map(([t]) => t),
      right = eligible.map(([, t]) => t);
    const passed = (ts: TrialResult[]) => ts.filter((t) => t.status === "pass").length;
    const rateA = left.length ? passed(left) / left.length : 0,
      rateB = right.length ? passed(right) / right.length : 0;
    lines.push(
      `${model}: outcome six ${passed(left)}/${left.length} (${(rateA * 100).toFixed(1)}%), code ${passed(right)}/${right.length} (${(rateB * 100).toFixed(1)}%); N/A ${pairs.length - eligible.length} per arm`,
    );
    const drops: string[] = [];
    for (const task of [...new Set(left.map((t) => t.task))].sort()) {
      const taskPairs = eligible.filter(([t]) => t.task === task);
      const pa = passed(taskPairs.map(([t]) => t)),
        pb = passed(taskPairs.map(([, t]) => t));
      const losses = taskPairs.filter(([x, y]) => x.status === "pass" && y.status !== "pass").length;
      const gains = taskPairs.filter(([x, y]) => x.status !== "pass" && y.status === "pass").length;
      lines.push(
        `  ${task}: six ${pa}/${taskPairs.length}, code ${pb}/${taskPairs.length}, delta ${pb - pa >= 0 ? "+" : ""}${pb - pa}; paired losses ${losses}, gains ${gains}`,
      );
      if (pa - pb >= 3) drops.push(`${task} (${pa - pb} of ${taskPairs.length})`);
    }
    lines.push(`  Tasks dropping by >=3 of N trials: ${drops.join(", ") || "none"}`);
    // N/A and infrastructure failures never erase observed safety violations.
    const sa = safety(pairs.map(([t]) => t)),
      sb = safety(pairs.map(([, t]) => t));
    lines.push(
      `  Duplicate writes: six ${sa.duplicates}, code ${sb.duplicates}; export-once violations: six ${sa.exports}, code ${sb.exports}`,
    );
    for (const [arm, ts] of [
      ["six", left],
      ["code", right],
    ] as const) {
      const firstErrors = ts.map((t) => {
        const first = t.saved?.trace.toolUses.find((u) => u.tool === "execute_code");
        return t.saved ? Number(first?.isError === true) : undefined;
      });
      lines.push(
        `  ${arm} mean/trial: model turns ${average(ts.map((t) => t.metrics.modelTurns))}; top-level calls ${average(ts.map((t) => sum([...Object.values(t.metrics.metaTools), ...Object.values(t.metrics.otherTools)])))}; input tokens ${average(ts.map((t) => t.metrics.tokens.input))}; output tokens ${average(ts.map((t) => t.metrics.tokens.output))}; wall ms ${average(ts.map((t) => t.metrics.wallMs))}; first-attempt program errors ${sum(firstErrors.filter((v): v is number => v !== undefined))}/${firstErrors.filter((v) => v !== undefined).length} observed`,
      );
    }
    const reasons = [];
    if (!eligible.length) reasons.push("no eligible trials");
    if (rateB + Number.EPSILON < rateA - 0.05)
      reasons.push("code outcome rate is more than 5 percentage points below six");
    if (sb.duplicates) reasons.push(`${sb.duplicates} code duplicate write(s)`);
    if (sb.exports) reasons.push(`${sb.exports} code export-once violation(s)`);
    if (drops.length) reasons.push(`task drops require triage: ${drops.join(", ")}`);
    const errors = eligible.filter(([x, y]) => x.status === "error" || y.status === "error").length;
    if (errors) reasons.push(`${errors} pair(s) contain infrastructure errors; rerun before deciding`);
    lines.push(
      fullScope
        ? `  Decision ${reasons.length ? "FAIL" : "PASS"}: ${reasons.join("; ") || "rate within 5 percentage points, zero code duplicate/export violations, no task drops by >=3 trials"}`
        : `  Decision NOT EVALUATED: diagnostic subset; all ${ACTIVE_TASKS.length} registered tasks are required${reasons.length ? `; ${reasons.join("; ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = flags(process.argv.slice(2));
  if (!args.has("a") || !args.has("b")) throw new Error("Usage: eval:compare -- --a <six.json> --b <code.json>");
  const [a, b] = await Promise.all(
    [args.get("a")!, args.get("b")!].map(async (p) => JSON.parse(await readFile(p, "utf8")) as AgentResultFile),
  );
  console.log(compare(a!, b!));
}
