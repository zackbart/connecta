import { vercel } from "./index.js";
type Options = Parameters<typeof vercel>[1];
// Offline token-authenticated authored tools; hosted MCP uses a generic connection.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"token"} };
export const fixture = {
  name: "vercel",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"team","options":{"teamId":"team_fixture"}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    return vercel(id, { ...options, ...overrides } as Options);
  },
  conventions: {"verbs":["list","get","upsert","update","delete","vercel"],"nestedDescriptionExceptions":[],"auth":"credential"},
};

export const createAuthored = () => fixture.create();
