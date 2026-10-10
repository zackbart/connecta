import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ConnectorContext, ToolDef } from "../../types.js";
import { guideOf, itClassifiesLikeARelease, mockRemoteMcp } from "../../../test/fixtures/hosted-provider.js";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { ConnectorCallError } from "../../errors.js";

const mocks = vi.hoisted(() => ({
  listTools: vi.fn<() => Promise<ToolDef[]>>(),
  remoteMcp: vi.fn(),
}));

vi.mock("../../connectors/remote-mcp.js", async (importOriginal) => ({
  // Only the hosted constructor is stubbed; the REST connector never touches it.
  ...(await importOriginal<typeof import("../../connectors/remote-mcp.js")>()),
  remoteMcp: mocks.remoteMcp,
}));

import { STRIPE_API_BASE_URL, STRIPE_MCP_ENDPOINT, stripe } from "./index.js";
import { connectorGuideSummary } from "../../skills.js";

const SANDBOX = { purpose: "Rehearsing billing changes", auth: { type: "apiKey" }, mode: "sandbox" } as const;
const LIVE = { purpose: "Revenue for the real business", auth: { type: "apiKey" }, mode: "production" } as const;

describe("stripe() over OAuth", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("owns the hosted endpoint, OAuth only, purpose, sandbox admission, and mixed-mode guidance", () => {
    const connector = stripe("billing", {
      purpose: "Revenue and dispute questions for the business",
      auth: { type: "oauth" },
      instructions: "Never refund above $500 without a human in the loop.",
    });

    expect(mocks.remoteMcp).toHaveBeenCalledWith(
      "billing",
      expect.objectContaining({
        url: STRIPE_MCP_ENDPOINT,
        title: "Stripe",
        description: "Stripe payments (live and sandbox accounts) — Revenue and dispute questions for the business",
        auth: { type: "oauth" },
        requireHttps: true,
        callAdmission: {
          rules: [
            {
              maxConcurrency: 4,
              queueTimeoutMs: 5_000,
              retryAfterMs: 1_000,
              budget: { kind: "rolling-window", maxCalls: 25, windowMs: 1_000 },
            },
          ],
        },
      }),
    );
    const guide = guideOf(connector);
    expect(guide).toContain("Scope: live and sandbox accounts");
    for (const text of [
      "list_available_accounts_or_orgs",
      "stripe_context",
      "livemode",
      "stripe_api_details",
      "stripe_analytics",
      "stripe_implementation_planner",
      "search_stripe_documentation",
      "Idempotency-Key",
      "100 requests per second in live mode and 25 in sandbox mode",
      "## Account instructions",
      "Never refund above $500 without a human in the loop.",
    ]) {
      expect(guide).toContain(text);
    }
    expect(guide).not.toContain("create_refund");
    expect(guide).not.toContain("+## Account instructions");
    // The key guide's REST mechanics never leak into the OAuth guide.
    expect(guide).not.toContain("page.param");
    expect(guide).not.toContain("operator-managed key");
  });

  it("INV-11: refuses key-only options and non-OAuth auth on the hosted path by name", () => {
    expect(() =>
      // @ts-expect-error OAuth takes no connector-wide mode; Stripe returns mode with each account.
      stripe("billing", { purpose: "Organization billing", auth: { type: "oauth" }, mode: "production" }),
    ).toThrow('Unknown option: stripe("billing").mode.');
    expect(() =>
      // @ts-expect-error OAuth cannot configure a Stripe Connect account.
      stripe("billing", { purpose: "Organization billing", auth: { type: "oauth" }, connectedAccount: "acct_1" }),
    ).toThrow('Unknown option: stripe("billing").connectedAccount.');
    for (const type of ["headers", "credential", "request"]) {
      expect(() => stripe("billing", { purpose: "Billing", auth: { type } } as never)).toThrow(
        'stripe("billing") requires auth.type to be one of "oauth", "apiKey".',
      );
    }
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
  });

  it("warns that OAuth spans organization accounts and stops instead of inventing a selector", () => {
    const connector = stripe("organization_billing", {
      title: "Primary Stripe account",
      purpose: "Billing for the primary organization account",
      auth: { type: "oauth" },
    });
    const guide = guideOf(connector);
    expect(guide).toContain("This OAuth session may expose both live and sandbox Stripe accounts.");
    expect(guide).toContain("Never infer the account or mode from connector metadata.");
    expect(guide).toContain("If the account, mode, or supported selector is ambiguous, stop and ask");
    expect(guide).toContain("carry the exact context fields required by the live schema unchanged");
    expect(guide).toContain("Organization accounts are not Stripe Connect connected accounts.");
    expect(guide).toContain("separate API-key connector whose `connectedAccount` sends");
    expect(guide).toContain("OAuth does not support that path");
    expect(connectorGuideSummary(connector)).toContain("Live and sandbox Stripe accounts");
  });

  itClassifiesLikeARelease(() => stripe("billing", { purpose: "Rehearsal", auth: { type: "oauth" } }), mocks, {
    read: ["stripe_api_read", "list_available_accounts_or_orgs", "manage_stripe_accounts"],
    write: "stripe_analytics",
    destructive: "stripe_api_write",
    unknown: ["create_customer", "get_new_treasury_thing", "wreck_new_thing"],
  });
});

describe("stripe() guides (P6, P7, P8)", () => {
  beforeEach(() => {
    mockRemoteMcp(mocks);
  });

  it("declares mode-leading summaries for both implementations", () => {
    const live = connectorGuideSummary(stripe("live", LIVE));
    const sandbox = connectorGuideSummary(stripe("test", SANDBOX));
    const oauth = connectorGuideSummary(stripe("org", { purpose: "Billing", auth: { type: "oauth" } }));
    expect(live).toMatch(/^PRODUCTION: real money\./);
    expect(sandbox).toMatch(/^Sandbox: test data only\./);
    expect(oauth).toContain("Live and sandbox");
    for (const summary of [live, sandbox, oauth]) {
      expect(new TextEncoder().encode(summary ?? "").length).toBeLessThanOrEqual(120);
      expect(summary).not.toContain("purpose");
    }
  });

  it("shares id, search-filter, decline, amount, and projection conventions across both guides", () => {
    for (const connector of [
      stripe("oauth", { purpose: "Billing", auth: { type: "oauth" } }),
      stripe("key", SANDBOX),
    ]) {
      const guide = guideOf(connector);
      for (const text of [
        "never guess one",
        "cus_",
        "stripe_api_search",
        "there is no `payment_intent` field",
        "`latest_charge`",
        "is one program, not four turns",
        "`outcome`, `failure_code`, `failure_message`",
        "Never send a decimal.",
        "inside `execute_code`",
        "out of the transcript",
        "authorize_connector",
      ]) {
        expect(guide, text).toContain(text);
      }
    }
    expect(guideOf(stripe("oauth", { purpose: "Billing", auth: { type: "oauth" } }))).toContain("not a fixed set");
  });

  it("keeps fixed mode unmissable and names what the key path cannot do", () => {
    const sandbox = guideOf(stripe("test", SANDBOX));
    expect(sandbox).toContain("Mode: sandbox");
    expect(sandbox).toContain("SANDBOX Stripe connection");
    expect(sandbox).toContain("never answer a question about live");
    expect(sandbox).toContain("25 requests per second, and any single endpoint");
    expect(sandbox).toContain("`lock_timeout` is a lock conflict");
    expect(sandbox).toContain("natural-language Sigma, metrics, documentation search, implementation planner");
    expect(sandbox).not.toContain("stripe_context` and `livemode` wherever");
    const live = guideOf(stripe("live", { ...LIVE, connectedAccount: "acct_123" }));
    expect(live).toContain("This is a PRODUCTION Stripe connection.");
    expect(live).toContain("100 requests per second, and any single endpoint");
    expect(live).toContain("Connected account: `acct_123`.");
  });
});

interface Sent {
  url: URL;
  method: string;
  headers: Headers;
  body: string | undefined;
}

describe("stripe() over an API key", () => {
  let sent: Sent[];
  let respond: (request: Sent) => Response;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    mockRemoteMcp(mocks);
    sent = [];
    respond = () => Response.json({ object: "list", data: [], has_more: false });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: Sent = {
        url: new URL(String(input)),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      sent.push(request);
      return respond(request);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const keyed = (key = "rk_test_51abc"): ConnectorContext => ({
    ...connectorContext(),
    credential: { get: async () => key, getAll: async () => ({ value: key }) },
  });

  async function refusal(promise: Promise<unknown>): Promise<ConnectorCallError> {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    return error as ConnectorCallError;
  }

  it("builds Connecta's REST connector with a mode title, an operator credential, and per-mode admission", async () => {
    const sandbox = stripe("billing_sandbox", { ...SANDBOX, maxResultBytes: 25_000 });
    expect(mocks.remoteMcp).not.toHaveBeenCalled();
    expect(sandbox).toMatchObject({
      kind: "api",
      title: "Stripe (sandbox)",
      description: "Stripe payments (sandbox — test data, no real money) — Rehearsing billing changes",
      maxResultBytes: 25_000,
      credential: { label: "Stripe test-mode secret or restricted key", placeholder: "rk_test_…" },
      callAdmission: { rules: [{ maxConcurrency: 4, budget: { maxCalls: 25, windowMs: 1_000 } }] },
    });
    expect(sandbox.describe?.()).toMatchObject({
      source: { kind: "api", provider: "stripe" },
      auth: { mode: "credential" },
    });
    const live = stripe("billing", { ...LIVE, title: "Billing" });
    expect(live).toMatchObject({
      title: "Billing",
      credential: { label: "Stripe live-mode secret or restricted key" },
      callAdmission: { rules: [{ maxConcurrency: 8, budget: { maxCalls: 100, windowMs: 1_000 } }] },
    });
    expect((await live.listTools(keyed())).map((tool) => tool.name)).toEqual([
      "stripe_api_search",
      "stripe_api_details",
      "stripe_api_read",
      "stripe_api_write",
      "get_stripe_account_info",
      "get_balance_summary",
    ]);
    expect(sent).toEqual([]);
  });

  it("INV-11: requires a mode and a well-formed connected account at construction", () => {
    expect(() => stripe("billing", { purpose: "Billing", auth: { type: "apiKey" } } as never)).toThrow(
      'stripe("billing") requires mode "production" or "sandbox" with apiKey auth.',
    );
    expect(() => stripe("billing", { ...SANDBOX, mode: "test" } as never)).toThrow('mode "production" or "sandbox"');
    expect(() => stripe("billing", { ...LIVE, connectedAccount: "1234" })).toThrow(
      'stripe("billing") requires connectedAccount to be a Stripe account id ("acct_...").',
    );
    expect(() => stripe("billing", { ...SANDBOX, headers: {} } as never)).toThrow(
      'Unknown option: stripe("billing").headers.',
    );
    expect(() => stripe("billing", { ...SANDBOX, auth: { type: "apiKey", key: "sk_test_x" } } as never)).toThrow(
      'Unknown option: stripe("billing").auth.key.',
    );
    expect(() => stripe("billing", { ...SANDBOX, purpose: " " })).toThrow("a non-empty purpose");
  });

  it("INV-1: annotates its own tools and enforces the read rule in the read handler", async () => {
    const connector = stripe("billing", SANDBOX);
    const tools = await connector.listTools(keyed());
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))).toEqual({
      stripe_api_search: { readOnlyHint: true },
      stripe_api_details: { readOnlyHint: true },
      stripe_api_read: { readOnlyHint: true },
      stripe_api_write: { readOnlyHint: false, destructiveHint: true },
      get_stripe_account_info: { readOnlyHint: true },
      get_balance_summary: { readOnlyHint: true },
    });
    expect(connector.classification).toBeUndefined();
    const refused = await refusal(
      connector.callTool("stripe_api_read", { method: "POST", path: "/v1/customers", body: {} }, keyed()),
    );
    expect(refused.message).toContain("call it with stripe_api_write");
    // Tax calculations persist and bill per call, so they stay writes.
    expect(
      (await refusal(connector.callTool("stripe_api_read", { method: "POST", path: "/v1/tax/calculations" }, keyed())))
        .message,
    ).toContain("is not a reviewed read");
    expect(sent).toEqual([]);
    respond = () => Response.json({ object: "invoice", id: "upcoming_in_1", total: 1099 });
    await connector.callTool(
      "stripe_api_read",
      { method: "POST", path: "/v1/invoices/create_preview", body: { customer: "cus_1" } },
      keyed(),
    );
    expect(sent[0]).toMatchObject({ method: "POST", body: "customer=cus_1" });
  });

  it("INV-10: finds operations and their contracts in the pinned index without a request", async () => {
    const connector = stripe("billing", SANDBOX);
    const found = (await connector.callTool("stripe_api_search", { query: "refund", method: "POST" }, keyed())) as any;
    expect(found.operations).toContainEqual(
      expect.objectContaining({ method: "POST", path: "/v1/refunds", tool: "stripe_api_write" }),
    );
    const details = (await connector.callTool(
      "stripe_api_details",
      { method: "GET", path: "/v1/payment_intents/pi_123" },
      keyed(),
    )) as any;
    expect(details).toMatchObject({ path: "/v1/payment_intents/{intent}", tool: "stripe_api_read" });
    expect(details.parameters.map((parameter: any) => parameter.name)).toContain("expand");
    expect(sent).toEqual([]);
  });

  it("refuses unknown paths and guessed parameters before anything reaches Stripe", async () => {
    const connector = stripe("billing", SANDBOX);
    const path = await refusal(connector.callTool("stripe_api_read", { path: "/v1/customer/cus_1" }, keyed()));
    expect(path.message).toContain("Nearest: GET /v1/customers/{customer}");
    const param = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/customers", body: { emial: "a@b.c" } },
        keyed(),
      ),
    );
    expect(param.message).toContain("Not sent:");
    expect(param.validation?.issues[0]).toMatchObject({ path: "/body/emial", code: "additionalProperties" });
    expect(param.validation?.issues[0]?.expected).toMatch(/^email\? one of /);
    const search = await refusal(
      connector.callTool("stripe_api_read", { path: "/v1/charges/search", query: { limit: 3 } }, keyed()),
    );
    expect(search.validation?.issues[0]).toMatchObject({ path: "/query/query", code: "required" });
    expect(sent).toEqual([]);
  });

  it("form-encodes v1 bodies and query lists, pins Stripe-Version, and acts as the connected account", async () => {
    const connector = stripe("platform", { ...LIVE, connectedAccount: "acct_123" });
    respond = () => Response.json({ id: "cus_1", object: "customer" });
    const result = (await connector.callTool(
      "stripe_api_write",
      {
        method: "POST",
        path: "/v1/customers/cus_1",
        body: {
          email: "a@example.com",
          metadata: { tier: "gold", stale: "" },
          invoice_settings: { custom_fields: [{ name: "PO", value: "42" }], default_payment_method: null },
          tax_exempt: "none",
          preferred_locales: [],
        },
      },
      keyed("rk_live_51abc"),
    )) as any;
    expect(result).toMatchObject({ status: 200, data: { id: "cus_1" }, idempotencyKey: expect.any(String) });
    const [request] = sent;
    expect(request!.url.href).toBe(`${STRIPE_API_BASE_URL}/v1/customers/cus_1`);
    expect(decodeURIComponent(request!.body!).split("&")).toEqual([
      "email=a@example.com",
      "metadata[tier]=gold",
      "metadata[stale]=",
      "invoice_settings[custom_fields][0][name]=PO",
      "invoice_settings[custom_fields][0][value]=42",
      "invoice_settings[default_payment_method]=",
      "tax_exempt=none",
      "preferred_locales=",
    ]);
    expect(request!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request!.headers.get("authorization")).toBe("Bearer rk_live_51abc");
    expect(request!.headers.get("stripe-account")).toBe("acct_123");
    expect(request!.headers.get("stripe-version")).toBe("2026-09-30.endive");
    expect(request!.headers.get("idempotency-key")).toBe(result.idempotencyKey);

    respond = () => Response.json({ object: "list", data: [], has_more: false });
    await connector.callTool(
      "stripe_api_read",
      {
        path: "/v1/charges",
        query: { customer: "cus_1", expand: ["data.customer", "data.invoice"], created: { gte: 10 }, limit: 3 },
      },
      keyed("rk_live_51abc"),
    );
    expect(decodeURIComponent(sent[1]!.url.search)).toBe(
      "?customer=cus_1&expand[0]=data.customer&expand[1]=data.invoice&created[gte]=10&limit=3",
    );
    expect(sent[1]!.headers.get("idempotency-key")).toBeNull();
  });

  it("sends v2 bodies as JSON, repeats v2 query lists, and names the connected account with Stripe-Context", async () => {
    const connector = stripe("platform", { ...SANDBOX, connectedAccount: "acct_123" });
    respond = () => Response.json({ id: "mtr_1", object: "v2.billing.meter_event" });
    await connector.callTool(
      "stripe_api_write",
      {
        method: "POST",
        path: "/v2/billing/meter_events",
        body: { event_name: "api_call", payload: { stripe_customer_id: "cus_1", value: "1" } },
        idempotencyKey: "caller-key-1",
      },
      keyed(),
    );
    expect(sent[0]!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(sent[0]!.body!)).toEqual({
      event_name: "api_call",
      payload: { stripe_customer_id: "cus_1", value: "1" },
    });
    expect(sent[0]!.headers.get("stripe-context")).toBe("acct_123");
    expect(sent[0]!.headers.get("stripe-account")).toBeNull();
    expect(sent[0]!.headers.get("idempotency-key")).toBe("caller-key-1");
    respond = () => Response.json({ data: [], next_page_url: null });
    await connector.callTool(
      "stripe_api_read",
      { path: "/v2/core/accounts", query: { applied_configurations: ["customer", "merchant"], limit: 2 } },
      keyed(),
    );
    expect(sent[1]!.url.search).toBe("?applied_configurations=customer&applied_configurations=merchant&limit=2");
  });

  it("INV-5: refuses a key whose prefix contradicts the declared mode before any request leaves", async () => {
    const sandbox = stripe("billing", SANDBOX);
    const cases: Array<[string, string]> = [
      ["sk_live_51abc", "declared sandbox, but the configured key is a live-mode key"],
      ["pk_test_51abc", "publishable key"],
      ["sk_org_live_51abc", "organization key"],
      ["whsec_51abc", "not a Stripe secret"],
    ];
    for (const [key, message] of cases) {
      const error = await refusal(sandbox.callTool("get_balance_summary", {}, keyed(key)));
      expect(error.code).toBe("auth_required");
      expect(error.message).toContain(message);
      expect(error.message).not.toContain(key);
      const test = await sandbox.testCredential!(key, connectorContext());
      expect(test.ok).toBe(false);
      expect(test.message).toContain(message);
    }
    const live = stripe("live", LIVE);
    expect((await refusal(live.callTool("get_balance_summary", {}, keyed("rk_test_51abc")))).message).toContain(
      "declared production, but the configured key is a test-mode key",
    );
    const missing = await refusal(live.callTool("get_balance_summary", {}, connectorContext()));
    expect(missing.code).toBe("auth_required");
    expect(sent).toEqual([]);
  });

  it("tests a key against the account it reaches and accepts a restricted key without account read", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () => Response.json({ id: "acct_1", business_profile: { name: "Grace Co" } });
    expect(await connector.testCredential!(" rk_test_51abc ", connectorContext())).toEqual({
      ok: true,
      message: "Authenticated to acct_1 (Grace Co) with a test-mode key.",
    });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer rk_test_51abc");
    respond = () =>
      Response.json(
        { error: { type: "invalid_request_error", message: "The provided key does not have access." } },
        { status: 403 },
      );
    expect(await connector.testCredential!("rk_test_51abc", connectorContext())).toMatchObject({
      ok: true,
      message: expect.stringContaining("cannot read the account object"),
    });
    respond = () =>
      Response.json(
        { error: { type: "invalid_request_error", message: "Invalid API Key provided." } },
        { status: 401 },
      );
    const rejected = await connector.testCredential!("rk_test_51abc", connectorContext());
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("Invalid API Key provided.");
  });

  it("INV-9: sends a write once and returns its generated Idempotency-Key on success and failure", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () =>
      Response.json(
        { error: { type: "api_error", message: "Something went wrong." } },
        {
          status: 500,
          headers: { "request-id": "req_1" },
        },
      );
    const error = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/refunds", body: { charge: "ch_1" } },
        keyed(),
      ),
    );
    expect(sent).toHaveLength(1);
    const key = sent[0]!.headers.get("idempotency-key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain("Request req_1.");
    expect(error.message).toContain(`Idempotency-Key: ${key}. Reusing it with the exact original arguments`);
    expect(error.message).toContain("only while the vendor retains the key; after that, look the object up");
    // A caller's own key is already the caller's; the failure is passed through.
    const own = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/refunds", body: { charge: "ch_1" }, idempotencyKey: "mine" },
        keyed(),
      ),
    );
    expect(own.message).not.toContain("reuse it");
    expect(sent[1]!.headers.get("idempotency-key")).toBe("mine");
    // DELETE is idempotent by definition; Stripe ignores a key there.
    respond = () => Response.json({ id: "cus_1", deleted: true });
    expect(
      await connector.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_1" }, keyed()),
    ).toEqual({ status: 200, data: { id: "cus_1", deleted: true } });
    expect(sent[2]!.headers.get("idempotency-key")).toBeNull();
    expect(sent).toHaveLength(3);
  });

  it("INV-9: keeps a refund's generated Idempotency-Key when the connection drops while reading the reply", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const error = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/refunds", body: { charge: "ch_1" } },
        keyed(),
      ),
    );
    const key = sent[0]!.headers.get("idempotency-key");
    expect(error.code).toBe("unavailable");
    expect(error.message).toContain(`Idempotency-Key: ${key}`);
    expect(sent).toHaveLength(1);
  });

  it("maps Stripe failures by the caller's next move", async () => {
    const connector = stripe("billing", SANDBOX);
    const cases: Array<[number, Record<string, string>, Record<string, string>, string, string]> = [
      [429, { code: "lock_timeout", message: "Locked." }, {}, "conflict", "Stripe did not process this one"],
      [
        429,
        { code: "rate_limit", message: "Too many." },
        { "stripe-rate-limited-reason": "global-rate" },
        "rate_limited",
        "Limited by global-rate.",
      ],
      [
        402,
        { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Declined." },
        {},
        "connector_call_failed",
        "card_error card_declined insufficient_funds",
      ],
      [400, { type: "invalid_request_error", param: "amount", message: "Bad." }, {}, "invalid_args", "(param amount)"],
      [401, { message: "Invalid API Key provided." }, {}, "auth_required", "an operator must replace it"],
      [403, { message: "Restricted." }, {}, "provider_permission_denied", "lacks this permission"],
      [404, { code: "resource_missing", message: "No such customer." }, {}, "not_found", "Resolve the id"],
    ];
    for (const [status, error, headers, code, message] of cases) {
      respond = () => Response.json({ error }, { status, headers });
      const failure = await refusal(connector.callTool("stripe_api_read", { path: "/v1/customers/cus_1" }, keyed()));
      expect(failure.code, `${status} ${error.code}`).toBe(code);
      expect(failure.message).toContain(message);
    }
  });

  it("INV-9: reports a lock_timeout as a retryable conflict Stripe did not process, not an unknown outcome", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () => Response.json({ error: { type: "invalid_request_error", code: "lock_timeout" } }, { status: 429 });
    const error = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/refunds", body: { charge: "ch_1" } },
        keyed(),
      ),
    );
    expect(error).toMatchObject({ code: "conflict", retryable: true, retryAfterMs: 1_000 });
    expect(sent).toHaveLength(1);
  });

  it("extracts v1, search, and v2 cursors and projects select paths through lists", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () =>
      Response.json({
        object: "list",
        data: [
          { id: "ch_1", amount: 5, billing_details: { name: "Ada" } },
          { id: "ch_2", amount: 6 },
        ],
        has_more: true,
      });
    expect(
      await connector.callTool("stripe_api_read", { path: "/v1/charges", select: ["data.id", "data.amount"] }, keyed()),
    ).toEqual({
      status: 200,
      data: {
        data: [
          { id: "ch_1", amount: 5 },
          { id: "ch_2", amount: 6 },
        ],
      },
      page: { hasMore: true, next: "ch_2", param: "starting_after" },
    });
    expect(
      (
        (await connector.callTool(
          "stripe_api_read",
          { path: "/v1/charges", query: { ending_before: "ch_9" } },
          keyed(),
        )) as any
      ).page,
    ).toEqual({ hasMore: true, next: "ch_1", param: "ending_before" });
    respond = () => Response.json({ object: "search_result", data: [], has_more: true, next_page: "page_abc" });
    expect(
      (
        (await connector.callTool(
          "stripe_api_read",
          { path: "/v1/charges/search", query: { query: "amount>5" } },
          keyed(),
        )) as any
      ).page,
    ).toEqual({ hasMore: true, next: "page_abc", param: "page" });
    respond = () => Response.json({ data: [], next_page_url: "/v2/core/accounts?page=tok_2", previous_page_url: null });
    expect(((await connector.callTool("stripe_api_read", { path: "/v2/core/accounts" }, keyed())) as any).page).toEqual(
      {
        hasMore: true,
        next: "tok_2",
        param: "page",
      },
    );
    respond = () => Response.json({ object: "list", data: [{ id: "ch_1" }], has_more: false });
    expect(((await connector.callTool("stripe_api_read", { path: "/v1/charges" }, keyed())) as any).page).toEqual({
      hasMore: false,
    });
  });

  it("refuses secret expansions: Apps secret payloads and Issuing card numbers and CVCs", async () => {
    const connector = stripe("billing", SANDBOX);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      [
        "stripe_api_read",
        { path: "/v1/apps/secrets/find", query: { name: "k", scope: { type: "account" }, expand: ["payload"] } },
        "Stripe Apps secret values",
      ],
      [
        "stripe_api_read",
        { path: "/v1/apps/secrets", query: { scope: { type: "account" }, expand: ["data.payload"] } },
        "Stripe Apps secret values",
      ],
      [
        "stripe_api_read",
        { path: "/v1/issuing/cards/ic_1", query: { expand: ["number"] } },
        "Issuing card numbers and CVCs",
      ],
      [
        "stripe_api_read",
        { path: "/v1/issuing/cards", query: { expand: ["data.cvc"] } },
        "Issuing card numbers and CVCs",
      ],
      [
        "stripe_api_write",
        { method: "POST", path: "/v1/issuing/cards/ic_1", body: { expand: ["number"] } },
        "Issuing card numbers and CVCs",
      ],
    ];
    for (const [tool, args, message] of cases) {
      const error = await refusal(connector.callTool(tool, args, keyed()));
      expect(error.code).toBe("invalid_args");
      expect(error.message).toContain(message);
    }
    expect(sent).toEqual([]);
    await connector.callTool(
      "stripe_api_read",
      { path: "/v1/issuing/cards/ic_1", query: { expand: ["cardholder"] } },
      keyed(),
    );
    expect(sent).toHaveLength(1);
  });

  it("reads quote PDFs from files.stripe.com and refuses multipart uploads and the meter event stream", async () => {
    const connector = stripe("billing", SANDBOX);
    respond = () =>
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { headers: { "content-type": "application/pdf" } });
    expect(await connector.callTool("stripe_api_read", { path: "/v1/quotes/qt_1/pdf" }, keyed())).toEqual({
      status: 200,
      data: { contentType: "application/pdf", bytes: 4, base64: "JVBERg==" },
    });
    expect(sent[0]!.url.href).toBe("https://files.stripe.com/v1/quotes/qt_1/pdf");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer rk_test_51abc");
    const upload = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v1/files", body: { purpose: "dispute_evidence" } },
        keyed(),
      ),
    );
    expect(upload.message).toContain("Upload files in the Stripe Dashboard");
    const stream = await refusal(
      connector.callTool(
        "stripe_api_write",
        { method: "POST", path: "/v2/billing/meter_event_stream", body: {} },
        keyed(),
      ),
    );
    expect(stream.message).toContain("Send single events with POST /v2/billing/meter_events");
    expect(sent).toHaveLength(1);
  });

  it("projects the account and balance through the named tools", async () => {
    const connector = stripe("platform", { ...LIVE, connectedAccount: "acct_123" });
    respond = () =>
      Response.json({
        id: "acct_123",
        business_profile: { name: "Grace Co" },
        country: "US",
        default_currency: "usd",
        charges_enabled: true,
        payouts_enabled: false,
        settings: { dashboard: { display_name: "Grace" } },
        individual: { ssn_last_4: "1234" },
      });
    expect(await connector.callTool("get_stripe_account_info", {}, keyed("rk_live_51abc"))).toEqual({
      accountId: "acct_123",
      name: "Grace Co",
      country: "US",
      defaultCurrency: "usd",
      mode: "production",
      livemode: true,
      connectedAccount: "acct_123",
      chargesEnabled: true,
      payoutsEnabled: false,
    });
    expect(sent[0]!.url.pathname).toBe("/v1/account");
    expect(sent[0]!.headers.get("stripe-account")).toBe("acct_123");
    respond = () =>
      Response.json({
        object: "balance",
        livemode: true,
        available: [{ amount: 1099, currency: "usd", source_types: { card: 1099 } }],
        pending: [{ amount: 0, currency: "usd" }],
      });
    expect(await connector.callTool("get_balance_summary", {}, keyed("rk_live_51abc"))).toEqual({
      livemode: true,
      available: [{ amount: 1099, currency: "usd" }],
      pending: [{ amount: 0, currency: "usd" }],
    });
  });

  it("INV-4: lets no argument choose the account, the key, or a header", async () => {
    const connector: Connector = stripe("platform", { ...LIVE, connectedAccount: "acct_123" });
    for (const tool of await connector.listTools(keyed("rk_live_51abc"))) {
      const properties = Object.keys(((tool.inputSchema as any)?.properties ?? {}) as object);
      expect(
        properties.filter((name) => /header|account|key$|auth|context/i.test(name)),
        tool.name,
      ).toEqual(tool.name === "stripe_api_write" ? ["idempotencyKey"] : []);
    }
    respond = () => Response.json({ object: "list", data: [], has_more: false });
    await connector
      .callTool(
        "stripe_api_read",
        { path: "/v1/customers", query: { "Stripe-Account": "acct_other" } },
        keyed("rk_live_51abc"),
      )
      .catch(() => undefined);
    expect(sent).toEqual([]);
  });
});
