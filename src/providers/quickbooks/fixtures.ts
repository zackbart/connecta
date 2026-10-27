import { quickbooks, type QuickBooksOptions } from "./index.js";
const options: QuickBooksOptions = { purpose: "Accounting fixture", realmId: "123456789", environment: "sandbox", clientId: "fixture-client", clientSecret: "fixture-secret" };
export const fixture = {
  name: "quickbooks", options,
  cases: [{ label: "writes", options: { readOnly: false } }, { label: "production", options: { environment: "production" } }, { label: "personal", options: { authScope: "personal" } }],
  create(id = "fixture", overrides: Partial<QuickBooksOptions> = {}) { return quickbooks(id, { ...options, ...overrides }); },
  conventions: { verbs: ["get", "search", "create", "update", "quickbooks"], nestedDescriptionExceptions: [], auth: "oauth" },
};
export const createAuthored = () => fixture.create("fixture", { readOnly: false });
