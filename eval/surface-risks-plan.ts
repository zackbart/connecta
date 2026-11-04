/**
 * The surface-risk experiments, fixed before any score was seen. Change only by
 * adding a new plan with its reason; never reselect tasks from results.
 *
 * Budget: 197 paid trials of the 200 allowed, leaving 3 for invalid trials. `E5`
 * and the prompt-allow batch use one repeat, not two, because two repeats
 * everywhere would exceed the budget.
 *
 * One revision, made while read-arm scores were partial. 14 trials ran with
 * read-arm text that told agents "Everything else: execute_code" and sent paging
 * to the wrong route; they are retained as a separate diagnostic and excluded.
 * To pay for rerunning them, E3 drops `para-tell-room`, whose queries already
 * rank first on both arms in eval/search-rank.ts, and the pinned arm uses one
 * repeat because it exists to size tokens. No other task or arm changed.
 */
export interface SurfaceBatch {
  id: string;
  experiment: "E1-allow" | "E1-deny" | "E3" | "E4" | "E5";
  runner: "claude" | "codex";
  surface: string;
  approval?: "prompt-allow" | "prompt-deny";
  catalogTools: number;
  tasks: readonly string[];
  repeats: number;
  noToolSearch?: boolean;
}

export const MODELS = { claude: "claude-sonnet-5-5", codex: "gpt-6.1-sol" } as const;
export const MAX_PAID_TRIALS = 200;

/** A known read, a discovery read, a program-only read and a join ending in one write. */
const E1_TASKS = ["p5-known-read-routing", "p5-revenuecat-text", "p5-result-paging", "cross-connector-join"] as const;
const E1_ARMS = ["six", "five", "native", "read-six", "read-five"] as const;
/** Everyday wording; the hints in eval/fakes/search-hints.ts never saw these prompts. */
const E3_TASKS = ["para-green-build", "para-who-owes", "para-mark-done"] as const;
const E4_TASKS = ["p5-known-read-routing", "p5-revenuecat-text", "cross-connector-join"] as const;
const E5_TASKS = ["p5-revenuecat-text", "cross-connector-join"] as const;

export const SURFACE_BATCHES: SurfaceBatch[] = [
  ...(["claude", "codex"] as const).flatMap((runner) =>
    E1_ARMS.flatMap((surface): SurfaceBatch[] => [
      {
        id: `e1-deny-${runner}-${surface}`,
        experiment: "E1-deny",
        runner,
        surface,
        approval: "prompt-deny",
        catalogTools: 300,
        tasks: E1_TASKS,
        repeats: 2,
      },
      {
        id: `e1-allow-${runner}-${surface}`,
        experiment: "E1-allow",
        runner,
        surface,
        approval: "prompt-allow",
        catalogTools: 300,
        tasks: E1_TASKS,
        repeats: 1,
      },
    ]),
  ),
  ...(["native", "native-hints"] as const).map((surface): SurfaceBatch => ({
    id: `e3-claude-${surface}`,
    experiment: "E3",
    runner: "claude",
    surface,
    catalogTools: 300,
    tasks: E3_TASKS,
    repeats: 2,
  })),
  ...(["six", "native", "pinned"] as const).map((surface): SurfaceBatch => ({
    id: `e4-claude-${surface}-no-search`,
    experiment: "E4",
    runner: "claude",
    surface,
    catalogTools: 500,
    tasks: E4_TASKS,
    repeats: surface === "pinned" ? 1 : 2,
    noToolSearch: true,
  })),
  ...(["claude", "codex"] as const).flatMap((runner) =>
    [50, 150, 500].flatMap((catalogTools) =>
      (["six", "five", "native"] as const).map((surface): SurfaceBatch => ({
        id: `e5-${runner}-${surface}-${catalogTools}`,
        experiment: "E5",
        runner,
        surface,
        catalogTools,
        tasks: E5_TASKS,
        repeats: 1,
      })),
    ),
  ),
];

export function batchTrials(batch: SurfaceBatch): number {
  return batch.tasks.length * batch.repeats;
}

/** Trials spent on the retired read-arm text; they count against the budget. */
export const RETIRED_TRIALS = 14;

export function plannedTrials(): number {
  return SURFACE_BATCHES.reduce((sum, batch) => sum + batchTrials(batch), RETIRED_TRIALS);
}
