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
  REVENUECAT_MCP_ENDPOINT,
  REVENUECAT_VETTED_CATALOG,
  revenuecat,
} from "../src/providers/revenuecat.js";
import { connectorGuideSummary } from "../src/skills.js";

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
    expect(guideOf(connector)).toContain(
      "Never grant a promotional entitlement without a ticket.",
    );
  });

  it("declares no admission budget, because six domain limits cannot be one rule (P12)", () => {
    revenuecat("revenuecat", { purpose: "Subscription questions" });
    const options = mocks.remoteMcp.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty("callAdmission");
    expect(options).not.toHaveProperty("maxResultBytes");
  });

  it("passes an operator-declared budget and result cap through", () => {
    const callAdmission = {
      rules: [
        {
          maxConcurrency: 4,
          budget: {
            kind: "rolling-window" as const,
            maxCalls: 25,
            windowMs: 60_000,
          },
        },
      ],
    };
    revenuecat("revenuecat", {
      purpose: "Chart-heavy revenue reporting",
      callAdmission,
      maxResultBytes: 25_000,
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "revenuecat",
      expect.objectContaining({ callAdmission, maxResultBytes: 25_000 }),
    );
  });

  it("leads the OAuth guide with list-projects and refuses to guess (P8)", () => {
    const connector = revenuecat("revenuecat", {
      purpose: "Subscription state across every mobile app we ship",
    });
    const guide = guideOf(connector);

    expect(guide).toContain(
      "Account-scoped connection: this OAuth session reaches every RevenueCat project the account can see.",
    );
    expect(guide).toContain(
      "Call `list-projects` first and carry the exact `project_id` it returned into every project-scoped call.",
    );
    expect(guide).toContain("Connecta does not pick a project");
    expect(guide).toContain(
      "If more than one project fits the request, stop and ask; never guess a `project_id`.",
    );
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
    expect(guide).toContain(
      "`list-projects` returns the one project this key can see",
    );
    expect(guide).toContain(
      "An empty or unexpected result means wrong connector, not missing data.",
    );
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
    expect(guideOf(connector)).toContain(
      "`list-projects` returns the one project this key can see",
    );
    expect(connectorGuideSummary(connector)).toBe(
      "One project only: Subscription state for the BePresent iOS project",
    );
  });

  it("lets a deployment override the slot copy it renders", () => {
    revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: {
        type: "credential",
        credential: { label: "iOS project key" },
        scheme: "Bearer",
      },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "bepresent_ios",
      expect.objectContaining({
        auth: {
          type: "credential",
          credential: { label: "iOS project key" },
          scheme: "Bearer",
        },
      }),
    );
  });

  it("says a read-only key fails writes at RevenueCat, not in connecta", () => {
    const guide = guideOf(
      revenuecat("bepresent_ios", {
        purpose: "Subscription state for the BePresent iOS project",
        auth: KEY_AUTH,
      }),
    );
    expect(guide).toContain(
      "It does not filter writes for a read-only key: every write is offered, reaches RevenueCat, and fails there in RevenueCat's own words.",
    );
    expect(guide).toContain(
      "route the write to a connector configured with a write-enabled key",
    );
  });

  it("tells two static connectors apart in the one field search returns (P3)", () => {
    const ios = revenuecat("bepresent_ios", {
      purpose: "Subscription state for the BePresent iOS project",
      auth: KEY_AUTH,
    });
    const scroll = revenuecat("biblescroll", {
      purpose: "Subscription state for the BibleScroll project",
      auth: KEY_AUTH,
    });
    const first = connectorGuideSummary(ios);
    const second = connectorGuideSummary(scroll);
    expect(first).toBe(
      "One project only: Subscription state for the BePresent iOS project",
    );
    expect(second).toBe(
      "One project only: Subscription state for the BibleScroll project",
    );
    expect(first).not.toEqual(second);
    for (const summary of [first, second]) {
      expect(summary?.length).toBeLessThanOrEqual(120);
    }
  });

  it("clips an over-long purpose rather than throwing at the 120-byte bound", () => {
    const connector = revenuecat("verbose", {
      purpose:
        "Subscription state, entitlement grants, refund questions, and paywall experiments for the flagship consumer project",
      auth: KEY_AUTH,
    });
    const summary = connectorGuideSummary(connector);
    expect(summary?.length).toBeLessThanOrEqual(120);
    expect(summary?.endsWith("…")).toBe(true);
    expect(summary).toContain("One project only:");
  });

  it("carries the reduction, async, and catalog-varies advice (P6, P7)", () => {
    const guide = guideOf(
      revenuecat("revenuecat", { purpose: "Subscription questions" }),
    );
    expect(guide).toContain("not a fixed set");
    expect(guide).toContain("reduce inside `execute_code`");
    expect(guide).toContain("`gives_access` on each subscription");
    expect(guide).toContain("answer access questions from `gives_access`");
    expect(guide).toContain("Page with the cursor the list returned");
    expect(guide).toContain("get-paywall-ai-task");
    expect(guide).toContain("get-product-store-state-operation");
    expect(guide).toContain("authorize_connector");
    expect(guide).toContain("call_destructive_tool");
    // The unclassified tool is named rather than left to be discovered.
    expect(guide).toContain(
      "`render-paywall-screenshot` is unclassified on purpose because",
    );
  });

  it("states RevenueCat's own per-domain rate limits in the guide (P12)", () => {
    const guide = guideOf(
      revenuecat("revenuecat", { purpose: "Subscription questions" }),
    );
    expect(guide).toContain(
      "480 requests per minute for customer information and virtual currencies, 60 for project configuration and audiences, 25 for charts and metrics",
    );
    expect(guide).toContain("`backoff_ms`");
  });

  it("names the id chain both guides depend on (P8)", () => {
    for (const auth of [undefined, KEY_AUTH]) {
      const guide = guideOf(
        revenuecat("revenuecat", {
          purpose: "Subscription questions",
          ...(auth ? { auth } : {}),
        }),
      );
      expect(guide).toContain("never guess one");
      expect(guide).toContain("`list-projects` yields the `project_id`");
      expect(guide).toContain("list-apps");
      expect(guide).toContain("list-customers");
      expect(guide).toContain(
        "A plausible-looking id belongs to another project or to nobody.",
      );
    }
  });

  it("classifies every documented tool and leaves the undocumented one closed (P5)", () => {
    const verdicts = REVENUECAT_VETTED_CATALOG.tools;
    const counts = { "read-only": 0, additive: 0, destructive: 0 };
    for (const { verdict } of verdicts.values()) counts[verdict] += 1;
    // The 2026-09-01 reading of RevenueCat's tool reference: 105 tools, of
    // which 104 carry an access column.
    expect(counts).toEqual({
      "read-only": 51,
      additive: 17,
      destructive: 36,
    });
    expect(verdicts.size).toBe(104);
    expect(verdicts.get("get-refund-request-preferences")?.verdict).toBe(
      "read-only",
    );
    expect(verdicts.has("render-paywall-screenshot")).toBe(false);
    // No digests: the scoped live catalog cannot provide a complete set (#351).
    for (const record of verdicts.values()) {
      expect(record.schemaDigest).toBeUndefined();
    }
  });

  it("keeps the argued borderline verdicts where the release put them", () => {
    const verdictFor = (name: string) =>
      REVENUECAT_VETTED_CATALOG.tools.get(name)?.verdict;
    // Additive despite reading like a mutation: nothing existing is replaced.
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
    // Their counterparts, so the pair stays legible in the approval copy.
    expect(verdictFor("detach-products-from-entitlement")).toBe("destructive");
    expect(verdictFor("detach-products-from-package")).toBe("destructive");
  });

  itClassifiesLikeARelease(
    () => revenuecat("revenuecat", { purpose: "Rehearsal" }),
    mocks,
    {
      read: [
        "list-projects",
        "get-customer",
        "get-refund-request-preferences",
      ],
      write: "create-offering",
      destructive: "grant-customer-entitlement",
      unknown: ["render-paywall-screenshot", "list-new-thing", "wreck-new-thing"],
    },
  );

  it("declares no operator credential slot or credential test (P10)", () => {
    const connector = revenuecat("revenuecat", { purpose: "Rehearsal" });
    expect(connector.credential).toBeUndefined();
    expect(connector.testCredential).toBeUndefined();
    expect(connector.testCredentials).toBeUndefined();
  });

  it("rejects an empty purpose at construction (P2)", () => {
    expect(() => revenuecat("revenuecat", { purpose: "  " })).toThrow(
      "revenuecat() requires a non-empty project purpose.",
    );
  });

  it("lets a deployment override the title without losing the guide's scoping", () => {
    const connector = revenuecat("bepresent_ios", {
      title: "RevenueCat — BePresent iOS",
      purpose: "Subscription state for the BePresent iOS project",
      auth: KEY_AUTH,
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "bepresent_ios",
      expect.objectContaining({ title: "RevenueCat — BePresent iOS" }),
    );
    expect(guideOf(connector)).toContain("Single-project connection:");
  });
});
