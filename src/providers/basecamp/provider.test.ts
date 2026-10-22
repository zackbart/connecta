import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { BASECAMP_MCP_ENDPOINT, basecamp } from "./index.js";

const CLIENT_METADATA_URL = "https://connecta.example/oauth/basecamp-client";

function connection(overrides: Partial<Parameters<typeof basecamp>[1]> = {}) {
  return basecamp("basecamp", {
    purpose: "The studio's client projects",
    clientMetadataUrl: CLIENT_METADATA_URL,
    ...overrides,
  });
}

describe("basecamp()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the endpoint and OAuth through a client metadata document (P9)", () => {
    connection({
      instructions: "Post client-facing updates as messages, never as chat.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "basecamp",
      expect.objectContaining({
        url: BASECAMP_MCP_ENDPOINT,
        title: "Basecamp",
        // The scope is a fallback: the MCP client asks for what Basecamp's
        // challenge names first, so this only matters if Basecamp stops
        // advertising scopes.
        auth: {
          type: "oauth",
          clientMetadataUrl: CLIENT_METADATA_URL,
          scope: "full mcp offline_access",
        },
        requireHttps: true,
      }),
    );
    expect(BASECAMP_MCP_ENDPOINT).toBe("https://mcp.basecamp.com/mcp");
  });
});
