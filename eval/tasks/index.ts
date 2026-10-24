import { BASELINE_TASKS } from "./baseline.js";
import { PLANNED_TASKS } from "./planned.js";
import type { ActiveTask, PlannedTask } from "./types.js";
import { withCorrectness, EXISTING_CORRECTNESS } from "./correctness.js";
import { REST_TASKS } from "./rest.js";
import { P5_TASKS } from "./p5.js";
import { CCB_TASKS } from "./ccb.js";
import { PLANNING_CENTER_TASKS } from "./planning-center.js";
import { OVERFLOW_TASKS } from "./overflow.js";
import { BREEZE_TASKS } from "./breeze.js";
import { TITHELY_TASKS } from "./tithely.js";
import { VERCEL_TASKS } from "./vercel.js";
import { STRIPE_TASKS } from "./stripe.js";

/** Retained tasks from the historical 19-task #765 paired experiment. */
export const COMPARISON_TASKS: ActiveTask[] = [
  ...BASELINE_TASKS.map((task) => withCorrectness(task, EXISTING_CORRECTNESS[task.id]!)),
  ...P5_TASKS,
];
export const ACTIVE_TASKS: ActiveTask[] = [
  ...COMPARISON_TASKS,
  ...REST_TASKS,
  ...TITHELY_TASKS,
  ...BREEZE_TASKS,
  ...OVERFLOW_TASKS,
  ...STRIPE_TASKS,
  ...VERCEL_TASKS,

  ...CCB_TASKS,
  ...PLANNING_CENTER_TASKS,
];
export const PLANNED: PlannedTask[] = PLANNED_TASKS;
