import documentedCatalog from "./catalog.fixture.json";
import type { ToolDef } from "../../types.js";
import { intercom } from "./index.js";

const options: Parameters<typeof intercom>[1] = { purpose: "Audit fixture", region: "us" };

export const fixture = {
  name: "intercom",
  options,
  cases: [
    { label: "default", options: {} },
    { label: "padded-purpose", options: { purpose: "  Audit fixture  " } },
    { label: "eu", options: { region: "eu" } },
    { label: "credential", options: { auth: { type: "credential" } } },
    { label: "shared-oauth", options: { authScope: "shared" } },
    { label: "operator", options: { auth: { type: "oauth", scope: "mcp operator" } } },
  ],
  create(id = "fixture", overrides: Partial<Parameters<typeof intercom>[1]> = {}) {
    return intercom(id, { ...options, ...overrides });
  },
  // Vendor-hosted schemas and verbs are outside API-only conventions. OAuth
  // is personal by default; operator-managed bearer credentials are shared.
  conventions: undefined,
};

// Documentation-derived examples, NOT a live tools/list capture. Input schemas
// are deliberately absent; catalog.review.md records known fields and gaps.
export const hostedCatalog: readonly ToolDef[] = documentedCatalog;
