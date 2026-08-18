import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ToolDef } from "../src/types.js";

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

import { STRIPE_MCP_ENDPOINT, stripe } from "../src/providers/stripe.js";
import { connectorGuideSummary } from "../src/skills.js";

const context = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: console,
  baseUrl: "https://connecta.example",
};


/**
 * Every maintained provider guide is structured now (H13, P7), so a guide
 * assertion reads its `content` rather than the connector field.
 */
function guideOf(connector: Connector): string {
  const guide = connector.usageGuide;
  if (typeof guide !== "object" || guide === undefined) {
    throw new Error("expected a structured usage guide");
  }
  return guide.content;
}

describe("stripe()", () => {
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

  it("owns the endpoint, OAuth default, purpose, and mixed-mode guidance", () => {
    const connector = stripe("billing", {
      purpose: "Revenue and dispute questions for the business",
      instructions: "Never refund above $500 without a human in the loop.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing",
      expect.objectContaining({
        url: STRIPE_MCP_ENDPOINT,
        title: "Stripe",
        description:
          "Stripe payments (live and sandbox accounts) — Revenue and dispute questions for the business",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    expect(guideOf(connector)).toContain("Scope: live and sandbox accounts");
    expect(guideOf(connector)).toContain("list_available_accounts_or_orgs");
    expect(guideOf(connector)).toContain("stripe_context");
    expect(guideOf(connector)).toContain("livemode");
    expect(guideOf(connector)).toContain("stripe_api_details");
    // The dedicated tools must stay named: a refund routed through the generic
    // `stripe_api_write` degrades the approval prompt a human actually reads.
    expect(guideOf(connector)).toContain("create_refund");
    expect(guideOf(connector)).toContain("get_stripe_account_info");
    expect(guideOf(connector)).toContain("Idempotency-Key");
    expect(guideOf(connector)).toContain(
      "100 requests per second in live mode and 25 in sandbox mode",
    );
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(guideOf(connector)).toContain("## Account instructions");
    expect(guideOf(connector)).not.toContain("+## Account instructions");
    expect(guideOf(connector)).toContain(
      "Never refund above $500 without a human in the loop.",
    );
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing",
      expect.objectContaining({
        callAdmission: {
          rules: [
            {
              maxConcurrency: 4,
              queueTimeoutMs: 5_000,
              retryAfterMs: 1_000,
              budget: {
                kind: "rolling-window",
                maxCalls: 25,
                windowMs: 1_000,
              },
            },
          ],
        },
      }),
    );
  });

  it("keeps fixed sandbox mode unmissable for a static credential", () => {
    const connector = stripe("billing_sandbox", {
      mode: "sandbox",
      purpose: "Rehearsing billing changes before they touch production",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_test_example" },
      },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing_sandbox",
      expect.objectContaining({
        title: "Stripe (sandbox)",
        description:
          "Stripe payments (sandbox — test data, no real money) — Rehearsing billing changes before they touch production",
      }),
    );
    expect(guideOf(connector)).toContain("Mode: sandbox");
    expect(guideOf(connector)).toContain("SANDBOX Stripe connection");
    expect(guideOf(connector)).toContain("never answer a question about live");
    expect(guideOf(connector)).toContain("25 requests per second");
  });

  it("declares account-scoped OAuth and fixed-mode header summaries (P7)", () => {
    // The derived summary would be "Mode: production. Account purpose: …",
    // which spends the 120-character budget on the operator's prose and buries
    // the one fact an agent must not get wrong.
    const production = stripe("live", {
      mode: "production",
      purpose: "Billing operations for the production account",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_live_example" },
      },
    });
    const oauth = stripe("organization", {
      purpose: "Billing operations across organization accounts",
    });
    const live = connectorGuideSummary(production);
    const organization = connectorGuideSummary(oauth);
    expect(live).toContain("PRODUCTION");
    expect(organization).toContain("Live and sandbox");
    expect(live).not.toEqual(organization);
    for (const summary of [live, organization]) {
      expect(summary?.length).toBeLessThanOrEqual(120);
      expect(summary).not.toContain("Account purpose");
    }
  });

  it("tells the guide to resolve ids and to expect a varying catalog (P6, P8)", () => {
    const connector = stripe("live", {
      purpose: "Billing operations",
    });
    const guide = guideOf(connector);
    expect(guide).toContain("never guess one");
    expect(guide).toContain("cus_");
    expect(guide).toContain("stripe_api_search");
    expect(guide).toContain("not a fixed set");
    expect(guide).toContain("authorize_connector");
  });

  it("tells the guide to project reads in the sandbox and to follow references search cannot filter (P7)", () => {
    for (const connector of [
      stripe("oauth", { purpose: "Billing operations" }),
      stripe("fixed", {
        mode: "sandbox",
        purpose: "Test billing",
        auth: { type: "headers", headers: { Authorization: "Bearer rk_test_example" } },
      }),
    ]) {
      const guide = guideOf(connector);
      expect(guide).toContain(
        "belongs inside `execute_code`, projected to the fields the question needs before `return`",
      );
      expect(guide).toContain("Neither `limit` nor `expand` substitutes");
      expect(guide).toContain("out of the transcript");
      expect(guide).toContain("there is no `payment_intent` field");
      expect(guide).toContain("`latest_charge`");
      expect(guide).toContain("is one program, not four turns");
      expect(guide).toContain("`outcome`, `failure_code`, `failure_message`");
    }
  });

  it("warns that OAuth can span organization accounts without trusting connector metadata", () => {
    const connector = stripe("organization_billing", {
      title: "Primary Stripe account",
      purpose: "Billing for the primary organization account",
    });
    const guide = guideOf(connector);

    expect(guide).toContain(
      "This OAuth session may expose both live and sandbox Stripe accounts.",
    );
    expect(guide).toContain(
      "Never infer the account or mode from connector metadata.",
    );
    expect(connectorGuideSummary(connector)).toContain(
      "Live and sandbox Stripe accounts",
    );
  });

  it("requires live-schema account selection and stops instead of inventing it", () => {
    const availableAccounts = [
      { stripe_context: "acct_live", livemode: true },
      { stripe_context: "acct_test", livemode: false },
    ];
    const connector = stripe("organization_billing", {
      purpose: "Organization billing",
    });
    const guide = guideOf(connector);

    expect(guide).toContain("list_available_accounts_or_orgs");
    expect(guide).toContain("stripe_context");
    expect(guide).toContain("livemode");
    expect(guide).toContain(
      "If the account, mode, or supported selector is ambiguous, stop and ask",
    );
    expect(guide).toContain("carry its `stripe_context` and `livemode` unchanged");
    expect(availableAccounts.map(({ livemode }) => livemode)).toEqual([
      true,
      false,
    ]);
    expect(guide).toContain(
      "Organization accounts are not Stripe Connect connected accounts.",
    );
    expect(guide).toContain("restricted key plus Stripe's documented");
    expect(guide).toContain("OAuth does not support that path");
  });

  it("scales the admission budget to the mode's documented rate", () => {
    stripe("prod", {
      mode: "production",
      purpose: "Live billing",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_live_example" },
      },
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "prod",
      expect.objectContaining({
        callAdmission: {
          rules: [
            {
              maxConcurrency: 8,
              queueTimeoutMs: 5_000,
              retryAfterMs: 1_000,
              budget: {
                kind: "rolling-window",
                maxCalls: 100,
                windowMs: 1_000,
              },
            },
          ],
        },
      }),
    );

    stripe("test", {
      mode: "sandbox",
      purpose: "Rehearsal",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_test_example" },
      },
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "test",
      expect.objectContaining({
        callAdmission: {
          rules: [
            {
              maxConcurrency: 4,
              queueTimeoutMs: 5_000,
              retryAfterMs: 1_000,
              budget: {
                kind: "rolling-window",
                maxCalls: 25,
                windowMs: 1_000,
              },
            },
          ],
        },
      }),
    );
  });

  it("accepts restricted-key headers, a title override, and a result cap", () => {
    stripe("platform", {
      mode: "sandbox",
      title: "Platform billing rehearsal",
      purpose: "Connect platform rehearsal",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_test_example" },
      },
      maxResultBytes: 25_000,
    });
    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({
        title: "Platform billing rehearsal",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer rk_test_example" },
        },
        maxResultBytes: 25_000,
      }),
    );
  });

  it("refuses a declared mode its supplied key contradicts", () => {
    expect(() =>
      stripe("oops", {
        mode: "sandbox",
        purpose: "Rehearsal",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer sk_live_example" },
        },
      }),
    ).toThrow(
      'stripe("oops") declares mode "sandbox" but its auth headers carry a live-mode Stripe key.',
    );
    expect(() =>
      stripe("oops", {
        mode: "production",
        purpose: "Live billing",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer rk_test_example" },
        },
      }),
    ).toThrow(
      'stripe("oops") declares mode "production" but its auth headers carry a test-mode Stripe key.',
    );
  });

  it("leaves an unrecognizable credential alone rather than guessing at it", () => {
    expect(() =>
      stripe("opaque", {
        mode: "production",
        purpose: "Live billing",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer opaque-vault-reference" },
        },
      }),
    ).not.toThrow();
  });

  it("routes a connected account through the Stripe-Account header", () => {
    stripe("connected", {
      mode: "production",
      purpose: "Billing for one managed merchant",
      connectedAccount: "acct_1234",
      auth: {
        type: "headers",
        headers: { Authorization: "Bearer rk_live_example" },
      },
    });
    expect(mocks.remoteMcp).toHaveBeenLastCalledWith(
      "connected",
      expect.objectContaining({
        auth: {
          type: "headers",
          headers: {
            Authorization: "Bearer rk_live_example",
            "Stripe-Account": "acct_1234",
          },
        },
      }),
    );
  });

  it("refuses a connected account over OAuth or with a malformed id", () => {
    expect(() =>
      // Runtime guard for JavaScript callers that bypass the discriminated type.
      // @ts-expect-error OAuth cannot configure a Stripe Connect account.
      stripe("connected", {
        purpose: "Billing for one managed merchant",
        connectedAccount: "acct_1234",
      }),
    ).toThrow("cannot reach a connected account over OAuth");
    expect(() =>
      stripe("connected", {
        mode: "production",
        purpose: "Billing for one managed merchant",
        connectedAccount: "1234",
        auth: { type: "headers", headers: { Authorization: "Bearer rk_live_x" } },
      }),
    ).toThrow('connectedAccount must be a Stripe account id ("acct_...").');
  });

  it("fills in silent annotations and fails closed on catalog drift", async () => {
    mocks.listTools.mockResolvedValue([
      // Allowlisted read, downstream silent on both hints: fill it in.
      { name: "stripe_api_read", annotations: { openWorldHint: true } },
      // Allowlisted read with no annotations object at all.
      { name: "search_stripe_documentation" },
      // Maintained additive write: leaves the read path without inflating the
      // host's approval copy with a destruction it does not perform.
      { name: "stripe_report" },
      // `create_customer` still appears in one stale Stripe doc example but is
      // absent from the documented tool table. Unclassified and unannotated
      // means fail closed.
      { name: "create_customer" },
    ]);
    const connector = stripe("billing", {
      purpose: "Rehearsal",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tools[1]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(tools[2]?.annotations).toEqual({ readOnlyHint: false });
    expect(tools[3]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("keeps a vetted destructive tool closed despite a read-only claim", async () => {
    mocks.listTools.mockResolvedValue([
      { name: "create_refund", annotations: { readOnlyHint: true } },
    ]);
    const connector = stripe("billing", {
      purpose: "Rehearsal",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("believes an explicit annotation on a tool no release has classified", async () => {
    mocks.listTools.mockResolvedValue([
      // Not on either maintained list, and the downstream calls it read-only.
      // Rewriting that to `false` would be an overrule, not a fill-in: on a
      // name no release has reviewed, the downstream's word is the only
      // evidence there is. Stripe alludes to undocumented Treasury tools that
      // will arrive exactly this way.
      { name: "get_new_treasury_thing", annotations: { readOnlyHint: true } },
      // The same rule in the other direction.
      { name: "wreck_new_thing", annotations: { destructiveHint: true } },
    ]);
    const connector = stripe("billing", {
      purpose: "Rehearsal",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(tools[1]?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("never overrules an explicit downstream annotation on a vetted read", async () => {
    mocks.listTools.mockResolvedValue([
      // The downstream says this allowlisted name now mutates something. That
      // is the downstream telling us the allowlist is stale; it wins.
      {
        name: "stripe_api_read",
        annotations: { destructiveHint: true, openWorldHint: true },
      },
      // Same story stated the other way round.
      { name: "get_balance_summary", annotations: { readOnlyHint: false } },
    ]);
    const connector = stripe("billing", {
      purpose: "Rehearsal",
    });
    const tools = await connector.listTools(context);

    expect(tools[0]?.annotations).toEqual({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(tools[0]?.annotations?.readOnlyHint).toBeUndefined();
    expect(tools[1]?.annotations).toEqual({ readOnlyHint: false });
  });

  it("rejects an empty purpose and an unknown static mode at construction", () => {
    expect(() => stripe("billing", { purpose: "  " })).toThrow(
      "stripe() requires a non-empty account purpose.",
    );
    expect(() =>
      stripe("billing", {
        mode: "test" as unknown as "sandbox",
        purpose: "Rehearsal",
        auth: {
          type: "headers",
          headers: { Authorization: "Bearer opaque-key" },
        },
      }),
    ).toThrow(
      'stripe("billing") with headers auth requires mode "production" or "sandbox".',
    );
  });

  it("takes an operator-managed key and still requires a declared mode", () => {
    const connector = stripe("billing", {
      mode: "production",
      purpose: "Organization billing",
      auth: { type: "credential" },
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing",
      expect.objectContaining({
        title: "Stripe (production)",
        auth: {
          type: "credential",
          credential: expect.objectContaining({
            label: "Secret or restricted API key",
          }),
        },
      }),
    );
    // A static credential has one mode whether it came from the deployment or
    // from /credentials, so it gets the fixed-mode guide, not the OAuth one.
    expect(guideOf(connector)).toContain("Mode: production");
    expect(guideOf(connector)).toContain("This is a PRODUCTION Stripe connection.");

    expect(() =>
      stripe("billing", {
        purpose: "Organization billing",
        auth: { type: "credential" },
      } as unknown as Parameters<typeof stripe>[1]),
    ).toThrow(
      'stripe("billing") with headers auth requires mode "production" or "sandbox".',
    );
  });

  it("cannot check a mode against a key it will never see", () => {
    // The literal-header path asserts the key's prefix. An operator-managed
    // credential has nothing to read at construction, so the declared mode
    // stands alone rather than being guessed at or refused.
    expect(() =>
      stripe("sandboxed", {
        mode: "sandbox",
        purpose: "Rehearsal",
        auth: { type: "credential" },
      }),
    ).not.toThrow();
  });

  it("refuses a connected account it cannot add a second header for", () => {
    expect(() =>
      stripe("connected", {
        mode: "production",
        purpose: "Connect platform billing",
        connectedAccount: "acct_123",
        auth: { type: "credential" },
      }),
    ).toThrow("Stripe-Account is a second static header");
  });

  it("rejects a connector-wide mode for OAuth at runtime", () => {
    expect(() =>
      // Runtime guard for JavaScript callers and stale compiled deployments.
      // @ts-expect-error OAuth account mode must come from Stripe's account list.
      stripe("billing", {
        mode: "production",
        purpose: "Organization billing",
        auth: { type: "oauth" },
      }),
    ).toThrow("cannot declare a connector-wide mode for OAuth");
  });
});
