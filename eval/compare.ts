/** Offline paired A/B report. Route-only verdicts never enter the decision rule. */
import { z } from "zod";
import { passes } from "./tasks/grading.js";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { regradeTrial } from "./agent/regrade.js";
import type { TrialResult } from "./agent/run.js";
import type { AgentResultFile } from "./report/summary.js";
import { ACTIVE_TASKS } from "./tasks/index.js";
import { downstreamMetrics } from "./agent/trace.js";
import { restoreGradeInputs } from "./agent/saved.js";
import { flags, runProtocol } from "./support/meta.js";

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const average = (values: (number | undefined)[]) => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? `${(sum(known) / known.length).toFixed(1)} (n=${known.length})` : "N/A";
};
const key = (t: TrialResult) => JSON.stringify([t.model, t.task, t.repeat]);

// Historical files remain readable, but only this measured-trial contract can
// establish a decision. Unknown runner fields are refused, not guessed at.
const knownString = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !/unknown|unavailable/i.test(s));
const observationSchema = z
  .object({
    requestedModel: knownString,
    servedModel: knownString,
    version: knownString,
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    aborted: z.boolean(),
    resultSubtypes: z.array(z.string().min(1)).min(1),
    stderrTail: z.string().optional(),
    argv: z.array(z.string()).optional(),
    loadedTools: z.array(z.string()).optional(),
    skillInventory: z.unknown().optional(),
    pluginInventory: z.unknown().optional(),
  })
  .strict();
const trialSchema = z
  .object({
    task: knownString,
    taskDefinitionsHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: knownString,
    runner: z.enum(["codex", "claude"]),
    surface: z.enum(["six", "code"]),
    grading: z.literal("outcome"),
    repeat: z.number().int().positive(),
    status: z.enum(["pass", "fail", "error", "skipped"]),
    timeoutMs: z.number().positive().finite(),
    error: z.string().min(1).optional(),
    skip: z
      .object({ code: z.literal("runner-limitation"), reason: knownString })
      .strict()
      .optional(),
    codex: z.unknown().optional(),
    claude: z.unknown().optional(),
    saved: z.unknown().optional(),
    regrade: z.unknown().optional(),
    checks: z.array(z.object({ id: knownString, pass: z.boolean() }).passthrough()),
    metrics: z.unknown(),
    approvals: z.unknown(),
    transcript: z.array(z.unknown()),
    finalAnswer: z.string().optional(),
    urlElicitations: z.array(z.unknown()).optional(),
    ledger: z.array(z.unknown()),
    startedAt: knownString,
  })
  .strict();

function observation(trial: TrialResult, runner: "codex" | "claude") {
  return runner === "claude" ? trial.claude : trial.codex;
}

/** The only exclusion is an unexecuted, explicitly recorded Claude rich-output N/A. */
function isNA(trial: TrialResult, runner: "codex" | "claude"): boolean {
  const skip = ACTIVE_TASKS.find((t) => t.id === trial.task)?.runnerSkips?.[runner];
  return (
    runner === "claude" &&
    !!skip &&
    trial.status === "skipped" &&
    trial.skip?.code === skip.code &&
    trial.skip.reason === skip.reason &&
    !trial.codex &&
    !trial.claude &&
    trial.error === undefined &&
    trial.metrics.conversationTurns === 0 &&
    trial.checks.length === 0 &&
    trial.transcript.length === 0 &&
    !trial.saved?.trace.resultSubtypes.length
  );
}

/** One outcome predicate supplies rates, paired deltas, and infrastructure vetoes. */
function trialOutcome(trial: TrialResult, runner: "codex" | "claude") {
  const observed = observation(trial, runner);
  const timeout = observed?.timedOut === true;
  const interruption = observed?.aborted === true;
  const runnerExit = observed?.exitCode !== 0;
  const error =
    trial.status === "error" ||
    trial.error !== undefined ||
    (Array.isArray(observed?.resultSubtypes) && observed.resultSubtypes.some((s) => s !== "success")) ||
    trial.saved?.trace.transcript.some((e) => e.kind === "turn_end" && e.isError === true) === true;
  const completion =
    !["pass", "fail"].includes(trial.status) ||
    !Array.isArray(observed?.resultSubtypes) ||
    !observed.resultSubtypes.length ||
    observed.resultSubtypes.some((s) => s !== "success") ||
    !trial.checks.some((c) => c.id === "conversation-completed" && c.pass);
  const outcome = !passes(trial.checks, "outcome");
  return {
    pass: !timeout && !interruption && !runnerExit && !error && !completion && !outcome,
    infrastructure: timeout || interruption || runnerExit || error,
    failures: { timeout, interruption, runnerExit, error, completion, outcome },
  };
}

function validate(file: AgentResultFile, surface: "six" | "code"): Map<string, TrialResult> {
  if (file.kind !== "connecta-eval/agent" || file.version !== 1)
    throw new Error("Expected agent result file version 1");
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
    const recorded = trialOutcome(trial, runner);
    if (trial.saved && (recorded.infrastructure || task.runnerSkips?.[runner])) restoreGradeInputs(trial.saved);
    // Regrading cannot turn a timeout/error into a normal completion or N/A.
    const graded = isNA(trial, runner)
      ? trial
      : recorded.infrastructure
        ? trial
        : regradeTrial(task, trial, runner, "outcome", surface);
    if (graded.status === "skipped" && !isNA(trial, runner)) throw new Error(`Unsupported N/A for ${key(trial)}`);
    if (
      !recorded.infrastructure &&
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

/** Provenance is original measurement metadata, never the offline regrade stamp. */
function provenance(a: AgentResultFile, b: AgentResultFile): string[] {
  const reasons: string[] = [];
  const current = runProtocol();
  const known = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" && !/unknown|unavailable/i.test(value);
  const equal = (label: string, x: unknown, y: unknown) => {
    if (x !== y) reasons.push(`Arms must use the same ${label}`);
  };
  for (const [arm, file] of [
    ["six", a],
    ["code", b],
  ] as const) {
    if (file.config.surface !== arm) reasons.push(`${arm}: explicit ${arm} arm label is required`);
    if (file.config.grading !== "outcome") reasons.push(`${arm}: measured grading must be outcome`);
    if (file.config.runner !== "codex" && file.config.runner !== "claude") reasons.push(`${arm}: runner is required`);
    if (file.regrade) reasons.push(`${arm}: offline regrade is not a fresh measured batch`);
    if (!file.protocol || file.protocol.version !== 1) reasons.push(`${arm}: measured protocol version 1 is required`);
    if (!known(file.protocol?.pairId)) reasons.push(`${arm}: fresh paired batch ID is required`);
    for (const field of ["taskDefinitionsHash", "harnessHash"] as const) {
      if (file.protocol?.[field] !== current[field])
        reasons.push(`${arm}: ${field} is missing or differs from the current protocol`);
    }
    for (const field of ["commit", "srcTree"] as const)
      if (!/^[a-f0-9]{12,40}$/.test(file.meta?.git?.[field] ?? ""))
        reasons.push(`${arm}: known source ${field} is required`);
    for (const field of ["dirty", "srcDirty"] as const)
      if (file.meta?.git?.[field] !== false) reasons.push(`${arm}: ${field} must be recorded false`);
    for (const field of ["packageVersion", "node", "platform"] as const)
      if (!known(file.meta?.[field])) reasons.push(`${arm}: runtime ${field} is required`);
    const cli = file.config.runner === "claude" ? file.claudeVersion : file.codexVersion;
    if (!known(cli)) reasons.push(`${arm}: CLI version is required`);
    if (
      !Number.isInteger(file.config.concurrency) ||
      file.config.concurrency < 1 ||
      !Number.isFinite(file.config.timeoutMs) ||
      file.config.timeoutMs <= 0
    )
      reasons.push(`${arm}: valid concurrency and deadline are required`);
    for (const trial of file.trials) {
      const label = `${arm}: trial ${key(trial)}`;
      const schema = trialSchema.safeParse(trial);
      if (!schema.success)
        for (const issue of schema.error.issues)
          reasons.push(`${label} invalid ${issue.path.join(".")}: ${issue.message}`);
      if (trial.surface !== arm || trial.grading !== "outcome" || trial.runner !== file.config.runner)
        reasons.push(`${label} must record its arm, outcome grading and runner`);
      if (trial.taskDefinitionsHash !== file.protocol?.taskDefinitionsHash)
        reasons.push(`${label} taskDefinitionsHash contradicts batch`);
      const task = ACTIVE_TASKS.find((t) => t.id === trial.task);
      if (trial.timeoutMs !== (task?.limits?.timeoutMs ?? file.config.timeoutMs))
        reasons.push(`${label} deadline contradicts task/batch`);
      if ((trial.codex && file.config.runner !== "codex") || (trial.claude && file.config.runner !== "claude"))
        reasons.push(`${label} runner metadata contradicts config`);
      const runner = file.config.runner === "claude" ? "claude" : "codex";
      if (isNA(trial, runner)) continue;
      const observed = observation(trial, runner);
      const metadata = observationSchema.safeParse(observed);
      if (!metadata.success)
        for (const issue of metadata.error.issues)
          reasons.push(`${label} invalid runner metadata ${issue.path.join(".")}: ${issue.message}`);
      if (observed?.requestedModel !== trial.model) reasons.push(`${label} requested model contradicts pair`);
      if (observed?.servedModel !== trial.model)
        reasons.push(`${label} served model contradicts requested model/batch`);
      if (observed?.version !== (runner === "claude" ? cli?.replace(/ \(Claude Code\)$/, "") : cli))
        reasons.push(`${label} CLI version contradicts batch`);
      if (trial.status === "skipped") reasons.push(`${label} unsupported skip`);
    }
  }
  equal("task set", JSON.stringify([...a.config.tasks].sort()), JSON.stringify([...b.config.tasks].sort()));
  equal("model set", JSON.stringify([...a.config.models].sort()), JSON.stringify([...b.config.models].sort()));
  equal("runner", a.config.runner, b.config.runner);
  equal(
    "CLI version",
    a.config.runner === "claude" ? a.claudeVersion : a.codexVersion,
    b.config.runner === "claude" ? b.claudeVersion : b.codexVersion,
  );
  for (const field of ["pairId", "taskDefinitionsHash", "harnessHash"] as const)
    equal(field, a.protocol?.[field], b.protocol?.[field]);
  for (const field of ["commit", "srcTree"] as const)
    equal(`source ${field}`, a.meta?.git?.[field], b.meta?.git?.[field]);
  for (const field of ["packageVersion", "node", "platform"] as const) equal(field, a.meta?.[field], b.meta?.[field]);
  for (const field of ["repeats", "effort", "timeoutMs", "concurrency", "maxBudgetUsd"] as const)
    equal(field, a.config[field], b.config[field]);
  equal("MCP output limit", a.config.mcpOutputTokens ?? "host default", b.config.mcpOutputTokens ?? "host default");
  const right = new Map(b.trials.map((t) => [key(t), t]));
  for (const trial of a.trials) {
    const paired = right.get(key(trial));
    if (!paired) continue;
    const leftMetadata = a.config.runner === "claude" ? trial.claude : trial.codex;
    const rightMetadata = b.config.runner === "claude" ? paired.claude : paired.codex;
    equal(`served model for ${key(trial)}`, leftMetadata?.servedModel, rightMetadata?.servedModel);
  }
  return [...new Set(reasons)];
}

export function compare(a: AgentResultFile, b: AgentResultFile, options: { allowMismatch?: boolean } = {}): string {
  const mismatches = provenance(a, b);
  if (mismatches.length && !options.allowMismatch)
    throw new Error(`Comparison refused:\n${mismatches.map((r) => `- ${r}`).join("\n")}`);
  const six = validate(a, "six"),
    code = validate(b, "code");
  if (six.size !== code.size || [...six.keys()].some((k) => !code.has(k)))
    throw new Error("Arms must have identical model/task/repeat pairs");
  const fullScope = ACTIVE_TASKS.every((t) => a.config.tasks.includes(t.id));
  const lines: string[] = mismatches.length
    ? ["NON-COMPARABLE: --allow-mismatch diagnostics", ...mismatches.map((r) => `  - ${r}`)]
    : [
        `Paired batch: ${a.protocol!.pairId}; source ${a.meta.git.commit}; tasks ${a.protocol!.taskDefinitionsHash}; harness ${a.protocol!.harnessHash}`,
      ];
  for (const model of [...new Set([...six.values()].map((t) => t.model))].sort()) {
    const pairs = [...six.values()].filter((t) => t.model === model).map((t) => [t, code.get(key(t))!] as const);
    if (pairs.some(([x, y]) => (x.status === "skipped") !== (y.status === "skipped")))
      throw new Error(`N/A mismatch for ${model}`);
    const runner = a.config.runner === "claude" ? "claude" : "codex";
    const eligible = pairs.filter(([t]) => !isNA(t, runner));
    const left = eligible.map(([t]) => t),
      right = eligible.map(([, t]) => t);
    const passed = (ts: TrialResult[]) => ts.filter((t) => trialOutcome(t, runner).pass).length;
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
      const losses = taskPairs.filter(([x, y]) => trialOutcome(x, runner).pass && !trialOutcome(y, runner).pass).length;
      const gains = taskPairs.filter(([x, y]) => !trialOutcome(x, runner).pass && trialOutcome(y, runner).pass).length;
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
      const outcomes = ts.map((t) => trialOutcome(t, runner));
      lines.push(
        `  ${arm} failures: ${["timeout", "interruption", "runnerExit", "error", "completion", "outcome"]
          .map((kind) => `${kind} ${outcomes.filter((o) => o.failures[kind as keyof typeof o.failures]).length}`)
          .join(", ")} (kinds may overlap)`,
      );
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
    const errors = eligible.filter(
      ([x, y]) => trialOutcome(x, runner).infrastructure || trialOutcome(y, runner).infrastructure,
    ).length;
    if (errors) reasons.push(`${errors} pair(s) contain infrastructure errors; rerun before deciding`);
    lines.push(
      fullScope
        ? `  Decision ${mismatches.length ? "NON-COMPARABLE " : ""}${reasons.length ? "FAIL" : "PASS"}: ${reasons.join("; ") || "rate within 5 percentage points, zero code duplicate/export violations, no task drops by >=3 trials"}`
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
  console.log(compare(a!, b!, { allowMismatch: args.has("allow-mismatch") }));
}
