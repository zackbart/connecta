import { BASELINE_TASKS } from "./baseline.js";
import { PLANNED_TASKS } from "./planned.js";
import type { ActiveTask, PlannedTask } from "./types.js";
import { withCorrectness, EXISTING_CORRECTNESS } from "./correctness.js";
import { REST_TASKS } from "./rest.js";
import { P5_TASKS } from "./p5.js";

/** The 19-task scope registered for the #765 paired experiment stays fixed. */
export const COMPARISON_TASKS: ActiveTask[] = [
  ...BASELINE_TASKS.map((task) => withCorrectness(task, EXISTING_CORRECTNESS[task.id]!)),
  ...P5_TASKS,
];
export const ACTIVE_TASKS: ActiveTask[] = [...COMPARISON_TASKS, ...REST_TASKS];
export const PLANNED: PlannedTask[] = PLANNED_TASKS;
