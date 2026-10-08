import { revenuecat } from "./index.js";
const options: Parameters<typeof revenuecat>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "revenuecat",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof revenuecat>[1]> = {}) { return revenuecat(id, { ...options, ...overrides } as Parameters<typeof revenuecat>[1]); },
  conventions: undefined,
};
