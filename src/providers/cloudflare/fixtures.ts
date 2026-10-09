import { cloudflare } from "./index.js";
type Options = Parameters<typeof cloudflare>[1];
// The API-token REST connector is the default: its tools are Connecta's own,
// so the hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"apiToken"} };
export const fixture = {
  name: "cloudflare",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"pinned","options":{"accountId":"acct-fixture","pin":{"accountIds":["acct-fixture"]}}},{"label":"global-key","options":{"auth":{"type":"globalApiKey"},"pin":{"zoneIds":["zone-fixture"]}}},{"label":"oauth","options":{"auth":{"type":"oauth"}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    // OAuth takes no REST options, so its case starts from the common options alone.
    const base: Partial<Options> = overrides.auth?.type === "oauth" ? { purpose: options.purpose } : options;
    return cloudflare(id, { ...base, ...overrides } as Options);
  },
  conventions: {"verbs":["verify","list","graphql","cloudflare"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
