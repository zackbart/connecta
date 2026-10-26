/** Whether live trials, and a batch of them, actually passed. A cached `status` alone never does. */
import { passes, type Grading } from "../tasks/grading.js";
import type { AgentResultFile } from "../report/summary.js";
import type { TrialResult } from "./run.js";

export function observation(trial: TrialResult, runner: "codex" | "claude") {
  return runner === "claude" ? trial.claude : trial.codex;
}

/** One outcome predicate supplies rates, paired deltas, infrastructure vetoes and batch status. */
export function trialOutcome(trial: TrialResult, runner: "codex" | "claude", grading: Grading = "outcome") {
  const observed = observation(trial, runner);
  const timeout = observed?.timedOut === true;
  const interruption = observed?.aborted === true;
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
  // Older Claude observations predate the explicit cleanup marker. Their 143
  // is accepted only with successful completion evidence and no failure flags.
  const expectedTermination =
    runner === "claude" &&
    !timeout &&
    !interruption &&
    !error &&
    !completion &&
    (trial.claude?.terminatedAfterCompletion === true
      ? observed.exitCode === null || observed.exitCode === 143
      : trial.claude?.terminatedAfterCompletion === undefined && observed?.exitCode === 143);
  const runnerExit = observed?.exitCode !== 0 && !expectedTermination;
  const outcome = !passes(trial.checks, grading);
  return {
    pass: !timeout && !interruption && !runnerExit && !error && !completion && !outcome,
    infrastructure: timeout || interruption || runnerExit || error,
    failures: { timeout, interruption, runnerExit, error, completion, outcome },
  };
}

/**
 * Every declared task × model × repeat must appear exactly once and pass.
 * Returns the reasons the batch failed; an empty list is a pass.
 */
export function batchFailures(file: AgentResultFile): string[] {
  const runner = file.config.runner ?? "codex";
  const grading = file.config.grading ?? "route";
  const problems: string[] = [];
  if (file.stopped) problems.push(`batch stopped: ${file.stopped}`);
  const seen = new Map<string, number>();
  for (const trial of file.trials) {
    const key = `${trial.task} ${trial.model} #${trial.repeat}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (
      !file.config.tasks.includes(trial.task) ||
      !file.config.models.includes(trial.model) ||
      !(trial.repeat >= 1 && trial.repeat <= file.config.repeats)
    ) {
      problems.push(`${key}: outside the declared batch`);
      continue;
    }
    if (trial.status === "skipped") {
      problems.push(`${key}: not run (${trial.skip?.reason ?? "skipped"})`);
      continue;
    }
    const outcome = trialOutcome(trial, runner, grading);
    if (trial.status === "pass" && outcome.pass) continue;
    const kinds = Object.entries(outcome.failures)
      .filter(([, failed]) => failed)
      .map(([kind]) => kind);
    const failed = trial.checks.filter((c) => !c.pass && !c.advisory).map((c) => c.id);
    problems.push(
      `${key}: ${trial.status}${kinds.length ? ` [${kinds.join(", ")}]` : ""}` +
        `${failed.length ? ` failed ${failed.join(", ")}` : ""}${trial.error ? ` error: ${trial.error}` : ""}`,
    );
  }
  for (let repeat = 1; repeat <= file.config.repeats; repeat += 1)
    for (const task of file.config.tasks)
      for (const model of file.config.models) {
        const key = `${task} ${model} #${repeat}`;
        const count = seen.get(key) ?? 0;
        if (count === 0) problems.push(`${key}: missing`);
        if (count > 1) problems.push(`${key}: recorded ${count} times`);
      }
  return problems;
}
