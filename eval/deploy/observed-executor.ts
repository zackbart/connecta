/** The Node deployment's QuickJS executor, observed. */
import { quickJsExecutor } from "@zackbart/connecta/quickjs";
import type { Surface } from "../agent/surface.js";
import { observePrograms } from "./observe.js";

export type { ProgramObservation } from "./observe.js";

export function observedExecutor(surface: Surface = "six") {
  return observePrograms(quickJsExecutor(), surface);
}
