/**
 * Fixed before any description-arm trial; never select tasks from observed
 * scores. `eval/report/descriptions.ts` reads these rules; it does not tune them.
 *
 * Budget: 200 paid trials. Stage A is 4 arms x 9 tasks x 2 hosts x 2 repeats =
 * 144. Stage B is planned as 2 arms x 6 tasks x 2 hosts x 2 repeats = 48. Eight remain
 * for a runner pilot. A load-related timeout is invalid: it stays in the result
 * file, is reported, and removes its pair from pass comparisons. It is not rerun.
 *
 * Deviation, recorded after Stage A and before Stage B: `quickbooks-write-journey`
 * failed all 15 valid trials on every arm and host, so it cannot separate arms.
 * Its prompt omits the invoice details, and a scripted turn makes the endpoint
 * read-only before an agent that asks for them can write. The scripted reference
 * passes. It stays in Stage A's results, reported as non-discriminating, and was
 * removed from Stage B, leaving 5 tasks and 40 trials. Removal did not depend on
 * any difference between arms. Paid total: 2 pilot + 144 + 40 = 186.
 */
export const DESCRIPTION_PLAN = {
  budget: 200,
  target: "worker",
  catalogTools: 300,
  grading: "outcome",
  repeats: 2,
  concurrency: 3,
  hosts: [
    { runner: "claude", model: "claude-sonnet-5-5" },
    { runner: "codex", model: "gpt-6.1-sol" },
  ],
  stageA: {
    surface: "six",
    arms: ["control", "terse", "disambiguation", "example"],
    tasks: [
      { id: "stripe-step2-filtered-customers", provider: "stripe", exercises: ["filtering", "hatch read"] },
      { id: "stripe-step2-refund-recovery", provider: "stripe", exercises: ["hatch write", "recovery"] },
      { id: "cloudflare-step2-account-zone-join", provider: "cloudflare", exercises: ["join"] },
      { id: "cloudflare-step2-kv-hatch", provider: "cloudflare", exercises: ["hatch read", "paging"] },
      { id: "github-release-once", provider: "github", exercises: ["hatch write"] },
      { id: "ccb-family-group-join", provider: "ccb", exercises: ["join", "named reads"] },
      { id: "ccb-update-recovery", provider: "ccb", exercises: ["hatch write", "recovery"] },
      { id: "quickbooks-write-journey", provider: "quickbooks", exercises: ["named writes", "recovery"] },
      { id: "google-sheets-4", provider: "sheets", exercises: ["hatch read", "structural write"] },
    ],
  },
  /** Control against the one arm Stage A's rule selects; skipped when none is eligible. */
  stageB: {
    surface: "native",
    arms: ["control", "<selected by stage A>"],
    tasks: [
      "stripe-step2-refund-recovery",
      "cloudflare-step2-kv-hatch",
      "github-release-once",
      "ccb-family-group-join",
      "google-sheets-4",
    ],
  },
} as const;

/**
 * Evaluated per host against control, on valid pairs. Nine tasks by two repeats
 * is 18 pairs per host, so a five-point margin is one trial: this rule can only
 * reject a large loss, and an arm passing it is not proven equal to control.
 */
export const DESCRIPTION_DECISION_RULE =
  "An arm is eligible only if it is valid (every protected clause survives) and, on each host: its pass count is within 1 of control; it adds no duplicate write; it fails no write-safety check control passed on the same pair; no task drops by 3 or more of its 4 pairs across hosts; and it adds at most 2 first-attempt invalid_args over control. Among eligible arms choose the fewest served bytes on native. If no arm is eligible, today's text stands. If an arm is eligible but differs from control by fewer discordant pairs than a two-sided exact sign test can separate at 18 pairs (fewer than 6 discordant pairs, all one way), report its quality as inconclusive and justify it on bytes alone.";
