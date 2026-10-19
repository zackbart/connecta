import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { observedCatalogDrift } from "../../catalog-drift.js";
import { connectorGuideSummary } from "../../skills.js";
import { classifyTool } from "../../tool-safety.js";
import { required } from "../../../test/helpers.js";
import {
  guideOf,
  itClassifiesLikeARelease,
  mockRemoteMcp,
  servedTools,
} from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { INTERCOM_MCP_ENDPOINTS, intercom } from "./index.js";
import { hostedCatalog } from "./fixtures.js";
import drift from "./drift.json";

function connection(overrides: Partial<Parameters<typeof intercom>[1]> = {}) {
  return intercom("support", { purpose: "Customer support triage", region: "us", ...overrides });
}

const READS = [
  "search",
  "fetch",
  "search_conversations",
  "get_conversation",
  "search_contacts",
  "get_contact",
  "list_companies",
  "get_company",
  "list_articles",
  "search_articles",
  "get_article",
  "get_operator_response",
  "get_proposal_details",
];
const DESTRUCTIVE = [
  "update_article",
  "add_internal_note",
  "send_operator_message",
  "apply_proposals",
  "reject_proposals",
];

describe("intercom()", () => {
  beforeEach(() => mockRemoteMcp(mocks));

  it.each(["us", "eu"] as const)("INV-11: binds %s to its HTTPS endpoint with personal OAuth", (region) => {
    const connector = connection({ region, purpose: "  Customer support triage  " });
    expect(INTERCOM_MCP_ENDPOINTS).toEqual({
      us: "https://mcp.intercom.com/mcp",
      eu: "https://mcp.eu.intercom.com/mcp",
    });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "support",
      expect.objectContaining({
        url: INTERCOM_MCP_ENDPOINTS[region],
        title: `Intercom (${region.toUpperCase()})`,
        description:
          "Intercom conversations, contacts, companies, articles and optional Fin Operator — Customer support triage",
        auth: { type: "oauth" },
        authScope: "personal",
        requireHttps: true,
      }),
    );
    expect(connector.describe?.().source.provider).toBe("intercom");
    expect(guideOf(connector).split("\n")[2]).toContain(`Customer support workspace in ${region.toUpperCase()}`);
    expect(guideOf(connector)).toContain("Each person authorizes separately");
  });

  it("supports stored bearer tokens and defaults their ownership to shared", () => {
    const connector = connection({ auth: { type: "credential" } });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "support",
      expect.objectContaining({
        authScope: "shared",
        auth: { type: "credential", credential: expect.objectContaining({ label: "Intercom API token" }) },
      }),
    );
    expect(guideOf(connector)).toContain("Bearer API token access: Fin Operator tools are unavailable");
    expect(guideOf(connector)).toContain("shares one workspace authorization");
  });

  it("honors explicit OAuth scopes, ownership and common runtime policies without a blanket rate limit", () => {
    connection();
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty("callAdmission");
    const callAdmission = { rules: [{ maxConcurrency: 2 }] };
    connection({
      auth: { type: "oauth", scope: "mcp operator" },
      authScope: "shared",
      title: "Support",
      maxResultBytes: 24_000,
      callAdmission,
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "support",
      expect.objectContaining({
        auth: { type: "oauth", scope: "mcp operator" },
        authScope: "shared",
        title: "Support",
        maxResultBytes: 24_000,
        callAdmission,
      }),
    );
    connection({
      auth: { type: "credential", scheme: null, credential: { label: "Workspace token" } },
      authScope: "personal",
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "support",
      expect.objectContaining({
        authScope: "personal",
        auth: { type: "credential", scheme: null, credential: { label: "Workspace token" } },
      }),
    );
  });

  it("INV-5: real metadata names its region and credential slot without exposing configured headers", async () => {
    const real = await vi.importActual<typeof import("../../connectors/remote-mcp.js")>(
      "../../connectors/remote-mcp.js",
    );
    mocks.remoteMcp.mockImplementation(real.remoteMcp);
    const connector = connection({
      region: "eu",
      auth: { type: "headers", headers: { Authorization: "Bearer fixture-secret" } },
    });
    const metadata = connector.describe?.();
    expect(metadata).toMatchObject({
      source: { provider: "intercom" },
      endpoint: { origin: "https://mcp.eu.intercom.com", path: "/mcp" },
    });
    expect(JSON.stringify(metadata)).not.toContain("fixture-secret");
    const credential = connection({ auth: { type: "credential" } });
    expect(credential.credential?.label).toBe("Intercom API token");
    expect(credential.describe?.()).toMatchObject({
      auth: { mode: "credential", header: "Authorization", scheme: "Bearer" },
    });
  });

  it.each([undefined, null, "", "au", "EU", "https://mcp.intercom.com/mcp"])(
    "INV-11: refuses missing or unsupported region %s before constructing transport",
    (region) => {
      expect(() => connection({ region } as never)).toThrow(/intercom.*support.*region "us" or "eu"/);
      expect(mocks.remoteMcp).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "", "  ", 42])("INV-11: refuses invalid purpose %s", (purpose) => {
    expect(() => connection({ purpose } as never)).toThrow(/intercom.*support.*non-empty purpose/);
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it.each(["url", "classify", "classification", "access"])("INV-11: refuses undeclared option %s", (key) => {
    expect(() => connection({ [key]: "ignored" })).toThrow(`intercom("support").${key}`);
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("INV-1: reviews the documented 19-tool superset without inventing schemas or pins", async () => {
    const reviewed = required(intercom.definition.classify).tools;
    expect(hostedCatalog).toHaveLength(19);
    expect(Object.keys(reviewed).sort()).toEqual([...READS, "create_article", ...DESTRUCTIVE].sort());
    expect(hostedCatalog.map((tool) => tool.name).sort()).toEqual(Object.keys(reviewed).sort());
    for (const tool of hostedCatalog) expect(tool).not.toHaveProperty("inputSchema");
    for (const entry of Object.values(reviewed)) expect(entry).not.toHaveProperty("schemaDigest");
    for (const check of drift.checks.filter((check) => check.type !== "manual")) {
      expect([...required(check.reviewed)].sort()).toEqual(Object.keys(reviewed).sort());
    }
    const connector = connection();
    mocks.listTools.mockResolvedValue(structuredClone([...hostedCatalog]));
    const tools = await servedTools(connector);
    expect(tools.filter((tool) => classifyTool(tool) === "read")).toHaveLength(13);
    expect(tools.filter((tool) => classifyTool(tool) === "write")).toHaveLength(6);
    expect(tools.filter((tool) => tool.annotations?.destructiveHint === true)).toHaveLength(5);
    expect(observedCatalogDrift(connector)).toMatchObject({
      unclassifiedTools: 0,
      unservedTools: 0,
      schemaChanges: 0,
      annotationConflicts: 0,
    });
  });

  it("INV-1: preserves vendor input/output schemas and descriptions", async () => {
    const tool: ToolDef = {
      name: "search_contacts",
      description: "Vendor contact search",
      inputSchema: { type: "object", properties: { starting_after: { type: "string" } } },
      outputSchema: { type: "object", properties: { pages: { type: "object" } } },
      annotations: { openWorldHint: true },
    };
    mocks.listTools.mockResolvedValue([tool]);
    const served = (await servedTools(connection()))[0];
    expect(served).toMatchObject({
      ...tool,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    });
  });

  it("INV-1: keeps every reviewed mutation closed despite contradictory read hints", async () => {
    mocks.listTools.mockResolvedValue(
      ["create_article", ...DESTRUCTIVE].map((name) => ({
        name,
        annotations: { readOnlyHint: true, destructiveHint: false },
      })),
    );
    const tools = await servedTools(connection());
    expect(tools.every((tool) => classifyTool(tool) === "write")).toBe(true);
    expect(tools.slice(1).every((tool) => tool.annotations?.destructiveHint === true)).toBe(true);
  });

  itClassifiesLikeARelease(connection, mocks, {
    read: ["search", "get_contact", "get_article"],
    write: "create_article",
    destructive: "update_article",
    unknown: ["reply_to_conversation", "new_read", "delete_contact"],
  });

  it("documents privacy, scope and callback limits, note reopening and asynchronous proposal safety", () => {
    const connector = connection({ instructions: "  Prefer summaries over full customer threads.  " });
    const guide = guideOf(connector);
    for (const fact of [
      "personal data",
      "Never echo tokens",
      "schema digests are unpinned",
      "pages.next.starting_after",
      "note_and_unsnooze",
      "Never resend",
      "proposals_withheld",
      "get_proposal_details",
      "allowlist entry",
      "403 action_forbidden",
      "read-only endpoint",
      "Use Fin Operator",
      "AU workspaces are unsupported",
    ])
      expect(guide).toContain(fact);
    expect(guide).toContain("## Workspace instructions\n\nPrefer summaries over full customer threads.");
    expect(guideOf(connection())).not.toContain("## Workspace instructions");
    expect(new TextEncoder().encode(required(connectorGuideSummary(connector))).byteLength).toBeLessThanOrEqual(120);
  });
});
