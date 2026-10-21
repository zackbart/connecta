import { beforeEach, describe, expect, it, vi } from "vitest";
import { observedCatalogDrift } from "../../catalog-drift.js";
import type { ToolDef } from "../../types.js";
import { hostedSchemaFixtures } from "./fixtures.js";
import { thingsDeployment } from "../../../test/fixtures/things-deployment.js";
import {
  guideOf,
  itClassifiesLikeARelease,
  mockRemoteMcp,
  servedTools,
} from "../../../test/fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
  /**
   * The mocked downstream serves names and annotations but no schemas, so no
   * recorded digest can match it. The classification rules below are about
   * annotations; they read the catalog as if each schema were the one its
   * release reviewed. The stale-schema case turns this off.
   */
  schemasAsReviewed: true,
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
    const construct = mocks.remoteMcp.getMockImplementation()!;
    mocks.remoteMcp.mockImplementation((id, options) =>
      construct(id, {
        ...options,
        classify: mocks.schemasAsReviewed
          ? {
              tools: Object.fromEntries(
                Object.entries(mixpanel.definition.classify!.tools).map(([name, entry]) => [
                  name,
                  typeof entry === "string" ? entry : { verdict: entry.verdict, reason: entry.reason },
                ]),
              ),
            }
          : options.classify,
      }),
    );
    mocks.schemasAsReviewed = true;
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
        description: "Mixpanel product analytics (US residency) — Growth team product decisions",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    expect(guideOf(connector)).toContain("Never return raw `Run-Query` output.");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Account instructions");
    expect(guideOf(connector)).not.toContain("+## Account instructions");
    expect(guideOf(connector)).toContain("Use project 42 unless the request names another project.");
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

  itClassifiesLikeARelease(() => mixpanel("analytics", { purpose: "Product decisions" }), mocks, {
    read: ["Run-Query", "List-Dashboards", "Get-Report"],
    write: "Create-Dashboard",
    destructive: "Delete-Dashboard",
    unknown: ["Brand-New-Tool", "Get-Brand-New-Thing", "Wreck-Brand-New-Thing"],
  });

  it("INV-1: serves a reviewed read whose schema no longer matches its digest as a write", async () => {
    mocks.schemasAsReviewed = false;
    mocks.listTools.mockResolvedValue([
      { name: "Run-Query" },
      { name: "List-Dashboards", annotations: { readOnlyHint: true } },
      { name: "Delete-Dashboard" },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    const tools = await servedTools(connector);
    expect(tools.map((tool) => tool.annotations)).toEqual([
      { readOnlyHint: false },
      { readOnlyHint: false },
      { readOnlyHint: false, destructiveHint: true },
    ]);
    expect(observedCatalogDrift(connector)).toMatchObject({ schemaChanges: 3 });
  });

  it("INV-1: current schemas still fail closed on a new schema change or explicit upstream write hint", async () => {
    mocks.schemasAsReviewed = false;
    const events = hostedSchemaFixtures.find((tool) => tool.name === "Get-Events")!;
    mocks.listTools.mockResolvedValue([
      { ...events, inputSchema: { ...events.inputSchema, description: "A new unreviewed schema" } },
    ]);
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    expect((await servedTools(connector))[0]?.classification).toBe("write");
    expect(observedCatalogDrift(connector)).toMatchObject({ schemaChanges: 1 });
    mocks.listTools.mockResolvedValue([{ ...events, annotations: { readOnlyHint: false } }]);
    expect((await servedTools(connector))[0]?.classification).toBe("write");
    expect(observedCatalogDrift(connector)).toMatchObject({ schemaChanges: 0, annotationConflicts: 1 });
  });

  it("INV-1 INV-2: exposes refreshed reads on a read-only pool and refuses write-capable experiment reads", async () => {
    mocks.schemasAsReviewed = false;
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
