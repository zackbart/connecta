import { notion } from "./index.js";
const options: Parameters<typeof notion>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "notion",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"mcp","options":{"surface":"mcp"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof notion>[1]> = {}) { return notion(id, { ...options, ...overrides } as Parameters<typeof notion>[1]); },
  conventions: {"verbs":["list","get","search","create","update","delete","add","append","query","trash"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
