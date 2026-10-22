import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";

import { mockRemoteMcp, servedTools } from "../../../test/fixtures/hosted-provider.js";

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
});
