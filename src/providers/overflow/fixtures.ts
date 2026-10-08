import { overflow } from "./index.js";
const options: Parameters<typeof overflow>[1] = { "purpose":"Audit fixture","environment":"production" };
export const fixture = {
  name: "overflow",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}},{"label":"staging","options":{"environment":"staging"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof overflow>[1]> = {}) { return overflow(id, { ...options, ...overrides } as Parameters<typeof overflow>[1]); },
  conventions: {"verbs":["list","get","overflow"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
