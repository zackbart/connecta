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
    id: "p2-build-page",
    title: "Build a page from this data",
    introducedIn: "P2",
    measures: "Publishing an artifact whose data lands in stored documents rather than inline in the HTML.",
    prompt: "Build a page showing open bugs per project with each affected customer's MRR, and share the link in #triage.",
    sketch: {
      world: "tracker + analytics + chat; deployment option enables the artifacts slot with an in-memory store the adapter exposes to graders",
      grading: [
        "exactly one artifact created; its render check passes",
        "the artifact's data documents contain the per-project counts and MRR figures (not only the HTML)",
        "one #triage post carrying the artifact's URL",
      ],
    },
  },
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
  {
    status: "planned",
    id: "p2-fix-chart-title",
    title: "Fix the chart title",
    introducedIn: "P2",
    measures: "Editing an artifact with a patch rather than rewriting it.",
    prompt: "The chart title on the open-bugs page says 'Bugs by team'; it should say 'Open bugs by project'. Fix it.",
    sketch: {
      world: "seeded artifact with a known revision",
      grading: [
        "exactly one new revision, created by patch (not update/put of the whole page)",
        "the new revision differs from the old only in the title",
      ],
    },
  },
];
