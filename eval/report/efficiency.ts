/**
 * Efficiency and reliability aggregates shared by `eval:agent`, `eval:compare`
 * and the HTML report. Everything is derived from fields a result file already
 * records: trial metrics, and the saved trace and program observations. Only
 * counts and sizes are read; no response payload is copied.
 *
 * Response sizes and guide fetches need saved grading inputs (`trial.saved`),
 * recorded by every trial since 0.29. Older files report them as N/A.
 */
import type { TrialResult } from "../agent/run.js";

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

const known = (values: (number | undefined)[]) =>
  values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));

interface ResponseSizes {
  calls: number;
  bytes: number;
  maxBytes: number;
  /** Each call's size, in call order. */
  each: number[];
}

export interface TrialEfficiency {
  /** Top-level tool calls: meta-tools plus any other tool the runner exposed. */
  calls: number;
  modelTurns: number | undefined;
  /** Input tokens including cache reads and writes, so runners compare alike. */
  promptTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  wallMs: number | undefined;
  costUsd: number | undefined;
  toolErrors: number | undefined;
  /** `skills` calls naming a guide plus `connecta.skill` program calls. */
  guideFetches: number | undefined;
  /** UTF-8 bytes of each recorded tool result, by top-level tool. */
  responses: Record<string, ResponseSizes> | undefined;
  responseBytes: number | undefined;
  largestResponse: { tool: string; bytes: number } | undefined;
}

const utf8 = new TextEncoder();

/** Tolerates historical metrics with absent fields; missing values stay undefined. */
export function trialEfficiency(trial: TrialResult): TrialEfficiency {
  const metrics = (trial.metrics ?? {}) as Partial<TrialResult["metrics"]>;
  const tokens = metrics.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const count = (record: Record<string, number> | undefined) =>
    Object.values(record ?? {}).reduce((sum, value) => sum + value, 0);
  const promptTokens = (tokens.input ?? 0) + (tokens.cacheRead ?? 0) + (tokens.cacheCreation ?? 0);
  const saved = trial.saved;
  let guideFetches: number | undefined;
  let responses: Record<string, ResponseSizes> | undefined;
  let largestResponse: TrialEfficiency["largestResponse"];
  if (saved?.trace && Array.isArray(saved.trace.toolUses)) {
    responses = {};
    guideFetches = 0;
    for (const use of saved.trace.toolUses) {
      const name = use.input?.name;
      if (use.tool === "skills" && typeof name === "string" && name.trim()) guideFetches += 1;
      if (typeof use.resultText !== "string") continue;
      const bytes = utf8.encode(use.resultText).length;
      const sizes = (responses[use.tool] ??= { calls: 0, bytes: 0, maxBytes: 0, each: [] });
      sizes.calls += 1;
      sizes.each.push(bytes);
      sizes.bytes += bytes;
      sizes.maxBytes = Math.max(sizes.maxBytes, bytes);
      if (!largestResponse || bytes > largestResponse.bytes) largestResponse = { tool: use.tool, bytes };
    }
    for (const program of saved.world?.programs ?? [])
      guideFetches += program.calls.filter((call) => call.name === "connecta.skill").length;
  }
  return {
    calls: count(metrics.metaTools) + count(metrics.otherTools),
    modelTurns: metrics.modelTurns,
    promptTokens,
    inputTokens: tokens.input ?? 0,
    outputTokens: tokens.output ?? 0,
    totalTokens: promptTokens + (tokens.output ?? 0),
    wallMs: metrics.wallMs,
    costUsd: metrics.costUsd,
    toolErrors: metrics.toolErrors,
    guideFetches,
    responses,
    responseBytes: responses ? Object.values(responses).reduce((sum, sizes) => sum + sizes.bytes, 0) : undefined,
    largestResponse,
  };
}

/**
 * Unbiased estimates from n graded trials with c passes: pass@k is the
 * chance at least one of k draws passes, pass^k that all k pass. Undefined
 * when k is not a positive integer or fewer than k trials were graded.
 */
export function passK(n: number, c: number, k: number): { passAtK: number; passHatK: number } | undefined {
  if (!Number.isInteger(k) || k < 1 || !Number.isInteger(n) || n < k || c < 0 || c > n) return undefined;
  // C(a, k) / C(n, k) as a running product, exact for small k and never overflowing.
  const ratio = (a: number) => {
    let value = 1;
    for (let i = 0; i < k; i++) value *= Math.max(0, a - i) / (n - i);
    return value;
  };
  return { passAtK: 1 - ratio(n - c), passHatK: ratio(c) };
}

export type Grade = "pass" | "fail" | "exclude";

interface CellReliability {
  task: string;
  model: string;
  graded: number;
  passed: number;
  excluded: number;
  passAtK: number | undefined;
  passHatK: number | undefined;
}

interface ModelReliability {
  model: string;
  /** Cells with an estimate; the aggregate is their unweighted mean. */
  cells: number;
  /** Cells with some graded trials but fewer than k. */
  unestimated: number;
  /** Cells whose every trial was excluded (N/A, or errors where excluded). */
  excluded: number;
  passAtK: number | undefined;
  passHatK: number | undefined;
}

export interface Reliability {
  k: number;
  cells: CellReliability[];
  models: ModelReliability[];
}

/** pass@k and pass^k for every task × model cell, then a per-model mean. */
export function reliability(trials: TrialResult[], k: number, grade: (trial: TrialResult) => Grade): Reliability {
  const groups = new Map<string, TrialResult[]>();
  for (const trial of trials) {
    const id = JSON.stringify([trial.task, trial.model]);
    groups.set(id, [...(groups.get(id) ?? []), trial]);
  }
  const cells = [...groups.entries()].map(([id, group]): CellReliability => {
    const [task, model] = JSON.parse(id) as [string, string];
    const grades = group.map(grade);
    const graded = grades.filter((g) => g !== "exclude").length;
    const passed = grades.filter((g) => g === "pass").length;
    const estimate = passK(graded, passed, k);
    return {
      task,
      model,
      graded,
      passed,
      excluded: grades.length - graded,
      passAtK: estimate?.passAtK,
      passHatK: estimate?.passHatK,
    };
  });
  const models = [...new Set(cells.map((cell) => cell.model))].sort().map((model): ModelReliability => {
    const own = cells.filter((cell) => cell.model === model);
    const estimated = own.filter((cell) => cell.passHatK !== undefined);
    return {
      model,
      cells: estimated.length,
      unestimated: own.filter((cell) => cell.graded > 0 && cell.passHatK === undefined).length,
      excluded: own.filter((cell) => cell.graded === 0).length,
      passAtK: mean(estimated.map((cell) => cell.passAtK!)),
      passHatK: mean(estimated.map((cell) => cell.passHatK!)),
    };
  });
  return { k, cells, models };
}

export interface ExpensiveTrial {
  task: string;
  repeat: number;
  status: TrialResult["status"];
  totalTokens: number;
  wallMs: number | undefined;
  costUsd: number | undefined;
  largestResponse: TrialEfficiency["largestResponse"];
  guideFetches: number | undefined;
  toolErrors: number | undefined;
}

export interface ModelEfficiency {
  model: string;
  /** Trials that ran (N/A excluded). */
  trials: number;
  passing: number;
  /** Ran trials without saved traces: response sizes and guide fetches unknown. */
  withoutSizes: number;
  /** Per-trial medians over passing trials, each with its sample size. */
  medians: Record<
    | "calls"
    | "modelTurns"
    | "promptTokens"
    | "outputTokens"
    | "wallMs"
    | "toolErrors"
    | "guideFetches"
    | "responseBytes",
    { value: number | undefined; n: number }
  >;
  /** Per-call response bytes by tool over passing trials. */
  responses: Record<string, { calls: number; medianBytes: number; maxBytes: number }>;
  /** Most expensive ran trials by total tokens, then wall time. */
  expensive: ExpensiveTrial[];
}

/**
 * `include` drops trials from every figure (N/A). `pass` selects the
 * passing trials whose medians describe normal cost.
 */
export function modelEfficiency(
  trials: TrialResult[],
  options: { include: (trial: TrialResult) => boolean; pass: (trial: TrialResult) => boolean; top?: number },
): ModelEfficiency[] {
  const top = options.top ?? 3;
  return [...new Set(trials.map((trial) => trial.model))].sort().map((model) => {
    const ran = trials.filter((trial) => trial.model === model && options.include(trial));
    const measured = ran.map((trial) => ({ trial, e: trialEfficiency(trial) }));
    const passing = measured.filter(({ trial }) => options.pass(trial)).map(({ e }) => e);
    const stat = (pick: (e: TrialEfficiency) => number | undefined) => {
      const values = known(passing.map(pick));
      return { value: median(values), n: values.length };
    };
    const perCall = new Map<string, number[]>();
    for (const e of passing)
      for (const [tool, sizes] of Object.entries(e.responses ?? {}))
        perCall.set(tool, [...(perCall.get(tool) ?? []), ...sizes.each]);
    const responses: ModelEfficiency["responses"] = {};
    for (const [tool, values] of [...perCall.entries()].sort(([a], [b]) => a.localeCompare(b)))
      responses[tool] = {
        calls: values.length,
        medianBytes: median(values)!,
        maxBytes: Math.max(...values),
      };
    const expensive = [...measured]
      .sort((a, b) => b.e.totalTokens - a.e.totalTokens || (b.e.wallMs ?? 0) - (a.e.wallMs ?? 0))
      .slice(0, top)
      .map(({ trial, e }): ExpensiveTrial => ({
        task: trial.task,
        repeat: trial.repeat,
        status: trial.status,
        totalTokens: e.totalTokens,
        wallMs: e.wallMs,
        costUsd: e.costUsd,
        largestResponse: e.largestResponse,
        guideFetches: e.guideFetches,
        toolErrors: e.toolErrors,
      }));
    return {
      model,
      trials: ran.length,
      passing: passing.length,
      withoutSizes: measured.filter(({ e }) => e.responses === undefined).length,
      medians: {
        calls: stat((e) => e.calls),
        modelTurns: stat((e) => e.modelTurns),
        promptTokens: stat((e) => e.promptTokens),
        outputTokens: stat((e) => e.outputTokens),
        wallMs: stat((e) => e.wallMs),
        toolErrors: stat((e) => e.toolErrors),
        guideFetches: stat((e) => e.guideFetches),
        responseBytes: stat((e) => e.responseBytes),
      },
      responses,
      expensive,
    };
  });
}

/**
 * The batch view used by `eval:agent` and the HTML report. Reliability counts
 * graded trials as the pass-rate does: N/A and infrastructure errors are
 * excluded, and k is the declared repeat count.
 */
export function batchEfficiency(trials: TrialResult[], k: number) {
  return {
    models: modelEfficiency(trials, {
      include: (trial) => trial.status !== "skipped",
      pass: (trial) => trial.status === "pass",
    }),
    reliability: reliability(trials, k, (trial) =>
      trial.status === "pass" ? "pass" : trial.status === "fail" ? "fail" : "exclude",
    ),
  };
}

function fmtCount(value: number | undefined, digits = 1): string {
  if (value === undefined) return "N/A";
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined) return "N/A";
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${Math.round(bytes)} B`;
}

const fmtRate = (value: number | undefined) => (value === undefined ? "N/A" : `${(value * 100).toFixed(1)}%`);

/** Why a trial was expensive, in a few words. */
export function expenseReason(trial: ExpensiveTrial): string {
  const parts = [
    trial.largestResponse
      ? `largest response ${fmtSize(trial.largestResponse.bytes)} from ${trial.largestResponse.tool}`
      : "largest response N/A",
    `${fmtCount(trial.guideFetches)} guide fetch(es)`,
    `${fmtCount(trial.toolErrors)} tool error(s)`,
  ];
  return parts.join(", ");
}

/** Compact plain-text summary for the end of an `eval:agent` batch. */
export function efficiencyLines(models: ModelEfficiency[], rel?: Reliability): string[] {
  const lines: string[] = [];
  for (const summary of models) {
    const m = summary.medians;
    const r = rel?.models.find((entry) => entry.model === summary.model);
    const n = (stat: { n: number }) => (stat.n === summary.passing ? "" : ` (n=${stat.n})`);
    lines.push(
      `${summary.model}: ${summary.passing}/${summary.trials} passing` +
        (r
          ? `; pass@${rel!.k} ${fmtRate(r.passAtK)}, pass^${rel!.k} ${fmtRate(r.passHatK)} over ${r.cells} cell(s)${r.unestimated ? `, ${r.unestimated} with fewer than ${rel!.k} graded` : ""}`
          : ""),
    );
    lines.push(
      `  passing medians: calls ${fmtCount(m.calls.value)}, model turns ${fmtCount(m.modelTurns.value)}${n(m.modelTurns)}, ` +
        `input tokens ${fmtCount(m.promptTokens.value, 0)} incl. cache, output ${fmtCount(m.outputTokens.value, 0)}, ` +
        `wall ${m.wallMs.value === undefined ? "N/A" : `${(m.wallMs.value / 1000).toFixed(1)}s`}, tool errors ${fmtCount(m.toolErrors.value)}${n(m.toolErrors)}, ` +
        `guide fetches ${fmtCount(m.guideFetches.value)}${n(m.guideFetches)}, response ${fmtSize(m.responseBytes.value)}${n(m.responseBytes)}`,
    );
    const tools = Object.entries(summary.responses);
    if (tools.length)
      lines.push(
        `  response per call: ${tools.map(([tool, s]) => `${tool} median ${fmtSize(s.medianBytes)}, max ${fmtSize(s.maxBytes)} (${s.calls} calls)`).join("; ")}`,
      );
    if (summary.withoutSizes)
      lines.push(`  ${summary.withoutSizes} trial(s) lack saved traces; response sizes and guide fetches are N/A`);
    for (const trial of summary.expensive)
      lines.push(
        `  expensive: ${trial.task} #${trial.repeat} ${trial.status} ${fmtCount(trial.totalTokens, 0)} tokens` +
          `${trial.wallMs === undefined ? "" : ` ${(trial.wallMs / 1000).toFixed(0)}s`}: ${expenseReason(trial)}`,
      );
  }
  return lines;
}
