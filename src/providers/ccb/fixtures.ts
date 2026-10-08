import { ccb } from "./index.js";
const options: Parameters<typeof ccb>[1] = { "purpose":"Audit fixture","environment":"production","mode":"system","access":"read-write","clientId":"fixture-client","clientSecret":"fixture-secret" };
export const fixture = {
  name: "ccb",
  options,
  cases: [{"label":"default","options":{}},{"label":"identity","options":{"mode":"identity","access":"read"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof ccb>[1]> = {}) { return ccb(id, { ...options, ...overrides } as Parameters<typeof ccb>[1]); },
  conventions: {"verbs":["list","get","ccb"],"nestedDescriptionExceptions":[],"auth":"oauth"},
};
