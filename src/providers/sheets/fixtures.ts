import { sheets } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof sheets>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "sheets",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof sheets>[1]> = {}) { return sheets(id, { ...options, ...overrides } as Parameters<typeof sheets>[1]); },
  conventions: {"verbs":["get","create","add","append","update","clear","batch"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
