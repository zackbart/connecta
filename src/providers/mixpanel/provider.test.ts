import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { hostedSchemaFixtures } from "./fixtures.js";
import { thingsDeployment } from "../../../test/fixtures/things-deployment.js";
import { mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the constructor is stubbed. `withCredentialDefaults` is pure option
  // shaping — part of what these tests assert the provider resolved — so it
  // stays real.
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { MIXPANEL_MCP_ENDPOINTS, mixpanel } from "./index.js";

describe("mixpanel()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the endpoint and OAuth default", () => {
    mixpanel("product_analytics", {
      title: "Production analytics",
      purpose: "Growth team product decisions",
      instructions: "Use project 42 unless the request names another project.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "product_analytics",
      expect.objectContaining({
        url: MIXPANEL_MCP_ENDPOINTS.us,
        title: "Production analytics",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
  });

  it("frames an operator-managed service account as Mixpanel documents it", () => {
    mixpanel("eu_analytics", {
      purpose: "EU product reporting",
      region: "eu",
      auth: { type: "credential" },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "eu_analytics",
      expect.objectContaining({
        url: MIXPANEL_MCP_ENDPOINTS.eu,
        // The operator pastes `username:secret`; Connecta encodes it and sends
        // the beta scheme's `Bearer Basic` framing.
        auth: {
          type: "credential",
          credential: expect.objectContaining({
            label: "Service account",
            placeholder: "username:secret",
          }),
          scheme: "Bearer Basic",
        },
      }),
    );
  });

  it("INV-1 INV-2: exposes refreshed reads on a read-only pool and refuses write-capable experiment reads", async () => {
    mocks.listTools.mockResolvedValue(hostedSchemaFixtures);
    const connector = mixpanel("things", { purpose: "Product decisions" });
    const dispatch = vi.spyOn(connector, "callTool");
    const app = thingsDeployment(connector);
    expect(await app.searched("readOnly", "readonly")).toEqual([
      "things.Get-Dashboard",
      "things.Get-Events",
      "things.Get-Metric",
      "things.List-Cohorts",
    ]);
    for (const [name, args] of [
      ["Get-Events", { project_id: 1 }],
      ["Get-Dashboard", { project_id: 1, dashboard_id: 2 }],
      ["List-Cohorts", { project_id: 1 }],
      ["Get-Metric", { project_id: 1, metric_id: 2 }],
    ] as const) {
      expect((await app.call("call_tool", { address: `things.${name}`, args }, "readonly")).isError).toBeFalsy();
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
    const refused = await app.call(
      "call_tool",
      {
        address: "things.Get-Experiment",
        args: { project_id: 1, experiment_id: "experiment", compute_exposures: false, compute_metrics: false },
      },
      "readonly",
    );
    expect(refused.structuredContent?.error.code).toBe("read_only_endpoint");
    expect(dispatch).toHaveBeenCalledTimes(4);
    await app.connecta.close();
  });
});
