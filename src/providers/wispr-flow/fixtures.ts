import { wisprFlow } from "./index.js";

const options: Parameters<typeof wisprFlow>[1] = { purpose: "Audit fixture" };

export const fixture = {
  name: "wispr-flow",
  options,
  cases: [
    { label: "padded-purpose", options: { purpose: "  Audit fixture  " } },
    { label: "default", options: {} },
    { label: "personal", options: { authScope: "personal" } },
    { label: "oauth", options: { auth: { type: "oauth" } } },
  ],
  create(id = "fixture", overrides: Partial<Parameters<typeof wisprFlow>[1]> = {}) {
    return wisprFlow(id, { ...options, ...overrides });
  },
  // Vendor-hosted tools own their schemas; API naming conventions do not apply.
  conventions: undefined,
};
