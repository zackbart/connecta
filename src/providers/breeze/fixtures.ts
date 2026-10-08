import { breeze } from "./index.js";
const options: Parameters<typeof breeze>[1] = { "purpose":"Audit fixture","subdomain":"gracechurch" };
export const fixture = {
  name: "breeze",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof breeze>[1]> = {}) { return breeze(id, { ...options, ...overrides } as Parameters<typeof breeze>[1]); },
  conventions: {"verbs":["list","get","add","update","assign","unassign","record","breeze"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
