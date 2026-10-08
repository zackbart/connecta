import { ARTIFACT_TASKS } from "./artifacts.js";
import { BASELINE_TASKS } from "./baseline.js";
import { PLANNED_TASKS } from "./planned.js";
import type { ActiveTask, PlannedTask } from "./types.js";
import { withCorrectness, EXISTING_CORRECTNESS } from "./correctness.js";
import { P5_TASKS } from "./p5.js";

export const ACTIVE_TASKS: ActiveTask[] = [
  ...[...BASELINE_TASKS, ...ARTIFACT_TASKS].map(task => withCorrectness(task, EXISTING_CORRECTNESS[task.id]!)),
  ...P5_TASKS,
];
export const PLANNED: PlannedTask[] = PLANNED_TASKS;
