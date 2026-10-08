import { vercel } from "./index.js";
const options: Parameters<typeof vercel>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "vercel",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"mcp","options":{"surface":"mcp"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof vercel>[1]> = {}) { return vercel(id, { ...options, ...overrides } as Parameters<typeof vercel>[1]); },
  conventions: {"verbs":["list","get","add","verify","remove","upsert","update","delete","promote","cancel","vercel"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
