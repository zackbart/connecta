import { notion } from "./index.js";
type Options = Parameters<typeof notion>[1];
// The maintained token connector exposes every Connecta-authored API tool offline.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"token"} };
export const fixture = {
  name: "notion",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"business-admission","options":{"callAdmission":{"rules":[{"budget":{"kind":"rolling-window","maxCalls":600,"windowMs":60000}}]}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) { return notion(id, { ...options, ...overrides } as Options); },
  conventions: {"verbs":["integration","notion"],"nestedDescriptionExceptions":[],"auth":"credential"},
};

export const createAuthored = () => fixture.create();
