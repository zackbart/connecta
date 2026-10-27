import { granola, type GranolaOptions } from "./index.js";
const options: GranolaOptions = { purpose: "Workspace meeting notes fixture" };
export const fixture = {
  name: "granola", options,
  cases: [{ label: "padded-purpose", options: { purpose: "  Workspace notes  " } }],
  create(id = "fixture", overrides: Partial<GranolaOptions> = {}) { return granola(id, { ...options, ...overrides }); },
  conventions: { verbs: ["granola"], nestedDescriptionExceptions: [], auth: "credential" },
};
export const createAuthored = () => fixture.create();
