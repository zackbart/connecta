import { mixpanel } from "./index.js";
const options: Parameters<typeof mixpanel>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "mixpanel",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"eu","options":{"region":"eu"}},{"label":"in","options":{"region":"in"}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof mixpanel>[1]> = {}) { return mixpanel(id, { ...options, ...overrides } as Parameters<typeof mixpanel>[1]); },
  conventions: undefined,
};
