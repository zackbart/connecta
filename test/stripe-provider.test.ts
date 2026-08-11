import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ToolDef } from "../src/types.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../src/connectors/remote-mcp.js", () => ({
  remoteMcp: mocks.remoteMcp,
}));

import { STRIPE_MCP_ENDPOINT, stripe } from "../src/providers/stripe.js";

const context = {
  storage: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  logger: console,
  baseUrl: "https://connecta.example",
};

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

  it("owns the endpoint, OAuth default, purpose, and provider guidance", () => {
    const connector = stripe("billing_prod", {
      mode: "production",
      purpose: "Revenue and dispute questions for the main business",
      instructions: "Never refund above $500 without a human in the loop.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing_prod",
      expect.objectContaining({
        url: STRIPE_MCP_ENDPOINT,
        title: "Stripe (production)",
        description:
          "Stripe payments (production — live money and real customers) — Revenue and dispute questions for the main business",
        auth: { type: "oauth" },
        requireHttps: true,
      }),
    );
    expect(connector.usageGuide).toContain("Mode: production");
    expect(connector.usageGuide).toContain("PRODUCTION account");
    expect(connector.usageGuide).toContain("stripe_api_details");
    // The dedicated tools must stay named: a refund routed through the generic
    // `stripe_api_write` degrades the approval prompt a human actually reads.
    expect(connector.usageGuide).toContain("create_refund");
    expect(connector.usageGuide).toContain("get_stripe_account_info");
    expect(connector.usageGuide).toContain("Idempotency-Key");
    expect(connector.usageGuide).toContain("100 requests per second");
    // Real markdown, not a diff hunk: agents read this string verbatim.
    expect(connector.usageGuide).toContain("## Account instructions");
    expect(connector.usageGuide).not.toContain("+## Account instructions");
    expect(connector.usageGuide).toContain(
      "Never refund above $500 without a human in the loop.",
    );
  });

  it("makes the sandbox distinction unmissable in every agent-facing string", () => {
    const connector = stripe("billing_sandbox", {
      mode: "sandbox",
      purpose: "Rehearsing billing changes before they touch production",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing_sandbox",
      expect.objectContaining({
        title: "Stripe (sandbox)",
        description:
          "Stripe payments (sandbox — test data, no real money) — Rehearsing billing changes before they touch production",
      }),
    );
    expect(connector.usageGuide).toContain("Mode: sandbox");
    expect(connector.usageGuide).toContain("SANDBOX account");
    expect(connector.usageGuide).toContain("never answer a question about live");
    expect(connector.usageGuide).toContain("25 requests per second");
  });

  it("scales the admission budget to the mode's documented rate", () => {
    stripe("prod", { mode: "production", purpose: "Live billing" });
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

    stripe("test", { mode: "sandbox", purpose: "Rehearsal" });
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
      stripe("connected", {
        mode: "production",
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
      mode: "sandbox",
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
      mode: "sandbox",
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
      mode: "sandbox",
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
      mode: "sandbox",
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

  it("rejects an empty account purpose and an unknown mode at construction", () => {
    expect(() =>
      stripe("billing", { mode: "sandbox", purpose: "  " }),
    ).toThrow("stripe() requires a non-empty account purpose.");
    expect(() =>
      stripe("billing", {
        mode: "test" as unknown as "sandbox",
        purpose: "Rehearsal",
      }),
    ).toThrow('stripe("billing") requires mode "production" or "sandbox".');
  });
});
