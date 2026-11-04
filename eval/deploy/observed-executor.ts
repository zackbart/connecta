/** The Node deployment's QuickJS executor, observed. */
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import type { Surface } from "../agent/surface.js";
import { observePrograms } from "./observe.js";
import type { StepRuntime } from "./step-arms.js";

export type { ProgramObservation } from "./observe.js";

export function observedExecutor(surface: Surface = "six", step?: StepRuntime) {
  return observePrograms(quickJsExecutor(), surface, step);
}
