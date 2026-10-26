import { planningCenter } from "./index.js";
import { PLANNING_CENTER_APPS } from "./lib/constants.js";
const options: Parameters<typeof planningCenter>[1] = { "purpose":"Audit fixture" };
export const fixture = {
  name: "planning-center",
  options,
  cases: [{"label":"padded-purpose","options":{"purpose":"  Audit fixture  "}},{"label":"default","options":{}}],
  create(id = "fixture", overrides: Partial<Parameters<typeof planningCenter>[1]> = {}) { return planningCenter(id, { ...options, ...overrides } as Parameters<typeof planningCenter>[1]); },
  conventions: {"verbs":["list","get","search","create","update","add","run","apply","schedule","pco"],"nestedDescriptionExceptions":[],"auth":"credential"},
};

export const createAuthored = () => fixture.create();

/** Derive app ownership from actual configured catalogs; never duplicate tool lists. */
export const conventionToolBlocks = /* @__PURE__ */ (() => {
  const full = createAuthored().staticTools!;
  const blocks: Record<string,string> = {};
  for (const app of PLANNING_CENTER_APPS) {
    if (app === "people") continue;
    const available = new Set(fixture.create("fixture",{excludeApps:[app]}).staticTools!.map(tool => tool.name));
    for (const tool of full) if (!available.has(tool.name)) {
      if (blocks[tool.name] !== undefined) throw new Error(`Ambiguous app ownership for ${tool.name}`);
      blocks[tool.name] = app;
    }
  }
  return Object.freeze(blocks);
})();
