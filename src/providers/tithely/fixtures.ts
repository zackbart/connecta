import { tithely } from "./index.js";
const options: Parameters<typeof tithely>[1] = { "purpose":"Audit fixture","environment":"live" };
export const fixture = {
  name: "tithely",
  options,
  cases: [{"label":"default","options":{}},{"label":"test","options":{"environment":"test"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof tithely>[1]> = {}) { return tithely(id, { ...options, ...overrides } as Parameters<typeof tithely>[1]); },
  conventions: {"verbs":["list","get","tithely"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
