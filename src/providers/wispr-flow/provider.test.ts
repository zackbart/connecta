import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { connectorGuideSummary } from "../../skills.js";
import { classifyTool } from "../../tool-safety.js";
import { guideOf, mockRemoteMcp, servedTools } from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { WISPR_FLOW_MCP_ENDPOINT, wisprFlow } from "./index.js";

const READS = [
  "get_account_info",
  "get_calendar_event",
  "get_meeting",
  "get_meeting_by_calendar_id",
  "get_meeting_participants_enriched",
  "get_scratchpad_note",
  "get_upcoming_meeting",
  "list_meeting_series",
  "list_upcoming_meetings",
  "resolve_calendar_link",
  "resolve_share_link",
  "search_calendar_events",
  "search_meetings",
  "search_scratchpad_notes",
  "get_task",
  "search_tasks",
];

function connection(overrides: Partial<Parameters<typeof wisprFlow>[1]> = {}) {
  return wisprFlow("wispr", { purpose: "The studio's recorded client meetings", ...overrides });
}

describe("wisprFlow()", () => {
  beforeEach(() => mockRemoteMcp(mocks));

  it("INV-11: constructs the exact HTTPS endpoint with OAuth and advertised fallback scopes", () => {
    const connector = connection({ purpose: "  Client meetings  " });
    expect(WISPR_FLOW_MCP_ENDPOINT).toBe("https://api.wisprflow.ai/connect/mcp");
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "wispr",
      expect.objectContaining({
        url: WISPR_FLOW_MCP_ENDPOINT,
        title: "Wispr Flow",
        description: "Wispr Flow Notetaker meetings, Scratchpad notes, calendar events and tasks: Client meetings",
        auth: { type: "oauth", scope: "openid offline_access" },
        requireHttps: true,
      }),
    );
    expect(connector.credential).toBeUndefined();
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeUndefined();
  });

  it("INV-11: accepts explicit OAuth settings while preserving the advertised fallback", () => {
    connection({ auth: { type: "oauth", clientMetadataUrl: "https://connecta.example/oauth/wispr-client" } });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "wispr",
      expect.objectContaining({
        auth: {
          type: "oauth",
          scope: "openid offline_access",
          clientMetadataUrl: "https://connecta.example/oauth/wispr-client",
        },
      }),
    );
  });

  it.each([undefined, null, "", "  ", 42])(
    "INV-11: refuses invalid purpose %s before transport construction",
    (purpose) => {
      expect(() => wisprFlow("wispr", { purpose } as Parameters<typeof wisprFlow>[1])).toThrow(
        /wisprFlow.*wispr.*non-empty purpose/,
      );
      expect(mocks.remoteMcp).not.toHaveBeenCalled();
    },
  );

  it.each([
    { type: "headers", headers: { Authorization: "Bearer example" } },
    { type: "credential" },
    { type: "request", token: async () => "example" },
    { type: "apiKey" },
    {},
    null,
    { type: "oauth", headers: { Authorization: "Bearer example" } },
  ])("INV-11: refuses non-OAuth auth or credential keys %s", (auth) => {
    expect(() => connection({ auth } as Parameters<typeof wisprFlow>[1])).toThrow(/wisprFlow.*wispr.*auth/);
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it.each(["access", "url", "classify", "classification"])("INV-11: refuses undeclared option %s", (key) => {
    expect(() => connection({ [key]: "ignored" })).toThrow(`wisprFlow("wispr").${key}`);
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("INV-11: passes common overrides through without inventing an admission default", () => {
    connection();
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty("callAdmission");
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty("maxResultBytes");
    const callAdmission = { rules: [{ maxConcurrency: 2 }] };
    connection({ title: "Work meetings", authScope: "personal", callAdmission, maxResultBytes: 25_000 });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "wispr",
      expect.objectContaining({
        title: "Work meetings",
        authScope: "personal",
        callAdmission,
        maxResultBytes: 25_000,
      }),
    );
  });

  it("INV-1: classifies all 16 reviewed reads while preserving vendor schemas and descriptions", async () => {
    const inputSchema = { type: "object", properties: { meeting_id: { type: "string" } } };
    mocks.listTools.mockResolvedValue(
      READS.map((name) => ({ name, inputSchema, description: "Vendor-owned description" })),
    );
    const tools = await servedTools(connection());
    expect(tools).toHaveLength(16);
    for (const tool of tools) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toEqual(inputSchema);
      expect(tool.description).toBe("Vendor-owned description");
    }
    expect(Object.keys(wisprFlow.definition.classify!.tools).sort()).toEqual(
      [...READS, "add_task", "update_task"].sort(),
    );
  });

  it("INV-1: task creates and updates stay writes despite contradictory vendor read hints", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "add_task" },
      { name: "add_task", annotations: { readOnlyHint: true } },
      { name: "update_task", annotations: { readOnlyHint: true, destructiveHint: false } },
    ]);
    const tools = await servedTools(connection());
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[1]?.annotations?.readOnlyHint).toBe(false);
    expect(tools[2]?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it("INV-1: unreviewed tools fail closed unless explicit uncontradicted annotations establish a read", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "new_tool" },
      { name: "new_read", annotations: { readOnlyHint: true } },
      { name: "new_conflicting_tool", annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: "get_meeting", annotations: { readOnlyHint: false } },
    ]);
    const tools = await servedTools(connection());
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: true });
    // Unknown vendor hints stay intact; the shared safety classifier rejects
    // this contradictory read claim when enforcing trust.
    expect(classifyTool(tools[2]!)).toBe("write");
    expect(tools[2]?.classification).toBe("write");
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("INV-11: metadata and guide route account-wide access with a summary bounded to 120 UTF-8 bytes", () => {
    const connector = connection({ instructions: "  Prefer client meeting summaries.  " });
    const guide = guideOf(connector);
    expect(
      guide.split("\n")[2]?.startsWith("Account-wide Notetaker access: The studio's recorded client meetings."),
    ).toBe(true);
    expect(guide).toContain("One shared authorization selects the account");
    expect(guide).toContain("Dictation history and Notetaker chat history are unavailable");
    expect(guide).toContain("## Account instructions\n\nPrefer client meeting summaries.");
    expect(guideOf(connection({ authScope: "personal" }))).toContain("Each person authorizes separately");
    expect(guideOf(connection())).not.toContain("## Account instructions");
    const summary = connectorGuideSummary(connector)!;
    expect(summary).toBe("Account-wide Notetaker access: The studio's recorded client meetings");
    expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(120);
  });

  it("INV-11: discovery summaries and opening context distinguish account purposes", () => {
    const personal = connection({ purpose: "  Personal meetings  " });
    const client = connection({ purpose: "Client meetings" });
    expect(connectorGuideSummary(personal)).toBe("Account-wide Notetaker access: Personal meetings");
    expect(connectorGuideSummary(client)).toBe("Account-wide Notetaker access: Client meetings");
    expect(connectorGuideSummary(personal)).not.toBe(connectorGuideSummary(client));
    expect(guideOf(personal).split("\n")[2]).toContain("access: Personal meetings.");
    expect(guideOf(client).split("\n")[2]).toContain("access: Client meetings.");
  });

  it.each(["a", "é", "会", "😀"])(
    "INV-11: long %s account purposes keep summaries within 120 UTF-8 bytes without splitting code points",
    (character) => {
      const connector = connection({ purpose: character.repeat(100) });
      const summary = connectorGuideSummary(connector)!;
      expect(summary).toMatch(new RegExp(`^Account-wide Notetaker access: ${character}+…$`, "u"));
      expect(new TextEncoder().encode(summary).byteLength).toBeLessThanOrEqual(120);
      expect(connector.usageGuide).toMatchObject({ summary });
    },
  );

  it("INV-11: an account summary at the 120-byte boundary needs no ellipsis", () => {
    const purpose = "a".repeat(120 - new TextEncoder().encode("Account-wide Notetaker access: ").byteLength);
    const summary = connectorGuideSummary(connection({ purpose }))!;
    expect(summary).toBe(`Account-wide Notetaker access: ${purpose}`);
    expect(new TextEncoder().encode(summary).byteLength).toBe(120);
  });
});
