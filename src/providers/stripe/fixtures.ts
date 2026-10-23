import { stripe } from "./index.js";
type Options = Parameters<typeof stripe>[1];
// The API-key connector exposes Connecta-authored tools; the legacy
// hosted selector is a construction-time migration error.
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
