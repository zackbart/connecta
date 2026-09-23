/**
 * Result-file shapes and the aggregation both the CLI and the HTML report use.
 * A result file is self-describing: its `kind` says which runner wrote it.
 */
import type { TrialResult } from "../agent/run.js";
import type { RunMeta } from "../support/meta.js";
import type { PlannedTask } from "../tasks/types.js";

export interface AgentResultFile {
  kind: "connecta-eval/agent";
  version: 1;
  meta: RunMeta;
  claudeVersion: string;
  config: {
    models: string[];
    repeats: number;
    tasks: string[];
    concurrency: number;
    timeoutMs: number;
    effort?: string;
    mcpOutputTokens?: number | "host default";
  };
  tasks: { id: string; title: string; measures: string; introducedIn: string }[];
  planned: PlannedTask[];
  trials: TrialResult[];
  stopped?: string;
}

export interface PerfResultFile {
  kind: "connecta-eval/perf";
  version: 1;
  meta: RunMeta;
  bundle: {
    entry: string;
    platform: string;
    minifiedBytes: number;
    gzipBytes: number;
    /** Largest inputs by bytes in the minified output. */
    topInputs: { path: string; bytes: number }[];
  };
  latency: {
    deployment: string;
    samples: number;
    operations: { name: string; p50Ms: number; p90Ms: number; minMs: number; maxMs: number }[];
  };
}

export interface SmokeCheck {
  name: string;
  pass: boolean;
  ms: number;
  detail?: string;
}

export interface SmokeTarget {
  target: string;
  description: string;
  status: "pass" | "fail" | "skipped";
  reason?: string;
  checks: SmokeCheck[];
  /** Base64 PNG of the operator UI, embedded in the report. */
  screenshot?: string | undefined;
}

export interface SmokeResultFile {
  kind: "connecta-eval/smoke";
  version: 1;
  meta: RunMeta;
  targets: SmokeTarget[];
}

export type ResultFile = AgentResultFile | PerfResultFile | SmokeResultFile;

export interface CellSummary {
  task: string;
  model: string;
  trials: number;
  passed: number;
  failed: number;
  errored: number;
  /** Passed over graded (errors excluded). */
  passRate: number | undefined;
  medianWallMs: number | undefined;
  medianCostUsd: number | undefined;
  meanTokens: number | undefined;
  meanOutputTokens: number | undefined;
  meanMetaCalls: number | undefined;
  metaTools: Record<string, number>;
  meanReads: number | undefined;
  meanWrites: number | undefined;
  duplicateWrites: number;
  duplicateReads: number;
  failedChecks: Record<string, number>;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

export function summarize(trials: TrialResult[]): CellSummary[] {
  const cells = new Map<string, TrialResult[]>();
  for (const trial of trials) {
    const key = `${trial.task}\u0000${trial.model}`;
    cells.set(key, [...(cells.get(key) ?? []), trial]);
  }
  return [...cells.entries()].map(([key, group]) => {
    const [task, model] = key.split("\u0000") as [string, string];
    const graded = group.filter((trial) => trial.status !== "error");
    const metaTools: Record<string, number> = {};
    for (const trial of graded) {
      for (const [tool, count] of Object.entries(trial.metrics.metaTools)) {
        metaTools[tool] = (metaTools[tool] ?? 0) + count / graded.length;
      }
    }
    const failedChecks: Record<string, number> = {};
    for (const trial of graded) {
      for (const item of trial.checks) {
        if (!item.pass && !item.advisory) failedChecks[item.id] = (failedChecks[item.id] ?? 0) + 1;
      }
    }
    const total = (trial: TrialResult) => {
      const tokens = trial.metrics.tokens;
      return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
    };
    return {
      task,
      model,
      trials: group.length,
      passed: group.filter((trial) => trial.status === "pass").length,
      failed: group.filter((trial) => trial.status === "fail").length,
      errored: group.filter((trial) => trial.status === "error").length,
      passRate: graded.length ? graded.filter((trial) => trial.status === "pass").length / graded.length : undefined,
      medianWallMs: median(graded.map((trial) => trial.metrics.wallMs)),
      medianCostUsd: median(graded.flatMap((trial) => (trial.metrics.costUsd === undefined ? [] : [trial.metrics.costUsd]))),
      meanTokens: mean(graded.map(total)),
      meanOutputTokens: mean(graded.map((trial) => trial.metrics.tokens.output)),
      meanMetaCalls: mean(graded.map((trial) => Object.values(trial.metrics.metaTools).reduce((sum, count) => sum + count, 0))),
      metaTools,
      meanReads: mean(graded.map((trial) => trial.metrics.downstream.reads)),
      meanWrites: mean(graded.map((trial) => trial.metrics.downstream.writes)),
      duplicateWrites: graded.reduce((sum, trial) => sum + trial.metrics.downstream.duplicateWrites, 0),
      duplicateReads: graded.reduce((sum, trial) => sum + trial.metrics.downstream.duplicateReads, 0),
      failedChecks,
    };
  });
}
