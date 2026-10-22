import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
import { mockRemoteMcp, servedTools } from "../../../test/fixtures/hosted-provider.js";

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

import { REVENUECAT_MCP_ENDPOINT, REVENUECAT_VETTED_CATALOG, revenuecat } from "./index.js";
import contracts from "./contracts.fixture.json";
import { detectCatalogDrift } from "../../catalog-drift.js";

const reviewedTools: ToolDef[] = contracts.tools;
const projectCatalogNames = contracts.projectCatalog;

const KEY_AUTH = {
  type: "headers",
  headers: { Authorization: "Bearer sk_example" },
} as const;

describe("revenuecat()", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the endpoint, the OAuth default, and account-wide scoping (P9)", () => {
    revenuecat("revenuecat", {
      purpose: "Subscription state across every mobile app we ship",
      instructions: "Never grant a promotional entitlement without a ticket.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "revenuecat",
      expect.objectContaining({
        url: REVENUECAT_MCP_ENDPOINT,
        title: "RevenueCat",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    expect(REVENUECAT_MCP_ENDPOINT).toBe("https://mcp.revenuecat.ai/mcp");
  });

  it("uses a static project key", () => {
    revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: KEY_AUTH,
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "bepresent_ios",
      expect.objectContaining({
        title: "RevenueCat (single project)",
        auth: KEY_AUTH,
      }),
    );
  });

  it("takes the same single-project scope from an operator-managed key", () => {
    revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: { type: "credential" },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "bepresent_ios",
      expect.objectContaining({
        title: "RevenueCat (single project)",
        // The provider names the key; `Bearer sk_…` is RevenueCat's own form,
        // so the framing default stands.
        auth: {
          type: "credential",
          credential: expect.objectContaining({ label: "API v2 secret key" }),
        },
      }),
    );
  });

  it("INV-1: serves a 54-tool permission-gated subset without inventing the 63 absent tools", async () => {
    const facts: ToolDef[] = projectCatalogNames.map(
      (name) =>
        reviewedTools.find((t) => t.name === name) ?? {
          name,
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
    );
    mocks.listTools.mockResolvedValue(facts);
    const served = await servedTools(revenuecat("crm", { purpose: "Subscription questions", auth: KEY_AUTH }));
    expect(served.map((t) => t.name)).toEqual(projectCatalogNames);
    expect(served).toHaveLength(54);
    expect(served.filter((t) => t.classification === "write").map((t) => t.name)).toEqual(["validate-app-credentials"]);
    expect(await detectCatalogDrift(REVENUECAT_VETTED_CATALOG, facts)).toEqual({
      unclassifiedTools: 0,
      unservedTools: 0,
      annotationConflicts: 0,
      schemaChanges: 0,
    });
    const validation = reviewedTools.find((t) => t.name === "validate-app-credentials")!;
    // A future Read hint cannot silently widen our conservative review.
    mocks.listTools.mockResolvedValue([{ ...validation, annotations: { readOnlyHint: true } }]);
    expect((await servedTools(revenuecat("crm", { purpose: "Subscription questions" })))[0]?.classification).toBe(
      "write",
    );
  });

  it("declares no operator credential slot or credential test (P10)", () => {
    const connector = revenuecat("revenuecat", { purpose: "Rehearsal" });
    expect(connector.credential).toBeUndefined();
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeUndefined();
  });
});
