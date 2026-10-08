import { basecamp } from "./index.js";
const options: Parameters<typeof basecamp>[1] = { "purpose":"Audit fixture","clientMetadataUrl":"https://connecta.example/oauth/basecamp-client" };
export const fixture = {
  name: "basecamp",
  options,
  cases: [{"label":"default","options":{}},{"label":"personal","options":{"authScope":"personal"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof basecamp>[1]> = {}) { return basecamp(id, { ...options, ...overrides } as Parameters<typeof basecamp>[1]); },
  conventions: undefined,
};
