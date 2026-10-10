import { stripe } from "./index.js";
type Options = Parameters<typeof stripe>[1];
// The REST connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"apiKey"}, "mode":"sandbox" };
export const fixture = {
  name: "stripe",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"production","options":{"mode":"production"}},{"label":"connect","options":{"mode":"production","connectedAccount":"acct_fixture"}},{"label":"oauth","options":{"auth":{"type":"oauth"}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    // OAuth takes no mode, so its case starts from the common options alone.
    const base: Partial<Options> = overrides.auth?.type === "oauth" ? { purpose: options.purpose } : options;
    return stripe(id, { ...base, ...overrides } as Options);
  },
  conventions: {"verbs":["get","stripe"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
