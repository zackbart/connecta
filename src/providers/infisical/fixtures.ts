import { infisical } from "./index.js";
const options: Parameters<typeof infisical>[1] = { purpose: "Audit fixture" };
export const fixture = {
  name: "infisical", options,
  cases: [{ label: "default", options: {} }, { label: "eu", options: { baseUrl: "https://eu.infisical.com/api" } }, { label: "self-hosted", options: { baseUrl: "https://secrets.example/api" } }],
  create(id = "fixture", overrides: Partial<Parameters<typeof infisical>[1]> = {}) { return infisical(id, { ...options, ...overrides }); },
  conventions: { verbs: ["list", "get", "create", "update", "delete"], nestedDescriptionExceptions: [], auth: "credential" },
};
