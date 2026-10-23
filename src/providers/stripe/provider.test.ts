import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext } from "../../types.js";

import { STRIPE_API_BASE_URL, stripe } from "./index.js";

const SANDBOX = { purpose: "Rehearsing billing changes", auth: { type: "apiKey" }, mode: "sandbox" } as const;
const LIVE = { purpose: "Revenue for the real business", auth: { type: "apiKey" }, mode: "production" } as const;

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

  it("INV-5: returns a Checkout page whole only for a provably guest payment session, wherever it appears (review 807-2, 807-r2)", async () => {
    const connector = stripe("billing", SANDBOX);
    const page = "https://checkout.stripe.com/c/pay/cs_test_1#fidkdWxOYHwnPydjdXN0b21lcg";
    const origin = "https://checkout.stripe.com/[redacted]";
    const guest = { object: "checkout.session", id: "cs_1", mode: "payment", customer: null, url: page };
    // Deny by default: any binding field, or a mode that saves a payment method, withholds the page.
    const bound: Array<Record<string, unknown>> = [
      { customer: "cus_1" },
      { customer: { object: "customer", id: "cus_1" } },
      { customer_account: "acct_existing" },
      { mode: "subscription", customer_account: "acct_existing" },
      { customer_creation: "always" },
      { saved_payment_method_options: { payment_method_remove: "enabled" } },
      { mode: "setup" },
      { mode: "subscription" },
    ];
    const create = async (session: Record<string, unknown>) => {
      respond = () => Response.json(session);
      return (await connector.callTool(
        "stripe_api_write",
        {
          method: "POST",
          path: "/v1/checkout/sessions",
          body: {
            mode: "payment",
            line_items: [{ price: "price_1", quantity: 1 }],
            success_url: "https://example.com/ok",
          },
        },
        keyed(),
      )) as any;
    };
    for (const fields of bound) {
      expect((await create({ ...guest, ...fields })).data.url, JSON.stringify(fields)).toBe(origin);
    }
    expect((await create(guest)).data.url).toBe(page);
    // customer_account in every placement: retrieve with select, a list, an expansion, and an event.
    const account = { ...guest, customer_account: "acct_existing" };
    const read = async (path: string, body: unknown, args: Record<string, unknown> = {}) => {
      respond = () => Response.json(body);
      return JSON.stringify(await connector.callTool("stripe_api_read", { path, ...args }, keyed()));
    };
    const placements: Array<[string, unknown, Record<string, unknown>]> = [
      ["/v1/checkout/sessions/cs_1", account, { select: ["url"] }],
      ["/v1/checkout/sessions", { object: "list", has_more: false, data: [account] }, {}],
      [
        "/v1/payment_intents/pi_1",
        { object: "payment_intent", id: "pi_1", client_secret: "pi_1_secret_X", checkout: account },
        {},
      ],
      [
        "/v1/events/evt_1",
        {
          object: "event",
          type: "checkout.session.completed",
          data: { object: account, previous_attributes: { url: page } },
        },
        {},
      ],
    ];
    for (const [path, body, args] of placements) {
      const text = await read(path, body, args);
      expect(text, path).not.toContain("#fid");
      expect(text, path).not.toContain("pi_1_secret_X");
    }
    // A list keeps a guest session's page beside a bound one's.
    const list = JSON.parse(
      await read("/v1/checkout/sessions", { object: "list", has_more: false, data: [account, guest] }),
    );
    expect(list.data.data.map((session: { url: string }) => session.url)).toEqual([origin, page]);
    // A payment link is public by design and bound to no customer.
    respond = () => Response.json({ object: "payment_link", id: "plink_1", url: "https://buy.stripe.com/test_abc" });
    expect(
      ((await connector.callTool("stripe_api_read", { path: "/v1/payment_links/plink_1" }, keyed())) as any).data.url,
    ).toBe("https://buy.stripe.com/test_abc");
  });

  it("INV-3: refuses v2 account links and Terminal onboarding links before sending", async () => {
    const connector = stripe("billing", SANDBOX);
    for (const path of ["/v2/core/account_links", "/v1/terminal/onboarding_links"]) {
      const error = await refusal(connector.callTool("stripe_api_write", { method: "POST", path, body: {} }, keyed()));
      expect(error.message).toContain(`Connecta refuses POST ${path}.`);
    }
    expect(sent).toEqual([]);
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
});
