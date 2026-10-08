import { docs } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof docs>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "docs",
  options,
  cases: [{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof docs>[1]> = {}) { return docs(id, { ...options, ...overrides } as Parameters<typeof docs>[1]); },
  conventions: {"verbs":["get","create","append","insert","replace","batch"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
