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
        redirects: "none",
        callAdmission: {
          rules: [
            {
              budget: {
                kind: "rolling-window",
                maxCalls: 600,
                windowMs: 3_600_000,
              },
              retryAfterMs: 60_000,
            },
          ],
        },
      }),
    );
    expect(connector.usageGuide).toContain("Get-Business-Context");
    expect(connector.usageGuide).toContain("Get-Query-Schema");
    expect(connector.usageGuide).toContain("600 requests per user per hour");
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

  it("classifies vetted reads and writes and fails closed on catalog drift", async () => {
    mocks.listTools.mockResolvedValue([
      {
        name: "Run-Query",
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      {
        name: "Delete-Dashboard",
        annotations: { readOnlyHint: true },
      },
      {
        name: "Brand-New-Tool",
        annotations: { readOnlyHint: true },
      },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(tools[2]?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it("rejects an empty account purpose at construction", () => {
    expect(() => mixpanel("analytics", { purpose: "  " })).toThrow(
      "mixpanel() requires a non-empty account purpose.",
    );
  });
});
