import { breeze } from "./index.js";
const options: Parameters<typeof breeze>[1] = { "purpose":"Audit fixture","subdomain":"gracechurch" };
export const fixture = {
  name: "breeze",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof breeze>[1]> = {}) { return breeze(id, { ...options, ...overrides } as Parameters<typeof breeze>[1]); },
  conventions: {"verbs":["list","get","add","update","assign","unassign","record","breeze"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
