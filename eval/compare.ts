/** Offline paired A/B report. Route-only verdicts never enter the decision rule. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { regradeTrial } from "./agent/regrade.js";
import { observation, trialOutcome } from "./agent/verdict.js";
import type { TrialResult } from "./agent/run.js";
import type { AgentResultFile } from "./report/summary.js";
import { ACTIVE_TASKS, COMPARISON_TASKS } from "./tasks/index.js";
import { downstreamMetrics } from "./agent/trace.js";
import { restoreGradeInputs } from "./agent/saved.js";
import { flags, runProtocol } from "./support/meta.js";
import {
  efficiencyLines,
  fmtSize,
  median,
  modelEfficiency,
  reliability,
  trialEfficiency,
  type Grade,
  type Reliability,
} from "./report/efficiency.js";

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const average = (values: (number | undefined)[]) => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? `${(sum(known) / known.length).toFixed(1)} (n=${known.length})` : "N/A";
};
const middle = (values: (number | undefined)[]) => {
  const known = values.filter((v): v is number => v !== undefined);
  return known.length ? `${median(known)!.toFixed(1)} (n=${known.length})` : "N/A";
};
const pct = (value: number | undefined) => (value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`);
/** pass@k/pass^k for one task cell, or the model mean without a task. */
const passes = (six: Reliability, code: Reliability, task?: string) => {
  const pick = (rel: Reliability) => {
    const cell = task ? rel.cells.find((c) => c.task === task) : rel.models[0];
    return `${pct(cell?.passAtK)}/${pct(cell?.passHatK)}`;
  };
  return `pass@${six.k}/pass^${six.k} six ${pick(six)}, code ${pick(code)}`;
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
const claudeObservationSchema = observationSchema.extend({ terminatedAfterCompletion: z.boolean().optional() });
const trialSchema = z
  .object({
    task: knownString,
    taskDefinitionsHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: knownString,
    runner: z.enum(["codex", "claude"]),
    target: z.enum(["node", "worker"]).optional(),
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
    if ((trial.target ?? "node") !== targetOf(file))
      throw new Error(`Trial ${key(trial)} ran on ${trial.target ?? "node"}, not its batch's ${targetOf(file)} target`);
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

/** Results written before the worker target existed ran on node. */
const targetOf = (file: AgentResultFile) => file.config.target ?? "node";

/**
 * The measured-batch provenance one result file must carry before it enters
 * any comparison: fresh, unregraded, on the current protocol and a clean known
 * source, with every trial consistent with its batch, target included.
 */
function measuredProvenance(label: string, surface: "six" | "code", file: AgentResultFile): string[] {
  const reasons: string[] = [];
  const current = runProtocol();
  const known = (value: unknown) =>
    typeof value === "string" && value.trim() !== "" && !/unknown|unavailable/i.test(value);
  if (file.config.surface !== surface) reasons.push(`${label}: explicit ${surface} arm label is required`);
  if (file.config.grading !== "outcome") reasons.push(`${label}: measured grading must be outcome`);
  if (file.config.runner !== "codex" && file.config.runner !== "claude") reasons.push(`${label}: runner is required`);
  if (file.regrade) reasons.push(`${label}: offline regrade is not a fresh measured batch`);
  if (!file.protocol || file.protocol.version !== 1) reasons.push(`${label}: measured protocol version 1 is required`);
  if (!known(file.protocol?.pairId)) reasons.push(`${label}: fresh paired batch ID is required`);
  for (const field of ["taskDefinitionsHash", "harnessHash"] as const) {
    if (file.protocol?.[field] !== current[field])
      reasons.push(`${label}: ${field} is missing or differs from the current protocol`);
  }
  for (const field of ["commit", "srcTree"] as const)
    if (!/^[a-f0-9]{12,40}$/.test(file.meta?.git?.[field] ?? ""))
      reasons.push(`${label}: known source ${field} is required`);
  for (const field of ["dirty", "srcDirty"] as const)
    if (file.meta?.git?.[field] !== false) reasons.push(`${label}: ${field} must be recorded false`);
  for (const field of ["packageVersion", "node", "platform"] as const)
    if (!known(file.meta?.[field])) reasons.push(`${label}: runtime ${field} is required`);
  const cli = file.config.runner === "claude" ? file.claudeVersion : file.codexVersion;
  if (!known(cli)) reasons.push(`${label}: CLI version is required`);
  if (
    !Number.isInteger(file.config.concurrency) ||
    file.config.concurrency < 1 ||
    !Number.isFinite(file.config.timeoutMs) ||
    file.config.timeoutMs <= 0
  )
    reasons.push(`${label}: valid concurrency and deadline are required`);
  if (file.config.target !== undefined && file.config.target !== "node" && file.config.target !== "worker")
    reasons.push(`${label}: target must be node or worker`);
  for (const trial of file.trials) {
    const row = `${label}: trial ${key(trial)}`;
    const schema = trialSchema.safeParse(trial);
    if (!schema.success)
      for (const issue of schema.error.issues) reasons.push(`${row} invalid ${issue.path.join(".")}: ${issue.message}`);
    if (trial.surface !== surface || trial.grading !== "outcome" || trial.runner !== file.config.runner)
      reasons.push(`${row} must record its arm, outcome grading and runner`);
    if ((trial.target ?? "node") !== targetOf(file)) reasons.push(`${row} target contradicts batch`);
    if (trial.taskDefinitionsHash !== file.protocol?.taskDefinitionsHash)
      reasons.push(`${row} taskDefinitionsHash contradicts batch`);
    const task = ACTIVE_TASKS.find((t) => t.id === trial.task);
    if (trial.timeoutMs !== (task?.limits?.timeoutMs ?? file.config.timeoutMs))
      reasons.push(`${row} deadline contradicts task/batch`);
    if ((trial.codex && file.config.runner !== "codex") || (trial.claude && file.config.runner !== "claude"))
      reasons.push(`${row} runner metadata contradicts config`);
    const runner = file.config.runner === "claude" ? "claude" : "codex";
    if (isNA(trial, runner)) continue;
    const observed = observation(trial, runner);
    const metadata = (runner === "claude" ? claudeObservationSchema : observationSchema).safeParse(observed);
    if (!metadata.success)
      for (const issue of metadata.error.issues)
        reasons.push(`${row} invalid runner metadata ${issue.path.join(".")}: ${issue.message}`);
    if (observed?.requestedModel !== trial.model) reasons.push(`${row} requested model contradicts pair`);
    if (observed?.servedModel !== trial.model) reasons.push(`${row} served model contradicts requested model/batch`);
    if (observed?.version !== (runner === "claude" ? cli?.replace(/ \(Claude Code\)$/, "") : cli))
      reasons.push(`${row} CLI version contradicts batch`);
    if (trial.status === "skipped") reasons.push(`${row} unsupported skip`);
  }
  return reasons;
}

/** Provenance is original measurement metadata, never the offline regrade stamp. */
function provenance(a: AgentResultFile, b: AgentResultFile): string[] {
  const reasons: string[] = [];
  const equal = (label: string, x: unknown, y: unknown) => {
    if (x !== y) reasons.push(`Arms must use the same ${label}`);
  };
  for (const [arm, file] of [
    ["six", a],
    ["code", b],
  ] as const)
    reasons.push(...measuredProvenance(arm, arm, file));
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
  // Node and workerd are different deployments: no override pairs them here.
  if (targetOf(a) !== targetOf(b))
    throw new Error(
      `Comparison refused: arms ran on different targets (${targetOf(a)}, ${targetOf(b)}); use --cross-target for a diagnostic`,
    );
  const mismatches = provenance(a, b);
  if (mismatches.length && !options.allowMismatch)
    throw new Error(`Comparison refused:\n${mismatches.map((r) => `- ${r}`).join("\n")}`);
  const six = validate(a, "six"),
    code = validate(b, "code");
  if (six.size !== code.size || [...six.keys()].some((k) => !code.has(k)))
    throw new Error("Arms must have identical model/task/repeat pairs");
  const fullScope =
    a.config.tasks.length === COMPARISON_TASKS.length && COMPARISON_TASKS.every((t) => a.config.tasks.includes(t.id));
  const lines: string[] = mismatches.length
    ? ["NON-COMPARABLE: --allow-mismatch diagnostics", ...mismatches.map((r) => `  - ${r}`)]
    : [
        `Paired batch: ${a.protocol!.pairId}; target ${targetOf(a)}; source ${a.meta.git.commit}; tasks ${a.protocol!.taskDefinitionsHash}; harness ${a.protocol!.harnessHash}`,
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
    // Eligible trials exclude only N/A; infrastructure errors count as misses here.
    const relOf = (ts: TrialResult[]) =>
      reliability(ts, a.config.repeats, (t) => (trialOutcome(t, runner).pass ? "pass" : "fail"));
    const relA = relOf(left),
      relB = relOf(right);
    const drops: string[] = [];
    for (const task of [...new Set(left.map((t) => t.task))].sort()) {
      const taskPairs = eligible.filter(([t]) => t.task === task);
      const pa = passed(taskPairs.map(([t]) => t)),
        pb = passed(taskPairs.map(([, t]) => t));
      const losses = taskPairs.filter(([x, y]) => trialOutcome(x, runner).pass && !trialOutcome(y, runner).pass).length;
      const gains = taskPairs.filter(([x, y]) => !trialOutcome(x, runner).pass && trialOutcome(y, runner).pass).length;
      lines.push(
        `  ${task}: six ${pa}/${taskPairs.length}, code ${pb}/${taskPairs.length}, delta ${pb - pa >= 0 ? "+" : ""}${pb - pa}; paired losses ${losses}, gains ${gains}; ${passes(relA, relB, task)}`,
      );
      if (pa - pb >= 3) drops.push(`${task} (${pa - pb} of ${taskPairs.length})`);
    }
    lines.push(`  Tasks dropping by >=3 of N trials: ${drops.join(", ") || "none"}`);
    const short = (rel: Reliability) => rel.models[0]?.unestimated ?? 0;
    lines.push(
      `  Reliability, mean over task cells: ${passes(relA, relB)}${short(relA) + short(relB) ? `; cells with fewer than ${relA.k} eligible trials: six ${short(relA)}, code ${short(relB)}` : ""}`,
    );
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
        `  ${arm} mean/trial: model turns ${average(ts.map((t) => t.metrics.modelTurns))}; top-level calls ${average(ts.map((t) => sum([...Object.values(t.metrics.metaTools), ...Object.values(t.metrics.otherTools)])))}; input tokens ${average(ts.map((t) => t.metrics.tokens.input))}; output tokens ${average(ts.map((t) => t.metrics.tokens.output))}; wall ms ${average(ts.map((t) => t.metrics.wallMs))}; tool errors ${average(ts.map((t) => t.metrics.toolErrors))}; first-attempt program errors ${sum(firstErrors.filter((v): v is number => v !== undefined))}/${firstErrors.filter((v) => v !== undefined).length} observed`,
      );
      lines.push(
        `  ${arm} median/trial: model turns ${middle(ts.map((t) => t.metrics.modelTurns))}; top-level calls ${middle(ts.map((t) => sum([...Object.values(t.metrics.metaTools), ...Object.values(t.metrics.otherTools)])))}; input tokens ${middle(ts.map((t) => t.metrics.tokens.input))}; output tokens ${middle(ts.map((t) => t.metrics.tokens.output))}; wall ms ${middle(ts.map((t) => t.metrics.wallMs))}; tool errors ${middle(ts.map((t) => t.metrics.toolErrors))}`,
      );
      const efficiency = ts.map(trialEfficiency);
      const [summary] = modelEfficiency(ts, { include: () => true, pass: () => true });
      lines.push(
        `  ${arm} guide fetches mean ${average(efficiency.map((e) => e.guideFetches))}, median ${middle(efficiency.map((e) => e.guideFetches))}; response bytes/trial mean ${average(efficiency.map((e) => e.responseBytes))}, median ${middle(efficiency.map((e) => e.responseBytes))}; per call: ${
          Object.entries(summary?.responses ?? {})
            .map(
              ([tool, r]) => `${tool} median ${fmtSize(r.medianBytes)}, max ${fmtSize(r.maxBytes)} (${r.calls} calls)`,
            )
            .join("; ") || "N/A"
        }${summary?.withoutSizes ? `; ${summary.withoutSizes} trial(s) lack saved traces` : ""}`,
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
        : `  Decision NOT EVALUATED: diagnostic task set; exactly the ${COMPARISON_TASKS.length} registered tasks are required${reasons.length ? `; ${reasons.join("; ")}` : ""}`,
    );
  }
  return lines.join("\n");
}

/**
 * Node against workerd for the same surface, tasks, models and runner. A
 * diagnostic only: it reports outcomes and efficiency side by side and never
 * reaches a decision.
 */
export function crossTarget(node: AgentResultFile, worker: AgentResultFile): string {
  const surface = node.config.surface ?? "six";
  const reasons: string[] = [
    ...measuredProvenance("node", surface, node),
    ...measuredProvenance("worker", surface, worker),
  ];
  if (targetOf(node) !== "node") reasons.push("--a must be a node result");
  if (targetOf(worker) !== "worker") reasons.push("--b must be a worker result");
  const same = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) reasons.push(`Targets must use the same ${label}`);
  };
  same("task set", [...node.config.tasks].sort(), [...worker.config.tasks].sort());
  same("model set", [...node.config.models].sort(), [...worker.config.models].sort());
  for (const field of ["runner", "surface", "grading", "repeats", "timeoutMs", "effort", "maxBudgetUsd"] as const)
    same(field, node.config[field], worker.config[field]);
  same("CLI version", node.claudeVersion ?? node.codexVersion, worker.claudeVersion ?? worker.codexVersion);
  same("paired batch ID", node.protocol?.pairId, worker.protocol?.pairId);
  same("source commit", node.meta?.git?.commit, worker.meta?.git?.commit);
  for (const field of ["packageVersion", "node", "platform"] as const)
    same(field, node.meta?.[field], worker.meta?.[field]);
  for (const field of ["taskDefinitionsHash", "harnessHash"] as const)
    same(field, node.protocol?.[field], worker.protocol?.[field]);
  same("source tree", node.meta?.git?.srcTree, worker.meta?.git?.srcTree);
  if (node.config.grading !== "outcome") reasons.push("measured grading must be outcome");
  if (reasons.length)
    throw new Error(`Cross-target diagnostic refused:\n${[...new Set(reasons)].map((r) => `- ${r}`).join("\n")}`);
  const runner = node.config.runner === "claude" ? "claude" : "codex";
  const left = validate(node, surface),
    right = validate(worker, surface);
  const lines = [
    `CROSS-TARGET DIAGNOSTIC (no decision): node vs worker, ${surface} surface, ${runner}; source tree ${node.meta.git.srcTree}`,
  ];
  // The same efficiency aggregates as eval:agent and the report: medians over
  // passing trials, pass@k/pass^k over graded trials (N/A and infrastructure
  // errors excluded), k = the declared repeats.
  const options = {
    include: (t: TrialResult) => !isNA(t, runner),
    pass: (t: TrialResult) => trialOutcome(t, runner).pass,
  };
  const grade = (t: TrialResult): Grade => {
    const outcome = trialOutcome(t, runner);
    return isNA(t, runner) || outcome.infrastructure ? "exclude" : outcome.pass ? "pass" : "fail";
  };
  for (const [label, trials] of [
    ["node", [...left.values()]],
    ["worker", [...right.values()]],
  ] as [string, TrialResult[]][]) {
    lines.push(`${label}:`);
    lines.push(
      ...efficiencyLines(modelEfficiency(trials, options), reliability(trials, node.config.repeats, grade)).map(
        (line) => `  ${line}`,
      ),
    );
  }
  lines.push("Per task, passing medians (n passing/ran):");
  for (const task of [...new Set([...left.values()].map((t) => t.task))].sort()) {
    lines.push(`  ${task}`);
    for (const [label, trials] of [
      ["node", left],
      ["worker", right],
    ] as const)
      for (const summary of modelEfficiency(
        [...trials.values()].filter((t) => t.task === task),
        options,
      )) {
        const m = summary.medians;
        const value = (stat: { value: number | undefined }) => (stat.value === undefined ? "N/A" : String(stat.value));
        lines.push(
          `    ${label.padEnd(6)} ${summary.model} ${summary.passing}/${summary.trials}: calls ${value(m.calls)}, model turns ${value(m.modelTurns)}, input tokens incl. cache ${value(m.promptTokens)}, wall ms ${value(m.wallMs)}, response ${fmtSize(m.responseBytes.value)}, tool errors ${value(m.toolErrors)}`,
        );
      }
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = flags(process.argv.slice(2));
  if (!args.has("a") || !args.has("b"))
    throw new Error(
      "Usage: eval:compare --a <six.json> --b <code.json> [--allow-mismatch] | --cross-target --a <node.json> --b <worker.json>",
    );
  const [a, b] = await Promise.all(
    [args.get("a")!, args.get("b")!].map(async (p) => JSON.parse(await readFile(p, "utf8")) as AgentResultFile),
  );
  console.log(
    args.has("cross-target") ? crossTarget(a!, b!) : compare(a!, b!, { allowMismatch: args.has("allow-mismatch") }),
  );
}
