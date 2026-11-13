import { calendar } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof calendar>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "calendar",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof calendar>[1]> = {}) { return calendar(id, { ...options, ...overrides } as Parameters<typeof calendar>[1]); },
  conventions: {"verbs":["list","get","query","create","quick","update","respond","move","delete"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};

export const createAuthored = () => fixture.create();
