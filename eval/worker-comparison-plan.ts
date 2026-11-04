/** Fixed before model trials; never select tasks from observed scores. */
import { COMPARISON_TASKS, ACTIVE_TASKS } from "./tasks/index.js";
import { workerRefusal } from "./deploy/targets.js";
import { NO_CODE_CAPABILITY_MISMATCHES } from "./tasks/surface.js";
import type { TrialResult } from "./agent/run.js";
import type { AgentResultFile } from "./report/summary.js";
import { median, trialEfficiency } from "./report/efficiency.js";
export const WORKER_COMPARISON = [
  ...COMPARISON_TASKS.filter((task) => !workerRefusal(task)).map((task) => ({
    id: task.id,
    category: /join|supabase|revenuecat|connecta-read/.test(task.id)
      ? "reduction/join"
      : /paging|export/.test(task.id)
        ? "paging"
        : /write|stale-close|refusal/.test(task.id)
          ? "writes/recovery"
          : /absent|auth/.test(task.id)
            ? "discovery"
            : "known read",
  })),
  ...ACTIVE_TASKS.filter((task) => task.id.startsWith("pco-step2-")).map((task) => ({
    id: task.id,
    category: /join|filtered/.test(task.id)
      ? "reduction/join"
      : /paging/.test(task.id)
        ? "paging"
        : /once|recovery/.test(task.id)
          ? "writes/recovery"
          : "discovery",
    largeCatalog: true,
  })),
];
export const WORKER_DECISION_RULE =
  "Code earns its place if native beats native-no-code on pass rate, or on model turns or tokens on reduction/join/paging tasks without a pass-rate loss elsewhere, in both cases over the roster minus NO_CODE_CAPABILITY_MISMATCHES. Six should stop being the default for bounded pools if native matches its pass rate with no extra duplicate writes and takes fewer turns. Anything short is inconclusive.";

/**
 * Applies the first sentence of the rule to one paired batch. A partial roster
 * says so rather than reading as a decision, and every excluded task is named.
 */
export function noCodeDecisionLines(
  native: AgentResultFile,
  noCode: AgentResultFile,
  nativePassed: (trial: TrialResult) => boolean,
  noCodePassed: (trial: TrialResult) => boolean,
): string[] {
  const comparable = WORKER_COMPARISON.filter((row) => !NO_CODE_CAPABILITY_MISMATCHES[row.id]);
  const ran = new Set(native.config.tasks.filter((id) => noCode.config.tasks.includes(id)));
  const missing = comparable.filter((row) => !ran.has(row.id));
  const reductions = new Set(
    comparable.filter((row) => row.category === "reduction/join" || row.category === "paging").map((row) => row.id),
  );
  const included = (trial: TrialResult) => ran.has(trial.task) && !NO_CODE_CAPABILITY_MISMATCHES[trial.task];
  const arm = (label: string, file: AgentResultFile, passed: (trial: TrialResult) => boolean) => {
    const trials = file.trials.filter((trial) => included(trial) && trial.status !== "skipped");
    const passing = trials.filter(passed);
    const reduced = passing.filter((trial) => reductions.has(trial.task)).map(trialEfficiency);
    const turns = median(reduced.flatMap((e) => (e.modelTurns === undefined ? [] : [e.modelTurns])));
    const tokens = median(reduced.map((e) => e.totalTokens));
    return `${label}: ${passing.length}/${trials.length} passing; reduction/join/paging passing medians: model turns ${turns ?? "N/A"}, total tokens ${tokens ?? "N/A"}`;
  };
  return [
    missing.length
      ? `Decision rule NOT applicable: this batch omits ${missing.length} comparable roster task(s): ${missing.map((row) => row.id).join(", ")}.`
      : "Decision rule inputs (the comparable roster, complete):",
    arm("native", native, nativePassed),
    arm("native-no-code", noCode, noCodePassed),
    `Excluded as capability mismatches, never counted for or against code (${Object.keys(NO_CODE_CAPABILITY_MISMATCHES).length}):`,
    ...Object.entries(NO_CODE_CAPABILITY_MISMATCHES).map(([id, reason]) => `- ${id}: ${reason}`),
  ];
}
