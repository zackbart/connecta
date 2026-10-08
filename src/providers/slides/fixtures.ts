import { slides } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof slides>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "slides",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof slides>[1]> = {}) { return slides(id, { ...options, ...overrides } as Parameters<typeof slides>[1]); },
  conventions: {"verbs":["get","list","create","replace","update","delete","batch"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
