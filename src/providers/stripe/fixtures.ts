import { stripe } from "./index.js";
type Options = Parameters<typeof stripe>[1];
// The REST connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"apiKey"}, "mode":"sandbox" };
export const fixture = {
  name: "stripe",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"production","options":{"mode":"production"}},{"label":"connect","options":{"mode":"production","connectedAccount":"acct_fixture"}}],
  create(id = "fixture", overrides: Partial<Options> = {}) {
    return stripe(id, { ...options, ...overrides } as Options);
  },
  conventions: {"verbs":["get","stripe"],"nestedDescriptionExceptions":[],"auth":"credential"},
};

export const createAuthored = () => fixture.create();
