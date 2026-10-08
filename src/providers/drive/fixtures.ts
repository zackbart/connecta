import { drive } from "./index.js";
import { googleOptions } from "../../../test/fixtures/provider-options.js";
const options: Parameters<typeof drive>[1] = { "purpose":"Audit fixture", ...googleOptions };
export const fixture = {
  name: "drive",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof drive>[1]> = {}) { return drive(id, { ...options, ...overrides } as Parameters<typeof drive>[1]); },
  assertSmoke(connector: ReturnType<typeof drive>) {
    if (connector.staticTools?.some((tool) => /^(delete_file|empty_trash|transfer)/.test(tool.name))) throw new Error("Google Drive provider published a permanent delete or ownership transfer");
  },
  conventions: {"verbs":["search","list","get","create","update","move","copy","trash","restore","share","delete"],"nestedDescriptionExceptions":[],"auth":"delegated"},
};
