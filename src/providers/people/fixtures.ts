import { people } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof people>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "people",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"sensitive-returned","options":{"sensitiveFields":"return"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof people>[1]> = {}) { return people(id, { ...options, ...overrides } as Parameters<typeof people>[1]); },
  conventions: {"verbs":["search","list","get","create","update","delete","copy"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};

export const createAuthored = () => fixture.create();
