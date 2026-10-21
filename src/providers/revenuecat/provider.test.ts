import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDef } from "../../types.js";
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

import { REVENUECAT_MCP_ENDPOINT, REVENUECAT_VETTED_CATALOG, revenuecat } from "./index.js";
import contracts from "./contracts.fixture.json";
import { detectCatalogDrift } from "../../catalog-drift.js";
import { connectorGuideSummary } from "../../skills.js";

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
    const connector = revenuecat("revenuecat", {
      purpose: "Subscription state across every mobile app we ship",
      instructions: "Never grant a promotional entitlement without a ticket.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "revenuecat",
      expect.objectContaining({
        url: REVENUECAT_MCP_ENDPOINT,
        title: "RevenueCat",
        description:
          "RevenueCat subscriptions and revenue (every project the account can reach) — Subscription state across every mobile app we ship",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    expect(REVENUECAT_MCP_ENDPOINT).toBe("https://mcp.revenuecat.ai/mcp");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Project instructions");
    expect(guideOf(connector)).not.toContain("+## Project instructions");
    expect(guideOf(connector)).toContain("Never grant a promotional entitlement without a ticket.");
  });

  it("declares no admission budget, because six domain limits cannot be one rule (P12)", () => {
    revenuecat("revenuecat", { purpose: "Subscription questions" });
    const options = mocks.remoteMcp.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).not.toHaveProperty("callAdmission");
    expect(options).not.toHaveProperty("maxResultBytes");
  });

  it("binds a static key to one project and says a second project is a second connector", () => {
    const connector = revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: KEY_AUTH,
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "bepresent_ios",
      expect.objectContaining({
        title: "RevenueCat (single project)",
        description:
          "RevenueCat subscriptions and revenue (one project, static key) — Subscription state for the BePresent iOS project",
        auth: KEY_AUTH,
      }),
    );
    const guide = guideOf(connector);
    // P3: the routing fact — which project — opens the guide, because that is
    // the summary fallback and the only place the project can be named.
    expect(guide.split("\n")[2]).toBe(
      "Single-project connection: Subscription state for the BePresent iOS project. RevenueCat secret API keys are project-wide, so this key reaches exactly one project and nothing outside it. A second project is a second connector with its own key and its own id — never a `project_id` argument pointed somewhere else.",
    );
    expect(guide).toContain("`list-projects` returns the one project this key can see");
    expect(guide).toContain("An empty or unexpected result means wrong connector, not missing data.");
  });

  it("takes the same single-project scope from an operator-managed key", () => {
    const connector = revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: { type: "credential" },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "bepresent_ios",
      expect.objectContaining({
        title: "RevenueCat (single project)",
        description:
          "RevenueCat subscriptions and revenue (one project, static key) — Subscription state for the BePresent iOS project",
        // The provider names the key; `Bearer sk_…` is RevenueCat's own form,
        // so the framing default stands.
        auth: {
          type: "credential",
          credential: expect.objectContaining({ label: "API v2 secret key" }),
        },
      }),
    );
    // Where the key came from changes nothing about scope, so the guide is the
    // single-project one, not the account-wide one.
    expect(guideOf(connector)).toContain("`list-projects` returns the one project this key can see");
    expect(connectorGuideSummary(connector)).toBe("One project only: Subscription state for the BePresent iOS project");
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

  it("keeps the argued borderline verdicts where the release put them", () => {
    const verdictFor = (name: string) => REVENUECAT_VETTED_CATALOG.tools.get(name)?.verdict;
    // Retained write verdicts; validation is conservative pending persistence evidence.
    expect(verdictFor("equalize-subscription-prices")).toBe("additive");
    expect(verdictFor("validate-app-credentials")).toBe("additive");
    expect(verdictFor("upload-product-store-state-screenshot")).toBe("additive");
    expect(verdictFor("attach-products-to-entitlement")).toBe("additive");
    expect(verdictFor("attach-products-to-package")).toBe("additive");
    expect(verdictFor("duplicate-paywall")).toBe("additive");
    expect(verdictFor("create-paywall-ai")).toBe("additive");
    // Destructive despite the verb: each overwrites state that already exists.
    expect(verdictFor("create-product-prices")).toBe("destructive");
    expect(verdictFor("edit-paywall-ai")).toBe("destructive");
    // Destructive on consequence, not on the verb: customer data to a typed URL,
    // and paid access or a served offering changed for a live customer.
    expect(verdictFor("create-webhook-integration")).toBe("destructive");
    expect(verdictFor("grant-customer-entitlement")).toBe("destructive");
    expect(verdictFor("assign-customer-offering")).toBe("destructive");
    expect(verdictFor("unarchive-product")).toBe("destructive");
    // The store-state plan family: create brings a draft into being; the rest
    // act on a plan record that already exists, and apply pushes the whole
    // plan into RevenueCat and the stores.
    expect(verdictFor("create-product-store-state-plan")).toBe("additive");
    expect(verdictFor("plan-product-store-state-plan")).toBe("destructive");
    expect(verdictFor("apply-product-store-state-plan")).toBe("destructive");
    expect(verdictFor("update-product-store-state-plan")).toBe("destructive");
    expect(verdictFor("discard-product-store-state-plan")).toBe("destructive");
    // Targeting rules follow the verb.
    expect(verdictFor("create-targeting-rule")).toBe("additive");
    expect(verdictFor("update-targeting-rule")).toBe("destructive");
    expect(verdictFor("delete-targeting-rule")).toBe("destructive");
    // Their counterparts, so the pair stays legible in the approval copy.
    expect(verdictFor("detach-products-from-entitlement")).toBe("destructive");
    expect(verdictFor("detach-products-from-package")).toBe("destructive");
  });

  itClassifiesLikeARelease(() => revenuecat("revenuecat", { purpose: "Rehearsal" }), mocks, {
    read: ["list-projects", "get-customer", "get-refund-request-preferences"],
    write: "create-offering",
    destructive: "grant-customer-entitlement",
    unknown: ["new-silent-tool", "list-new-thing", "wreck-new-thing"],
  });

  it("declares no operator credential slot or credential test (P10)", () => {
    const connector = revenuecat("revenuecat", { purpose: "Rehearsal" });
    expect(connector.credential).toBeUndefined();
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeUndefined();
  });
});
