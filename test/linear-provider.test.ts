import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ToolDef } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../src/connectors/remote-mcp.js", () => ({
  remoteMcp: mocks.remoteMcp,
}));

import { LINEAR_MCP_ENDPOINTS, linear } from "../src/providers/linear.js";

const context = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: console,
  baseUrl: "https://connecta.example",
};

describe("linear()", () => {
  beforeEach(() => {
    mocks.listTools.mockReset();
    mocks.remoteMcp.mockReset();
    mocks.remoteMcp.mockImplementation(
      (id: string, options: object): Connector => ({
        id,
        kind: "mcp",
        ...options,
        listTools: mocks.listTools,
        async callTool() {
          return [];
        },
      }),
    );
  });

  it("owns the endpoint, OAuth default, purpose, and provider guidance", () => {
    const connector = linear("product_tracker", {
      title: "Product issue tracking",
      purpose: "Platform team issue and project planning",
      instructions: "File bugs into the Platform team unless told otherwise.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "product_tracker",
      expect.objectContaining({
        url: LINEAR_MCP_ENDPOINTS["read-write"],
        title: "Product issue tracking",
        description:
          "Linear issue tracking and project planning — Platform team issue and project planning",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    // Conventions the schemas cannot express.
    expect(connector.usageGuide).toContain("ENG-123");
    expect(connector.usageGuide).toContain("upsert");
    expect(connector.usageGuide).toContain("create_issue_label");
    expect(connector.usageGuide).toContain("authorize_connector");
    expect(connector.usageGuide).toContain("cursor");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(connector.usageGuide).toContain("## Workspace instructions");
    expect(connector.usageGuide).not.toContain("+## Workspace instructions");
    expect(connector.usageGuide).toContain(
      "File bugs into the Platform team unless told otherwise.",
    );
  });

  it("omits the account section entirely when no instructions are given", () => {
    const connector = linear("tracker", { purpose: "Roadmap questions" });
    expect(connector.usageGuide).not.toContain("## Workspace instructions");
  });

  it("declares no call-admission budget of its own", () => {
    linear("tracker", { purpose: "Roadmap questions" });
    // Linear documents no MCP-specific limit and meters per user per hour, so
    // the connection invents no per-runtime ceiling. An operator may still set
    // one explicitly.
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty(
      "callAdmission",
    );
  });

  it("binds read-only mode to Linear's scope-limited endpoint", () => {
    const connector = linear("readonly_tracker", {
      purpose: "Reporting on delivery status",
      access: "read-only",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "readonly_tracker",
      expect.objectContaining({
        url: LINEAR_MCP_ENDPOINTS["read-only"],
        description:
          "Linear issue tracking and project planning (read-only) — Reporting on delivery status",
      }),
    );
    expect(LINEAR_MCP_ENDPOINTS["read-only"]).toBe(
      "https://mcp.linear.app/mcp/readonly",
    );
    expect(connector.usageGuide).toContain("read-only endpoint");
    expect(connector.usageGuide).not.toContain("call_destructive_tool");
  });

  it("supports API-key header auth and operator-supplied limits", () => {
    linear("automation_tracker", {
      purpose: "Headless release reporting",
      auth: { type: "headers", headers: { Authorization: "lin_api_secret" } },
      maxResultBytes: 25_000,
      callAdmission: {
        rules: [
          { budget: { kind: "rolling-window", maxCalls: 1_000, windowMs: 3_600_000 } },
        ],
      },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "automation_tracker",
      expect.objectContaining({
        auth: {
          type: "headers",
          headers: { Authorization: "lin_api_secret" },
        },
        maxResultBytes: 25_000,
        callAdmission: {
          rules: [
            {
              budget: {
                kind: "rolling-window",
                maxCalls: 1_000,
                windowMs: 3_600_000,
              },
            },
          ],
        },
      }),
    );
  });

  it("fills in silent annotations and fails closed on catalog drift", async () => {
    mocks.listTools.mockResolvedValue([
      // Allowlisted read, downstream silent on both hints: fill it in.
      { name: "list_issues", annotations: { openWorldHint: true } },
      // Allowlisted read with no annotations object at all.
      { name: "get_issue" },
      // Maintained destructive write: an upsert can overwrite, so tighten it
      // whatever the downstream claims.
      { name: "save_issue", annotations: { readOnlyHint: true } },
      // Maintained additive create: leaves the read path without inflating the
      // host's approval copy with a destruction it does not perform.
      { name: "create_issue_label" },
      // Unfamiliar tool: fails closed regardless of its own claim.
      { name: "summon_new_thing", annotations: { readOnlyHint: true } },
      // Deliberately unclassified helper: also fails closed.
      { name: "extract_images" },
    ]);
    const connector = linear("tracker", { purpose: "Delivery planning" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tools[2]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[4]?.annotations).toMatchObject({ readOnlyHint: false });
    expect(tools[5]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("classifies the plan-gated customer and code-review surfaces", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "list_customers" },
      { name: "delete_customer_need" },
      { name: "merge_diff" },
      { name: "prepare_attachment_upload" },
      { name: "search_documentation" },
    ]);
    const connector = linear("tracker", { purpose: "Delivery planning" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools[1]?.annotations).toMatchObject({ destructiveHint: true });
    expect(tools[2]?.annotations).toMatchObject({ destructiveHint: true });
    // An upload URL is a side effect but destroys nothing.
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[4]?.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("never overrules an explicit downstream annotation on a vetted read", async () => {
    mocks.listTools.mockResolvedValue([
      // The downstream says this allowlisted name now destroys something. That
      // is the downstream telling us the allowlist is stale; it wins.
      {
        name: "list_issues",
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      // Same story stated the other way round.
      { name: "get_project", annotations: { readOnlyHint: false } },
    ]);
    const connector = linear("tracker", { purpose: "Delivery planning" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("rejects an empty workspace purpose at construction", () => {
    expect(() => linear("tracker", { purpose: "  " })).toThrow(
      "linear() requires a non-empty workspace purpose.",
    );
  });
});
