/**
 * Description-arm measures, derived offline from saved traces and program
 * observations, so a regrade needs no model. Shared by `eval:compare` and
 * `eval/description-report.ts`.
 */
import { trialOutcome } from "../agent/verdict.js";
import type { TrialResult } from "../agent/run.js";
import type { AgentResultFile } from "./summary.js";
import { mean, median, trialEfficiency } from "./efficiency.js";

/**
 * Operations a named tool serves, by provider: a hatch call reaching one when
 * the named tool would have answered is misuse. Uploads routed to their own
 * hatch are not listed. `test/eval-description-arms.test.ts` checks this
 * against each provider's declared table.
 */
export const NAMED_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  stripe: ["GET /v1/account", "GET /v1/balance"],
  cloudflare: ["GET /accounts", "GET /zones", "GET /user/tokens/verify"],
  ccb: [
    "GET /me",
    "GET /individuals",
    "GET /individuals/{id}",
    "GET /families",
    "GET /families/{id}",
    "GET /groups",
    "GET /groups/{id}",
    "GET /groups/{id}/members",
    "GET /individuals/{id}/groups",
    "GET /events",
    "GET /events/{id}",
    "GET /events/{id}/attendance/{occurrence}",
    "GET /events/{id}/attendance/{occurrence}/attendees",
    "GET /individuals/{id}/notes",
    "GET /individuals/{id}/metrics/giving",
    "GET /families/{id}/metrics/giving",
  ],
  quickbooks: ["GET /companyinfo/{id}", "GET /query", "GET /invoice/{id}", "GET /customer/{id}"],
};

const namedPatterns = Object.fromEntries(
  Object.entries(NAMED_OPERATIONS).map(([provider, operations]) => [
    provider,
    operations.map((operation) => {
      const [method, path] = operation.split(" ") as [string, string];
      return { method, path: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`) };
    }),
  ]),
);

interface Attempt {
  address: string;
  args: Record<string, unknown>;
  invalidArgs: boolean;
  failed: boolean;
}

/** Every provider-tool attempt in call order: direct, native and inside programs. */
export function trialAttempts(trial: TrialResult): Attempt[] {
  const saved = trial.saved;
  if (!saved) return [];
  const programs = [...(saved.world.programs ?? [])];
  const attempts: Attempt[] = [];
  const addProgram = (program: (typeof programs)[number]) => {
    for (const call of program.calls) {
      if (call.name !== "connecta.call") continue;
      attempts.push({
        address: String(call.args[0]),
        args: (call.args[1] ?? {}) as Record<string, unknown>,
        invalidArgs: call.errorCode === "invalid_args",
        failed: call.outcome === "error",
      });
    }
  };
  for (const use of saved.trace.toolUses) {
    const name = use.tool;
    const address =
      use.native?.address ??
      (name === "call_tool" || name === "call_destructive_tool" ? String(use.input.address) : undefined);
    if (address) {
      attempts.push({
        address,
        args: (use.native ? use.input : (use.input.args ?? {})) as Record<string, unknown>,
        invalidArgs: use.isError === true && /\binvalid_args\b/.test(use.resultText ?? ""),
        failed: use.isError === true,
      });
    } else if (name === "execute_code" && typeof use.input.code === "string") {
      const code = use.input.code.trim();
      const index = programs.findIndex((p) => p.code === code || p.code.includes(`\n${code}\n`));
      if (index >= 0) addProgram(programs.splice(index, 1)[0]!);
    }
  }
  programs.forEach(addProgram);
  return attempts;
}

export interface DescriptionMetrics {
  /** Distinct provider tools attempted. */
  firstAttempts: number;
  /** Of those, how many failed invalid_args on their very first call. */
  firstAttemptInvalidArgs: number;
  invalidArgs: number;
  hatchCalls: number;
  /**
   * Hatch calls refused invalid_args, plus hatch calls reaching an operation a
   * named tool serves. Other failures are not misuse: recovery tasks inject them.
   */
  hatchMisuse: number;
  hatchNamedBypass: number;
  searches: number;
  describes: number;
  hatchDiscovery: number;
  guideFetches: number | undefined;
  toolErrorsBeforeFirstSuccess: number | undefined;
  totalTokens: number;
  firstTurnInputTokens: number | undefined;
  responseBytes: number | undefined;
}

export function descriptionMetrics(trial: TrialResult): DescriptionMetrics {
  const attempts = trialAttempts(trial);
  const seen = new Set<string>();
  let firstAttemptInvalidArgs = 0;
  let hatchCalls = 0;
  let hatchMisuse = 0;
  let hatchNamedBypass = 0;
  let hatchDiscovery = 0;
  for (const attempt of attempts) {
    if (!seen.has(attempt.address)) {
      seen.add(attempt.address);
      if (attempt.invalidArgs) firstAttemptInvalidArgs += 1;
    }
    const tool = attempt.address.split(".").at(-1) ?? "";
    if (/_api_(search|details)$/.test(tool)) hatchDiscovery += 1;
    if (!/_api_(read|write|upload)$/.test(tool)) continue;
    hatchCalls += 1;
    const provider = tool.replace(/_api_\w+$/, "");
    const method = typeof attempt.args.method === "string" ? attempt.args.method : "GET";
    const path = typeof attempt.args.path === "string" ? attempt.args.path : "";
    const bypass = (namedPatterns[provider] ?? []).some((op) => op.method === method && op.path.test(path));
    if (bypass) hatchNamedBypass += 1;
    if (attempt.invalidArgs || bypass) hatchMisuse += 1;
  }
  const programCalls = (name: string) =>
    (trial.saved?.world.programs ?? []).flatMap((p) => p.calls).filter((call) => call.name === name).length;
  const efficiency = trialEfficiency(trial);
  return {
    firstAttempts: seen.size,
    firstAttemptInvalidArgs,
    invalidArgs: attempts.filter((attempt) => attempt.invalidArgs).length,
    hatchCalls,
    hatchMisuse,
    hatchNamedBypass,
    searches:
      (trial.metrics.metaTools.search_tools ?? 0) +
      programCalls("connecta.search") +
      (trial.metrics.hostSearchCalls ?? 0),
    describes: programCalls("connecta.describe"),
    hatchDiscovery,
    guideFetches: efficiency.guideFetches,
    toolErrorsBeforeFirstSuccess: trial.metrics.toolErrorsBeforeFirstSuccess,
    totalTokens: efficiency.totalTokens,
    firstTurnInputTokens: efficiency.firstTurnInputTokens,
    responseBytes: efficiency.responseBytes,
  };
}

/** A load-related timeout or interruption is invalid, never a failure of the text. */
function invalidTrial(trial: TrialResult, runner: "codex" | "claude"): string | undefined {
  const { failures } = trialOutcome(trial, runner);
  if (failures.timeout) return "timeout";
  if (failures.interruption) return "interrupted";
  if (failures.runnerExit || failures.error) return trial.error ?? "runner error";
  return undefined;
}

/** Two-sided exact sign test over discordant pairs. */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (!n) return 1;
  const tail = Math.min(wins, losses);
  let choose = 1;
  let sum = 0;
  for (let k = 0; k <= tail; k += 1) {
    sum += choose;
    choose = (choose * (n - k)) / (k + 1);
  }
  return Math.min(1, (2 * sum) / 2 ** n);
}

const pairKey = (trial: TrialResult) => JSON.stringify([trial.model, trial.task, trial.repeat]);

export interface ArmRow {
  arm: string;
  runner: "codex" | "claude";
  surface: string;
  trials: number;
  invalid: Record<string, number>;
  passed: number;
  valid: number;
  duplicateWrites: number;
  firstAttempts: number;
  firstAttemptInvalidArgs: number;
  trialsWithFirstAttemptInvalidArgs: number;
  invalidArgs: number;
  errorsBeforeSuccess: number | undefined;
  hatchCalls: number;
  hatchMisuse: number;
  hatchNamedBypass: number;
  searches: number;
  describes: number;
  hatchDiscovery: number;
  guideFetches: number;
  medianTotalTokens: number | undefined;
  meanTotalTokens: number | undefined;
  medianFirstTurn: number | undefined;
  medianResponseBytes: number | undefined;
}

export function armRow(arm: string, file: AgentResultFile, trials: TrialResult[]): ArmRow {
  const runner = file.config.runner === "claude" ? "claude" : "codex";
  const valid = trials.filter((trial) => !invalidTrial(trial, runner));
  const metrics = valid.map(descriptionMetrics);
  const sum = (pick: (m: DescriptionMetrics) => number | undefined) =>
    metrics.reduce((total, m) => total + (pick(m) ?? 0), 0);
  const known = (pick: (m: DescriptionMetrics) => number | undefined) =>
    metrics.map(pick).filter((value): value is number => value !== undefined);
  const invalid: Record<string, number> = {};
  for (const trial of trials) {
    const reason = invalidTrial(trial, runner);
    if (reason) invalid[reason] = (invalid[reason] ?? 0) + 1;
  }
  return {
    arm,
    runner,
    surface: file.config.surface ?? "six",
    trials: trials.length,
    invalid,
    passed: valid.filter((trial) => trialOutcome(trial, runner).pass).length,
    valid: valid.length,
    duplicateWrites: valid.reduce((total, trial) => total + (trial.metrics.downstream.duplicateWrites ?? 0), 0),
    firstAttempts: sum((m) => m.firstAttempts),
    firstAttemptInvalidArgs: sum((m) => m.firstAttemptInvalidArgs),
    trialsWithFirstAttemptInvalidArgs: metrics.filter((m) => m.firstAttemptInvalidArgs > 0).length,
    invalidArgs: sum((m) => m.invalidArgs),
    errorsBeforeSuccess: known((m) => m.toolErrorsBeforeFirstSuccess).length
      ? sum((m) => m.toolErrorsBeforeFirstSuccess)
      : undefined,
    hatchCalls: sum((m) => m.hatchCalls),
    hatchMisuse: sum((m) => m.hatchMisuse),
    hatchNamedBypass: sum((m) => m.hatchNamedBypass),
    searches: sum((m) => m.searches),
    describes: sum((m) => m.describes),
    hatchDiscovery: sum((m) => m.hatchDiscovery),
    guideFetches: sum((m) => m.guideFetches),
    medianTotalTokens: median(known((m) => m.totalTokens)),
    meanTotalTokens: mean(known((m) => m.totalTokens)),
    medianFirstTurn: median(known((m) => m.firstTurnInputTokens)),
    medianResponseBytes: median(known((m) => m.responseBytes)),
  };
}

/** Pairs where both arms are valid, with who passed. */
export function pairedOutcomes(
  control: { file: AgentResultFile; trials: TrialResult[] },
  arm: { file: AgentResultFile; trials: TrialResult[] },
) {
  const runner = control.file.config.runner === "claude" ? "claude" : "codex";
  const right = new Map(arm.trials.map((trial) => [pairKey(trial), trial]));
  let pairs = 0,
    gains = 0,
    losses = 0,
    excluded = 0;
  const taskLosses: Record<string, number> = {};
  for (const trial of control.trials) {
    const other = right.get(pairKey(trial));
    if (!other) continue;
    if (invalidTrial(trial, runner) || invalidTrial(other, runner)) {
      excluded += 1;
      continue;
    }
    pairs += 1;
    const a = trialOutcome(trial, runner).pass,
      b = trialOutcome(other, runner).pass;
    if (a && !b) {
      losses += 1;
      taskLosses[trial.task] = (taskLosses[trial.task] ?? 0) + 1;
    }
    if (!a && b) gains += 1;
  }
  return { pairs, gains, losses, excluded, taskLosses, p: signTest(gains, losses) };
}

export function rowLine(row: ArmRow): string {
  const tokens = row.medianTotalTokens === undefined ? "N/A" : Math.round(row.medianTotalTokens).toString();
  const invalid = Object.entries(row.invalid)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
  return `${row.arm.padEnd(15)} ${row.runner.padEnd(7)} ${row.surface.padEnd(7)} pass ${row.passed}/${row.valid}${invalid ? ` (invalid: ${invalid})` : ""}; first-attempt invalid_args ${row.firstAttemptInvalidArgs}/${row.firstAttempts} tools in ${row.trialsWithFirstAttemptInvalidArgs} trials; all invalid_args ${row.invalidArgs}; errors before success ${row.errorsBeforeSuccess ?? "N/A"}; hatch misuse ${row.hatchMisuse}/${row.hatchCalls} (bypass ${row.hatchNamedBypass}); searches ${row.searches}; describes ${row.describes}; hatch discovery ${row.hatchDiscovery}; guide fetches ${row.guideFetches}; median total tokens ${tokens}; median first turn ${row.medianFirstTurn ?? "N/A"}; median response bytes ${row.medianResponseBytes ?? "N/A"}; duplicate writes ${row.duplicateWrites}`;
}

export function descriptionComparison(
  a: { arm: string; file: AgentResultFile; trials: TrialResult[] },
  b: { arm: string; file: AgentResultFile; trials: TrialResult[] },
): string {
  const paired = pairedOutcomes(a, b);
  return [
    `Description arms: ${a.arm} vs ${b.arm}; ${a.file.config.surface} surface; paired ${a.file.protocol!.pairId}; source ${a.file.meta.git.commit}; diagnostic only, see eval/description-plan.ts for the decision rule.`,
    rowLine(armRow(a.arm, a.file, a.trials)),
    rowLine(armRow(b.arm, b.file, b.trials)),
    `${b.arm} against ${a.arm}: ${paired.pairs} valid pairs (${paired.excluded} invalid excluded), ${paired.gains} gains, ${paired.losses} losses, sign test p=${paired.p.toFixed(3)}; losses by task ${JSON.stringify(paired.taskLosses)}.`,
  ].join("\n");
}
