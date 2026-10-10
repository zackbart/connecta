import { notion } from "./index.js";
type Options = Parameters<typeof notion>[1];
// The token connector is the default: its tools are Connecta's own, so the
// hand-written conventions apply to it. The OAuth case reaches hosted MCP.
const options: Options = { "purpose":"Audit fixture", "auth":{"type":"token"} };
export const fixture = {
  name: "notion",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}},{"label":"oauth","options":{"auth":{"type":"oauth"}}}],
  create(id = "fixture", overrides: Partial<Options> = {}) { return notion(id, { ...options, ...overrides } as Options); },
  conventions: {"verbs":["integration","notion"],"nestedDescriptionExceptions":[],"auth":"credential"},
};
