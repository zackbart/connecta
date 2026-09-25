/**
 * Tasks for surfaces that do not exist yet, written down so the phase that
 * builds the surface inherits its acceptance test. Documentation only: the
 * runner lists these in the report and never executes them. Promoting one is
 * a matter of turning its sketch into an `ActiveTask` — the world, fault,
 * approval, and follow-up hooks it names already exist.
 */
import type { PlannedTask } from "./types.js";

export const PLANNED_TASKS: PlannedTask[] = [];
