import { gmail } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof gmail>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "gmail",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof gmail>[1]> = {}) { return gmail(id, { ...options, ...overrides } as Parameters<typeof gmail>[1]); },
  assertSmoke(connector: ReturnType<typeof gmail>) {
    if (connector.staticTools?.some((tool) => /send/.test(tool.name))) throw new Error("Gmail provider published a send tool");
  },
  conventions: {"verbs":["search","list","get","create","update"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
