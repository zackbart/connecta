/**
 * The presentation experiments, fixed before any trial is scored. Never select
 * tasks or arms from observed scores. `eval:presentation --run` executes this
 * plan; `eval:presentation` reports on it.
 */
import type { PresentationArm } from "./deploy/presentation.js";

export interface PresentationExperiment {
  control: PresentationArm;
  treatments: PresentationArm[];
  tasks: string[];
  /** Reuse another experiment's control batch, whose task set covers this one. */
  controlFrom?: string;
  question: string;
}

export const PRESENTATION_PLAN = {
  target: "worker",
  catalogTools: 300,
  surface: "six",
  grading: "outcome",
  repeats: 2,
  concurrency: 2,
  models: { claude: "claude-sonnet-5-5", codex: "gpt-6.1-sol" },
  experiments: {
    schema: {
      control: "control",
      treatments: ["schema-compact", "schema-typescript", "schema-json"],
      tasks: [
        "cross-connector-join",
        "stripe-step2-filtered-customers",
        "github-filtered-issues",
        "discovery-write-rollback",
        "discovery-join-unnamed",
      ],
      question: "Which schema format gives the fewest wrong arguments per byte?",
    },
    output: {
      control: "control",
      controlFrom: "schema",
      treatments: ["output-slim", "output-none"],
      tasks: ["cross-connector-join", "stripe-step2-filtered-customers"],
      question: "Does a slimmer or absent outputSchema change outcomes, and what does it save per host?",
    },
    connectors: {
      control: "connectors-id",
      treatments: ["connectors-purpose"],
      tasks: ["lookalike-production-refund", "lookalike-enterprise-renewal", "discovery-lookalike-crm"],
      question: "Does a one-line purpose reduce wrong-connector calls among look-alikes?",
    },
    clones: {
      control: "control",
      treatments: ["clones-collapsed"],
      tasks: ["clones-tenant-read", "clones-all-tenants", "clones-tenant-write"],
      question: "Does collapsing exact clones in unscoped search help without wrong-tenant calls?",
    },
  } satisfies Record<string, PresentationExperiment>,
};

export type ExperimentId = keyof typeof PRESENTATION_PLAN.experiments;

export interface PlannedBatch {
  id: string;
  experiment: ExperimentId;
  arm: PresentationArm;
  tasks: string[];
}

/** One batch per arm per experiment. Runners take arms in opposite orders to spread time-of-day effects. */
export function plannedBatches(reverse = false, only?: ExperimentId[]): PlannedBatch[] {
  const experiments = PRESENTATION_PLAN.experiments as Record<ExperimentId, PresentationExperiment>;
  return (Object.keys(experiments) as ExperimentId[])
    .filter((id) => !only || only.includes(id))
    .flatMap((experiment) => {
      const { control, treatments, tasks, controlFrom } = experiments[experiment];
      const arms = [...(controlFrom ? [] : [control]), ...treatments];
      return (reverse ? arms.reverse() : arms).map((arm) => ({ id: `${experiment}-${arm}`, experiment, arm, tasks }));
    });
}
