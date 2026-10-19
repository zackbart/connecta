import capturedCatalog from "./catalog.fixture.json";
import type { ToolDef } from "../../types.js";
import { linear } from "./index.js";
const options: Parameters<typeof linear>[1] = { "purpose":"Audit fixture","access":"read-write" };
export const fixture = {
  name: "linear",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"read-only","options":{"access":"read-only"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof linear>[1]> = {}) { return linear(id, { ...options, ...overrides } as Parameters<typeof linear>[1]); },
  conventions: undefined,
};

// Complete JSON schemas observed through credentialed discovery on 2026-10-19.
// Test evidence only: runtime schemas remain owned by hosted tools/list.
export const hostedCatalog: readonly ToolDef[] = capturedCatalog;
