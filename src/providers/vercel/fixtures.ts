import { vercel } from "./index.js";
type Options = Parameters<typeof vercel>[1];
// The token connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
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
