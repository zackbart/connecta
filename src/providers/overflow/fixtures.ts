import { overflow } from "./index.js";
const options: Parameters<typeof overflow>[1] = { "purpose":"Audit fixture","environment":"production" };
export const fixture = {
  name: "overflow",
  options,
  cases: [{"label":"default","options":{}},{"label":"staging","options":{"environment":"staging"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof overflow>[1]> = {}) { return overflow(id, { ...options, ...overrides } as Parameters<typeof overflow>[1]); },
  conventions: {"verbs":["list","get","overflow"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
