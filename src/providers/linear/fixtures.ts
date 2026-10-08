import { linear } from "./index.js";
const options: Parameters<typeof linear>[1] = { "purpose":"Audit fixture","access":"read-write" };
export const fixture = {
  name: "linear",
  options,
  cases: [{"label":"default","options":{}},{"label":"read-only","options":{"access":"read-only"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof linear>[1]> = {}) { return linear(id, { ...options, ...overrides } as Parameters<typeof linear>[1]); },
  conventions: undefined,
};
