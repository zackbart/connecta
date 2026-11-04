/**
 * Fixed before any trial ran; never select tasks from observed scores.
 * Every cell is both surfaces × both models × two repeats (eight trials).
 */
export const PREVIEW_TASKS = [
  "tithely-recurring-join",
  "truncated-read-paging",
  "cross-connector-join",
  "overflow-donor-paging",
  "stripe-step2-decline-join",
  "breeze-attendance-join",
  "pco-step2-plan-join",
  "google-sheets-3",
  "vercel-step2-bounded-logs",
  "github-repository-pr-join",
] as const;
/**
 * The lean arm fires on these because their fakes return real nulls. The fakes
 * hold too few nulls to measure lean's saving; this cell only tests for harm.
 * pco-step2-plan-join's control comes from PREVIEW_TASKS.
 */
export const LEAN_TASKS = ["pco-step2-plan-join", "cloudflare-step2-dns-recovery"] as const;
/** Run only if infrastructure reruns leave room: control and preview. */
export const SPARE_TASK = "p5-result-paging";
export const DECISION_RULE =
  "Ship a presentation rule only if it loses no outcome passes on fixed tasks, adds no duplicate writes or tool-error growth, and cuts total tokens where it fires. Inconclusive otherwise. Null-omission savings are measured on real logs, not fakes.";
