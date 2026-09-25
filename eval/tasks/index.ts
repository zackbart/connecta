import { ARTIFACT_TASKS } from "./artifacts.js";
import { BASELINE_TASKS } from "./baseline.js";
import { PLANNED_TASKS } from "./planned.js";
import { RESUMABLE_TASKS } from "./resumable.js";
import type { ActiveTask, PlannedTask } from "./types.js";

export const ACTIVE_TASKS: ActiveTask[] = [...BASELINE_TASKS, ...RESUMABLE_TASKS, ...ARTIFACT_TASKS];
export const PLANNED: PlannedTask[] = PLANNED_TASKS;
