import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../src/types.js";
import {
  guideOf,
  itClassifiesLikeARelease,
  mockRemoteMcp,
} from "./fixtures/hosted-provider.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../src/connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the constructor is stubbed. `withCredentialDefaults` is pure option
  // shaping — part of what these tests assert the provider resolved — so it
  // stays real.
  ...(await importOriginal<typeof import("../src/connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import {
  MIXPANEL_MCP_ENDPOINTS,
  MIXPANEL_VETTED_CATALOG,
  mixpanel,
} from "../src/providers/mixpanel.js";
import { connectorGuideSummary } from "../src/skills.js";

describe("mixpanel()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
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
          "Mixpanel product analytics (US residency) — Growth team product decisions",
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
    expect(guideOf(connector)).toContain(
      "`Get-Business-Context` requires either `project_id` or `organization_id`",
    );
    expect(guideOf(connector)).toContain(
      "`Get-Property-Values` requires `properties` or the deprecated `property` alias. " +
        "Event property values also require `event`",
    );
    expect(guideOf(connector)).toContain(
      "`List-Properties` accepts `names` or `query`, never both",
    );
    // What Insights cannot answer and where its values lie (#430): the four
    // reduction bullets the schemas cannot carry.
    expect(guideOf(connector)).toContain(
      "One analysis is one `execute_code` program: fetch `Get-Query-Schema` once",
    );
    expect(guideOf(connector)).toContain("Never return raw `Run-Query` output.");
    expect(guideOf(connector)).toContain(
      "Insights, funnels, and retention answer aggregate questions",
    );
    expect(guideOf(connector)).toContain("no per-`distinct_id` event timeline");
    expect(guideOf(connector)).toContain("`Get-User-Replays-Data` covers");
    expect(guideOf(connector)).toContain(
      "tell the user the question is out of reach here",
    );
    expect(guideOf(connector)).toContain(
      "`false` on a boolean property may be an absent property",
    );
    expect(guideOf(connector)).toContain(
      "Confirm the property is present with `List-Properties` or `Get-Property-Values`",
    );
    expect(guideOf(connector)).toContain(
      "say when a conclusion rests on that ambiguity",
    );
    expect(guideOf(connector)).toContain(
      "Flatten to one row per complete breakdown combination inside `execute_code`",
    );
    expect(guideOf(connector)).toContain("drop `$overall`");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Account instructions");
    expect(guideOf(connector)).not.toContain("+## Account instructions");
    expect(guideOf(connector)).toContain(
      "Use project 42 unless the request names another project.",
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

  it("records a reviewed schema digest for every classified tool", () => {
    expect(MIXPANEL_VETTED_CATALOG.tools.size).toBe(64);
    for (const [name, record] of MIXPANEL_VETTED_CATALOG.tools) {
      expect(name).toBeTruthy();
      expect(record.schemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(MIXPANEL_VETTED_CATALOG.tools.get("Fill-Event-Metadata")).toEqual({
      verdict: "destructive",
      schemaDigest:
        "sha256:53accc988f216bdd5d7a259d731f6df82549e4e6146b191f1815a0d1a72a1abe",
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
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty(
      "callAdmission",
    );

    const policy = {
      rules: [
        { budget: { kind: "rolling-window" as const, maxCalls: 300, windowMs: 3_600_000 } },
      ],
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
    ).toThrow('region must be "us", "eu", or "in"');
  });

  itClassifiesLikeARelease(
    () => mixpanel("analytics", { purpose: "Product decisions" }),
    mocks,
    {
      read: ["Run-Query", "List-Dashboards", "Get-Report"],
      write: "Create-Dashboard",
      destructive: "Delete-Dashboard",
      unknown: ["Brand-New-Tool", "Get-Brand-New-Thing", "Wreck-Brand-New-Thing"],
    },
  );

  it("rejects an empty account purpose at construction", () => {
    expect(() => mixpanel("analytics", { purpose: "  " })).toThrow(
      "mixpanel() requires a non-empty account purpose.",
    );
  });
});
