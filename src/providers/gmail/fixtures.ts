import { gmail } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof gmail>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "gmail",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof gmail>[1]> = {}) { return gmail(id, { ...options, ...overrides } as Parameters<typeof gmail>[1]); },
  conventions: {"verbs":["search","list","get","create","update"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
