import { meet } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof meet>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "meet",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof meet>[1]> = {}) { return meet(id, { ...options, ...overrides } as Parameters<typeof meet>[1]); },
  conventions: {"verbs":["get","list","create","update","end"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};

export const createAuthored = () => fixture.create();
