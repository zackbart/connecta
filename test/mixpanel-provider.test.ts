import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ToolDef } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../src/connectors/remote-mcp.js", () => ({
  remoteMcp: mocks.remoteMcp,
}));

import {
  MIXPANEL_MCP_ENDPOINTS,
  mixpanel,
} from "../src/providers/mixpanel.js";

const context = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: console,
  baseUrl: "https://connecta.example",
};

describe("mixpanel()", () => {
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
    const connector = mixpanel("product_analytics", {
      title: "Production analytics",
      purpose: "Growth team product decisions",
      instructions: "Use project 42 unless the request names another project.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "product_analytics",
      expect.objectContaining({
        url: MIXPANEL_MCP_ENDPOINTS.us,
        title: "Production analytics",
        description:
          "Mixpanel product analytics — Growth team product decisions",
        auth: { type: "oauth" },
        requireHttps: true,
        callAdmission: {
          rules: [
            {
              budget: {
                kind: "rolling-window",
                maxCalls: 600,
                windowMs: 3_600_000,
              },
            },
          ],
        },
      }),
    );
    expect(connector.usageGuide).toContain("Get-Business-Context");
    expect(connector.usageGuide).toContain("Get-Query-Schema");
    expect(connector.usageGuide).toContain("600 requests per user per hour");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(connector.usageGuide).toContain("## Account instructions");
    expect(connector.usageGuide).not.toContain("+## Account instructions");
    expect(connector.usageGuide).toContain(
      "Use project 42 unless the request names another project.",
    );
  });

  it("supports regional routing and service-account header auth", () => {
    mixpanel("eu_analytics", {
      purpose: "EU product reporting",
      region: "eu",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer Basic encoded" },
      },
      maxResultBytes: 25_000,
    });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "eu_analytics",
      expect.objectContaining({
        url: MIXPANEL_MCP_ENDPOINTS.eu,
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer Basic encoded" },
        },
        maxResultBytes: 25_000,
      }),
    );
  });

  it("fills in silent annotations and fails closed on catalog drift", async () => {
    mocks.listTools.mockResolvedValue([
      // Allowlisted read, downstream silent on both hints: fill it in.
      { name: "Run-Query", annotations: { openWorldHint: true } },
      // Allowlisted read with no annotations object at all.
      { name: "List-Dashboards" },
      // Maintained additive create: leaves the read path without inflating the
      // host's approval copy with a destruction it does not perform.
      { name: "Create-Dashboard" },
      // Unfamiliar tool the downstream says nothing about: silence fails
      // closed.
      { name: "Brand-New-Tool" },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
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
      { name: "Delete-Dashboard", annotations: { readOnlyHint: true } },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
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
      // evidence there is.
      { name: "Get-Brand-New-Thing", annotations: { readOnlyHint: true } },
      // The same rule in the other direction.
      { name: "Wreck-Brand-New-Thing", annotations: { destructiveHint: true } },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("never overrules an explicit downstream annotation on a vetted read", async () => {
    mocks.listTools.mockResolvedValue([
      // The downstream says this allowlisted name now destroys something. That
      // is the downstream telling us the allowlist is stale; it wins.
      {
        name: "Run-Query",
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      // Same story stated the other way round.
      { name: "Get-Report", annotations: { readOnlyHint: false } },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("rejects an empty account purpose at construction", () => {
    expect(() => mixpanel("analytics", { purpose: "  " })).toThrow(
      "mixpanel() requires a non-empty account purpose.",
    );
  });
});
