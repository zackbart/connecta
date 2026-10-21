import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { required } from "../../../test/helpers.js";
import {
  guideOf,
  itClassifiesLikeARelease,
  mockRemoteMcp,
  servedTools,
} from "../../../test/fixtures/hosted-provider.js";

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

import { LINEAR_MCP_ENDPOINTS, linear } from "./index.js";
import { hostedCatalog } from "./fixtures.js";
import drift from "./drift.json";
import { observedCatalogDrift, vettedSchemaDigest } from "../../catalog-drift.js";
import { connectorGuideSummary } from "../../skills.js";

describe("linear()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
    const construct = required(mocks.remoteMcp.getMockImplementation());
    mocks.remoteMcp.mockImplementation((id, options) => {
      const connector = construct(id, options);
      // Annotation-only cases still supply the reviewed vendor schemas. An
      // explicit schema on a case overrides the capture for drift regressions.
      connector.listTools = async () =>
        (await mocks.listTools()).map((tool) => ({
          inputSchema: hostedCatalog.find((captured) => captured.name === tool.name)?.inputSchema,
          ...tool,
        }));
      return connector;
    });
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
        description: "Linear issue tracking and project planning — Platform team issue and project planning",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    // Conventions the schemas cannot express.
    expect(guideOf(connector)).toContain("ENG-123");
    expect(guideOf(connector)).toContain("upsert");
    expect(guideOf(connector)).toContain("create_issue_label");
    expect(guideOf(connector)).toContain("save_project_label");
    expect(guideOf(connector)).toContain("children retired separately");
    expect(guideOf(connector)).toContain("mark_notification");
    expect(guideOf(connector)).toContain("Combined updates can partially succeed");
    expect(guideOf(connector)).toContain("authorize_connector");
    expect(guideOf(connector)).toContain("cursor");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Workspace instructions");
    expect(guideOf(connector)).not.toContain("+## Workspace instructions");
    expect(guideOf(connector)).toContain("File bugs into the Platform team unless told otherwise.");
  });

  it("declares no call-admission budget of its own", () => {
    linear("tracker", {
      purpose: "Roadmap questions",
      access: "read-write",
    });
    // Linear documents no MCP-specific limit and meters per user per hour, so
    // the connection invents no per-runtime ceiling. An operator may still set
    // one explicitly.
    expect(mocks.remoteMcp.mock.calls[0]?.[1]).not.toHaveProperty("callAdmission");
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
        description: "Linear issue tracking and project planning (read-only) — Reporting on delivery status",
      }),
    );
    expect(LINEAR_MCP_ENDPOINTS["read-only"]).toBe("https://mcp.linear.app/mcp/readonly");
    expect(guideOf(connector)).toContain("read-only endpoint");
    expect(guideOf(connector)).not.toContain("call_destructive_tool");
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

  it("frames an operator-managed API key the way Linear's MCP docs ask", () => {
    const connector = linear("automation_tracker", {
      purpose: "Headless release reporting",
      access: "read-only",
      auth: { type: "credential" },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "automation_tracker",
      expect.objectContaining({
        url: LINEAR_MCP_ENDPOINTS["read-only"],
        // `Authorization: Bearer <yourtoken>` per https://linear.app/docs/mcp,
        // which is the framing default — so the provider states no scheme and
        // the bare form belongs to Linear's GraphQL API, not this endpoint.
        auth: {
          type: "credential",
          credential: expect.objectContaining({ label: "Personal API key" }),
        },
      }),
    );
    // The endpoint is what limits reach; the credential's provenance is not a
    // routing fact, so the read-only guide is unchanged.
    expect(guideOf(connector)).toContain("Read-only connection");
  });

  itClassifiesLikeARelease(() => linear("tracker", { purpose: "Delivery planning", access: "read-write" }), mocks, {
    read: ["list_issues", "get_issue", "get_project"],
    write: "create_issue_label",
    destructive: "save_issue",
    unknown: ["summon_new_thing", "peek_at_new_thing", "wreck_new_thing"],
  });

  it("INV-1: reviews all 76 hosted tools, pins complete schemas, and retains only the six customer superset entries", async () => {
    const connector = linear("tracker", { purpose: "Delivery planning", access: "read-write" });
    const reviewed = required(linear.definition.classify).tools;
    expect(hostedCatalog).toHaveLength(76);
    expect(Object.keys(reviewed)).toHaveLength(82);
    const observedNames = new Set(hostedCatalog.map((tool) => tool.name));
    const absent = Object.keys(reviewed)
      .filter((name) => !observedNames.has(name))
      .sort();
    expect(absent).toEqual([
      "delete_customer",
      "delete_customer_need",
      "list_customer_needs",
      "list_customers",
      "save_customer",
      "save_customer_need",
    ]);
    expect(new Set(drift.checks[0]?.reviewed)).toEqual(new Set(Object.keys(reviewed)));
    for (const tool of hostedCatalog) {
      const entry = reviewed[tool.name];
      expect(entry, tool.name).toBeDefined();
      expect(entry).toMatchObject({ schemaDigest: await vettedSchemaDigest(tool, "legacy") });
      expect(entry).toMatchObject({
        verdict: tool.annotations?.readOnlyHint ? "read" : tool.annotations?.destructiveHint ? "destructive" : "write",
      });
    }
    mocks.listTools.mockResolvedValue(structuredClone([...hostedCatalog]));
    expect((await servedTools(connector)).map((tool) => tool.annotations)).toEqual(
      hostedCatalog.map((tool) => tool.annotations),
    );
    expect(observedCatalogDrift(connector)).toMatchObject({
      unclassifiedTools: 0,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    });
    // These entries are documentation/prior-review evidence, never invented schemas.
    for (const name of absent) expect(reviewed[name]).not.toHaveProperty("schemaDigest");
  });

  it("requires the operator to declare an access mode (P4)", () => {
    // Neither endpoint is a safe default: `read-write` hands out writes nobody
    // asked for, and `read-only` breaks a writing deployment at Linear, at
    // runtime, where no agent can repair it. So the declaration is required
    // and a deployment that forgot fails here, at construction.
    expect(() => linear("tracker", { purpose: "Delivery planning" } as never)).toThrow(
      'requires access "read-write" or "read-only"',
    );
    expect(() =>
      linear("tracker", {
        purpose: "Delivery planning",
        access: "readonly" as never,
      }),
    ).toThrow('requires access "read-write" or "read-only"');
  });
});
