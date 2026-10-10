import { vercel } from "./index.js";
type Options = Parameters<typeof vercel>[1];
// The token connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"token"} };
export const fixture = {
  name: "vercel",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"team","options":{"teamId":"team_fixture"}},{"label":"oauth","options":{"auth":{"type":"oauth"}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    // OAuth takes no team or base URL, so its case starts from the common options alone.
    const base: Partial<Options> = overrides.auth?.type === "oauth" ? { purpose: options.purpose } : options;
    return vercel(id, { ...base, ...overrides } as Options);
  },
  conventions: {"verbs":["list","get","upsert","update","delete","vercel"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
