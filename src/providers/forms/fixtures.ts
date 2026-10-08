import { forms } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof forms>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "forms",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof forms>[1]> = {}) { return forms(id, { ...options, ...overrides } as Parameters<typeof forms>[1]); },
  conventions: {"verbs":["get","list","create","update","batch"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
