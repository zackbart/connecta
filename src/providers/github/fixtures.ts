import { github } from "./index.js";
import { AppAuth } from "./auth.js";
import { restConnector } from "./rest.js";
import { ScopePolicy } from "./scope.js";
const options: Parameters<typeof github>[1] = {
  purpose: "Audit fixture",
  app: { appId: "12345" },
  scopes: [{ org: "acme", access: "read-write" }, { repo: "other/one", access: "read" }],
};
export const fixture = {
  name: "github", options,
  cases: [{ label: "default", options: {} }, { label: "padded-purpose", options: { purpose: "  Audit fixture  " } }],
  create(id = "fixture", overrides: Partial<Parameters<typeof github>[1]> = {}) { return github(id, { ...options, ...overrides }); },
  // Hosted schemas require installation auth. Provider-local fixtures cover
  // both hosted and REST conventions without network access.
  conventions: undefined,
};

export function createAuthored() {
  const policy = new ScopePolicy(options.scopes);
  return restConnector("fixture", new AppAuth(options.app, policy), policy);
}
