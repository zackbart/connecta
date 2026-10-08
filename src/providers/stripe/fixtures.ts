import { stripe } from "./index.js";
const options: Parameters<typeof stripe>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "stripe",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"empty-title","options":{"title":""}},{"label":"blank-title","options":{"title":" "}},{"label":"default","options":{}},{"label":"production","options":{"mode":"production","auth":{"type":"headers","headers":{"Authorization":"Bearer rk_live_fixture"}}}},{"label":"sandbox","options":{"mode":"sandbox","auth":{"type":"headers","headers":{"Authorization":"Bearer rk_test_fixture"}}}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof stripe>[1]> = {}) { return stripe(id, { ...options, ...overrides } as Parameters<typeof stripe>[1]); },
  conventions: undefined,
};
