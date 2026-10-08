import { planningCenter } from "./index.js";
const options: Parameters<typeof planningCenter>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "planning-center",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof planningCenter>[1]> = {}) { return planningCenter(id, { ...options, ...overrides } as Parameters<typeof planningCenter>[1]); },
  conventions: {"verbs":["list","get","search","create","update","add","run","apply","schedule","pco"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
