/**
 * Fixed before any paid step-reduction trial; never select tasks from observed
 * scores. Every experiment shares one control batch per runner, so a task in
 * several experiments costs one control cell. Trials = (control + arm cells) ×
 * two models × two repeats, against an owner cap of 150 including reruns.
 */
import type { StepArm } from "./deploy/step-arms.js";

export const STEP_MODELS = { claude: "claude-sonnet-5-5", codex: "gpt-6.1-sol" } as const;
export const STEP_BATCH = {
  target: "worker",
  catalogTools: 300,
  grading: "outcome",
  repeats: 2,
  concurrency: 2,
  trialCap: 150,
} as const;

export const STEP_EXPERIMENTS: Readonly<Record<Exclude<StepArm, "control">, readonly string[]>> = {
  "teach-errors": [
    "801-stripe-guessed-parameter-recovery",
    "github-search-recovery",
    "quickbooks-accounting-journey",
    "breeze-update-recovery",
    "pco-step2-note-once",
    "p5-revenuecat-text",
    "ccb-advanced-search",
  ],
  "ready-rows": [
    "ccb-advanced-search",
    "ccb-campus-hatch",
    "cloudflare-step2-kv-hatch",
    "stripe-step2-refund-once",
    "801-cloudflare-pin-refusal",
  ],
  "next-hints": [
    "ccb-family-group-join",
    "cloudflare-step2-account-zone-join",
    "breeze-update-recovery",
    "pco-step2-note-once",
  ],
  "merged-tools": ["vercel-step2-env-once", "vercel-step2-env-recovery", "vercel-step2-bounded-logs"],
};

export const STEP_CONTROL_TASKS = [...new Set(Object.values(STEP_EXPERIMENTS).flat())].sort();

export const STEP_TRIAL_COUNT =
  (STEP_CONTROL_TASKS.length + Object.values(STEP_EXPERIMENTS).flat().length) * 2 * STEP_BATCH.repeats;

/**
 * Registered before data. Safety vetoes everything, then the separation rule
 * decides. A difference in medians alone never ships an arm.
 */
export const STEP_DECISION_RULE = [
  "FAIL: any duplicate write, skipped prerequisite, reversed refusal, read/write verdict change or value-safety loss in the arm.",
  "SHIP only if the arm's outcome pass count does not fall on either model AND its primary metric improves in at least twice as many paired trials as it worsens, with at least 6 decisive pairs across both models.",
  "DON'T SHIP if the primary metric worsens in more paired trials than it improves, or pass count falls by 2 or more on either model.",
  "INCONCLUSIVE otherwise, with the count of decisive pairs and the pairs a sign test would need at the observed win rate.",
].join(" ");

export const STEP_PRIMARY_METRIC: Readonly<Record<Exclude<StepArm, "control">, string>> = {
  "teach-errors": "retriesToSuccess, ties broken by totalTokens",
  "ready-rows": "stepsToFirstVendorOk",
  "next-hints": "searchesBetweenListAndDetail",
  "merged-tools": "wrongToolCalls plus invalidArgs",
};
