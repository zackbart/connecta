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
import { connectorGuideSummary } from "../src/skills.js";

const context = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: console,
  baseUrl: "https://connecta.example",
};

/**
 * Every maintained provider guide is structured now (H13, P7), so a guide
 * assertion reads its `content` rather than the connector field.
 */
function guideOf(connector: Connector): string {
  const guide = connector.usageGuide;
  if (typeof guide !== "object" || guide === undefined) {
    throw new Error("expected a structured usage guide");
  }
  return guide.content;
}

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
      access: "read-write",
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
    expect(guideOf(connector)).toContain("ENG-123");
    expect(guideOf(connector)).toContain("upsert");
    expect(guideOf(connector)).toContain("create_issue_label");
    expect(guideOf(connector)).toContain("authorize_connector");
    expect(guideOf(connector)).toContain("cursor");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Workspace instructions");
    expect(guideOf(connector)).not.toContain("+## Workspace instructions");
    expect(guideOf(connector)).toContain(
      "File bugs into the Platform team unless told otherwise.",
    );
  });

  it("omits the account section entirely when no instructions are given", () => {
    const connector = linear("tracker", {
      purpose: "Roadmap questions",
      access: "read-write",
    });
    expect(guideOf(connector)).not.toContain("## Workspace instructions");
  });

  it("declares no call-admission budget of its own", () => {
    linear("tracker", {
      purpose: "Roadmap questions",
      access: "read-write",
    });
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
        // Browse-time discovery renders the title, not the description, so the
        // title carries the mode unless the operator names the connection.
        title: "Linear (read-only)",
        description:
          "Linear issue tracking and project planning (read-only) — Reporting on delivery status",
      }),
    );
    expect(LINEAR_MCP_ENDPOINTS["read-only"]).toBe(
      "https://mcp.linear.app/mcp/readonly",
    );
    expect(guideOf(connector)).toContain("read-only endpoint");
    expect(guideOf(connector)).not.toContain("call_destructive_tool");
  });

  it("defaults the title to plain Linear for a read-write connection", () => {
    linear("tracker", {
      purpose: "Roadmap questions",
      access: "read-write",
    });
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).toMatchObject({
      title: "Linear",
    });
  });

  it("lets an operator title override the read-only default", () => {
    linear("tracker", {
      purpose: "Roadmap questions",
      access: "read-only",
      title: "Delivery reporting",
    });
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).toMatchObject({
      title: "Delivery reporting",
    });
  });

  it("leads the guide with access, so the discovery summary carries it", () => {
    // `search_tools` shows a connector's guide summary and never its
    // description. The summary is now declared rather than derived (P7), so
    // the access fact is stated whole instead of being truncated at 120
    // characters, and the guide's first content line still repeats it.
    const readOnly = linear("reporting", {
      purpose: "Reporting on delivery status",
      access: "read-only",
    });
    const readWrite = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });

    expect(connectorGuideSummary(readOnly)).toContain("Read-only");
    expect(connectorGuideSummary(readWrite)).toContain("Read-write");
    expect(connectorGuideSummary(readOnly)).not.toContain("Workspace purpose");
    for (const connector of [readOnly, readWrite]) {
      const summary = connectorGuideSummary(connector);
      // Declared, not truncated: a derived summary ends in an ellipsis here.
      expect(summary?.length).toBeLessThanOrEqual(120);
      expect(summary).not.toContain("\u2026");
    }
    expect(guideOf(readOnly)).toContain("Read-only connection");
    expect(guideOf(readWrite)).toContain("Read-write connection");
  });

  it("supports API-key header auth and operator-supplied limits", () => {
    linear("automation_tracker", {
      purpose: "Headless release reporting",
      access: "read-write",
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
      // Maintained additive create: leaves the read path without inflating the
      // host's approval copy with a destruction it does not perform.
      { name: "create_issue_label" },
      // Unfamiliar tool the downstream says nothing about: silence fails
      // closed.
      { name: "summon_new_thing" },
    ]);
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
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
    expect(tools[2]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("keeps a vetted destructive tool closed despite a read-only claim", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "save_issue", annotations: { readOnlyHint: true } },
    ]);
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("believes an explicit annotation on a tool no release has classified", async () => {
    mocks.listTools.mockResolvedValue([
      // Not on either maintained list, and the downstream calls it read-only.
      // Rewriting that to `false` would be an overrule, not a fill-in: on a
      // name no release has reviewed, the downstream's word is the only
      // evidence there is. `extract_images` was exactly this case before it
      // was allowlisted.
      { name: "peek_at_new_thing", annotations: { readOnlyHint: true } },
      // The same rule in the other direction.
      { name: "wreck_new_thing", annotations: { destructiveHint: true } },
    ]);
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("agrees with the markdown helper's own read-only annotation", async () => {
    // The hosted server ships `extract_images` with explicit `readOnlyHint`
    // and `idempotentHint`. It reads images out of content it is handed and
    // touches no workspace state, so it belongs on the read allowlist —
    // classifying it as a write would have overruled an explicit downstream
    // annotation, which a fill-in classification never does.
    mocks.listTools.mockResolvedValue([
      {
        name: "extract_images",
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
      // Same tool from a workspace that reports nothing: filled in, not feared.
      { name: "extract_images" },
    ]);
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
    });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
    });
  });

  it("classifies the plan-gated customer and code-review surfaces", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "list_customers" },
      { name: "delete_customer_need" },
      { name: "merge_diff" },
      { name: "prepare_attachment_upload" },
      { name: "search_documentation" },
    ]);
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
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
    const connector = linear("tracker", {
      purpose: "Delivery planning",
      access: "read-write",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("rejects an empty workspace purpose at construction", () => {
    expect(() =>
      linear("tracker", { purpose: "  ", access: "read-write" }),
    ).toThrow("linear() requires a non-empty workspace purpose.");
  });

  it("requires the operator to declare an access mode (P4)", () => {
    // Neither endpoint is a safe default: `read-write` hands out writes nobody
    // asked for, and `read-only` breaks a writing deployment at Linear, at
    // runtime, where no agent can repair it. So the declaration is required
    // and a deployment that forgot fails here, at construction.
    expect(() =>
      linear("tracker", { purpose: "Delivery planning" } as never),
    ).toThrow('requires access "read-write" or "read-only"');
    expect(() =>
      linear("tracker", {
        purpose: "Delivery planning",
        access: "readonly" as never,
      }),
    ).toThrow('requires access "read-write" or "read-only"');
  });
});
