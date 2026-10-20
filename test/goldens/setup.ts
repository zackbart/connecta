import { expect } from "vitest";
import { installSources } from "./sources.js";

// A per-file setup runs before the suite's module graph is evaluated. Other
// suites never install dispatchers; golden suites leave the runner on native
// timing whenever a scenario is not active.
if (/\/(?:goldens|goldens-harness)\.test\.ts$/.test(expect.getState().testPath ?? "")) installSources();
