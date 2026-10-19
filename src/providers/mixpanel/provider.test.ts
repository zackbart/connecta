import { beforeEach, describe, expect, it, vi } from "vitest";
import { observedCatalogDrift, vettedSchemaDigest } from "../../catalog-drift.js";
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

import { MIXPANEL_MCP_ENDPOINTS, MIXPANEL_VETTED_CATALOG, mixpanel } from "./index.js";
import { connectorGuideSummary } from "../../skills.js";

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
    expect(guideOf(connector)).toContain("Get-Business-Context");
    expect(guideOf(connector)).toContain("Get-Query-Schema");
    expect(guideOf(connector)).toContain("meters MCP traffic per user per hour");
    expect(guideOf(connector)).toContain("not a fixed set");
    expect(guideOf(connector)).toContain("authorize_connector");
    expect(guideOf(connector)).toContain("never guess one");
    expect(guideOf(connector)).toContain("`Get-Business-Context` requires either `project_id` or `organization_id`");
    expect(guideOf(connector)).toContain(
      "`Get-Property-Values` requires `properties` or the deprecated `property` alias. " +
        "Event property values also require `event`",
    );
    expect(guideOf(connector)).toContain("`List-Properties` accepts `names` or `query`, never both");
    // What Insights cannot answer and where its values lie (#430): the four
    // reduction bullets the schemas cannot carry.
    expect(guideOf(connector)).toContain("One analysis is one `execute_code` program: fetch `Get-Query-Schema` once");
    expect(guideOf(connector)).toContain("Never return raw `Run-Query` output.");
    expect(guideOf(connector)).toContain("Insights, funnels, and retention answer aggregate questions");
    expect(guideOf(connector)).toContain("no per-`distinct_id` event timeline");
    expect(guideOf(connector)).toContain("`Get-User-Replays-Data` covers");
    expect(guideOf(connector)).toContain("tell the user the question is out of reach here");
    expect(guideOf(connector)).toContain("`false` on a boolean property may be an absent property");
    expect(guideOf(connector)).toContain(
      "Confirm the property is present with `List-Properties` or `Get-Property-Values`",
    );
    expect(guideOf(connector)).toContain("say when a conclusion rests on that ambiguity");
    expect(guideOf(connector)).toContain("Flatten to one row per complete breakdown combination inside `execute_code`");
    expect(guideOf(connector)).toContain("drop `$overall`");
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

  it("records live reviewed digests and leaves the unavailable audit-log beta unpinned", () => {
    expect(MIXPANEL_VETTED_CATALOG.tools.size).toBe(65);
    for (const [name, record] of MIXPANEL_VETTED_CATALOG.tools) {
      if (name === "Get-Audit-Log") {
        expect(record).toEqual({ verdict: "read-only" });
        continue;
      }
      expect(name).toBeTruthy();
      expect(record.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(MIXPANEL_VETTED_CATALOG.tools.get("Fill-Event-Metadata")).toEqual({
      verdict: "destructive",
      schemaDigest: "sha256:53accc988f216bdd5d7a259d731f6df82549e4e6146b191f1815a0d1a72a1abe",
    });
  });

  it("puts the residency in the title and the guide's first line (P3)", () => {
    // `search_tools` renders a connector's title and guide summary and never
    // its description, so residency — which decides whether a project is
    // reachable at all — has to live in both.
    for (const region of ["us", "eu", "in"] as const) {
      const connector = mixpanel(`analytics_${region}`, {
        purpose: "Product decisions",
        region,
      });
      expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
        `analytics_${region}`,
        expect.objectContaining({ title: `Mixpanel (${region})` }),
      );
      const summary = connectorGuideSummary(connector);
      expect(summary).toContain("residency");
      expect(summary?.length).toBeLessThanOrEqual(120);
      expect(guideOf(connector)).toContain(`Mixpanel's ${region} endpoint`);
    }
  });

  it("declares no call-admission budget of its own (P12)", () => {
    // Mixpanel meters its MCP server per user per hour, and a per-runtime
    // counter cannot approximate a per-user quota in either direction. The
    // number belongs to the operator who knows the account.
    mixpanel("analytics", { purpose: "Product decisions" });
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty("callAdmission");

    const policy = {
      rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 300, windowMs: 3_600_000 } }],
    };
    mixpanel("bounded_analytics", {
      purpose: "Product decisions",
      callAdmission: policy,
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "bounded_analytics",
      expect.objectContaining({ callAdmission: policy }),
    );
  });

  it("rejects a region it has no endpoint for", () => {
    expect(() =>
      mixpanel("analytics", {
        purpose: "Product decisions",
        region: "apac" as never,
      }),
    ).toThrow('region to be "us", "eu", or "in"');
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

  it("INV-1: serves current hosted read schemas without a deployment override or bypassing digest checks", async () => {
    mocks.schemasAsReviewed = false;
    const reads = hostedSchemaFixtures.filter((tool) =>
      ["Get-Events", "Get-Dashboard", "List-Cohorts", "Get-Metric"].includes(tool.name),
    );
    // These are schemas, not previously served tools. Stale reviews synthesize
    // readOnlyHint:false on discovery; feeding that back as an upstream fact
    // would mistake a schema lapse for an explicit annotation conflict.
    for (const annotations of [undefined, { readOnlyHint: true }]) {
      mocks.listTools.mockResolvedValue(reads.map((tool) => ({ ...tool, ...(annotations ? { annotations } : {}) })));
      const connector = mixpanel("analytics", { purpose: "Product decisions" });
      const tools = await servedTools(connector);
      expect(tools.map((tool) => tool.classification)).toEqual(reads.map(() => "read"));
      expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
      expect(observedCatalogDrift(connector)).toMatchObject({ schemaChanges: 0, annotationConflicts: 0 });
    }
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

  it("INV-1: keeps experiment computations and metadata filling as writes with matching schemas", async () => {
    mocks.schemasAsReviewed = false;
    const writes = hostedSchemaFixtures.filter((tool) => ["Get-Experiment", "Fill-Event-Metadata"].includes(tool.name));
    mocks.listTools.mockResolvedValue(writes.map((tool) => ({ ...tool, annotations: { readOnlyHint: true } })));
    const connector = mixpanel("analytics", { purpose: "Product decisions" });
    const tools = await servedTools(connector);
    expect(tools.map((tool) => tool.classification)).toEqual(["write", "write"]);
    expect(tools.every((tool) => tool.annotations?.destructiveHint === true)).toBe(true);
    for (const tool of writes) {
      const recorded = MIXPANEL_VETTED_CATALOG.tools.get(tool.name)?.schemaDigest;
      expect(recorded).toBeDefined();
      expect(await vettedSchemaDigest(tool, recorded!.startsWith("sha256:") ? "legacy" : "sets-v1")).toBe(recorded);
    }
    expect(observedCatalogDrift(connector)).toMatchObject({ schemaChanges: 0 });
  });

  it("INV-1: reviews the documented audit-log beta as a read without inventing a live schema", async () => {
    mocks.schemasAsReviewed = false;
    mocks.listTools.mockResolvedValue([{ name: "Get-Audit-Log" }]);
    const tools = await servedTools(mixpanel("analytics", { purpose: "Organization audit history" }));
    expect(tools[0]?.classification).toBe("read");
    expect(MIXPANEL_VETTED_CATALOG.tools.get("Get-Audit-Log")?.schemaDigest).toBeUndefined();
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

  it("rejects an empty account purpose at construction", () => {
    expect(() => mixpanel("analytics", { purpose: "  " })).toThrow("a non-empty purpose");
  });
});
