/**
 * Tasks for surfaces that do not exist yet, written down so the phase that
 * builds the surface inherits its acceptance test. Documentation only: the
 * runner lists these in the report and never executes them. Promoting one is
 * a matter of turning its sketch into an `ActiveTask` — the world, fault,
 * approval, and follow-up hooks it names already exist.
 */
import type { PlannedTask } from "./types.js";

export const PLANNED_TASKS: PlannedTask[] = [
  {
    status: "planned",
    id: "p2-refresh-weekly",
    title: "Make it refresh weekly",
    introducedIn: "P2",
    measures: "Attaching a read-only refresh program to an existing artifact and proving it runs.",
    prompt: "Make the open-bugs page refresh every week.",
    sketch: {
      world: "as p2-build-page, seeded with an existing artifact; the follow-up hook calls the deployment's runDue() after moving tracker state",
      turns: ["set the refresh", "operator: advance the clock and run due refreshes; ask whether the page updated"],
      grading: [
        "set_refresh called once with a weekly schedule",
        "after runDue(), a new data version exists and reflects the changed tracker state",
        "the refresh program made only read-only downstream calls",
      ],
    },
  },
];
