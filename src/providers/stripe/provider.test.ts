import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectorContext } from "../../../test/fixtures/misc.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { ConnectorCallError } from "../../errors.js";
import type { ConnectorContext } from "../../types.js";

import { manifest } from "../../http/vendor.js";
import { MAX_RESPONSE_BYTES, STRIPE_VERDICTS, StripeApi, stripeIndex } from "./api.js";
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
    installOwnedTransport();
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

  it("INV-11: derives every manifest operation and vendor path parameter from the pinned index", () => {
    const document = manifest(StripeApi);
    const operations = Object.entries(document.paths)
      .flatMap(([path, item]) =>
        Object.entries(item)
          .filter(([method]) => ["get", "head", "post", "put", "patch", "delete"].includes(method))
          .map(([method, endpoint]) => {
            const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
            expect(
              (endpoint as { parameters?: Array<{ in: string; name: string }> }).parameters
                ?.filter((p) => p.in === "path")
                .map((p) => p.name)
                .sort() ?? [],
            ).toEqual(names);
            return `${method.toUpperCase()} ${path}`;
          }),
      )
      .sort();
    expect(operations).toEqual(stripeIndex.ops.map((op) => `${op.method} ${op.path}`).sort());
    expect(stripe.definition.kit?.operations).toEqual(operations);
    expect(Object.keys(STRIPE_VERDICTS).sort()).toEqual(operations);
    expect(stripe.definition.kit).toMatchObject({
      idempotencyKey: true,
      refusesWithheld: true,
      errors: {
        unknownId: "not_found",
        provesAbsence: true,
        conflicts: expect.arrayContaining([
          expect.stringContaining("HTTP 409"),
          expect.stringContaining("lock_timeout"),
        ]),
      },
    });
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
    const connector = stripe("billing", { ...SANDBOX, connectedAccount: "acct_fixture" });
    respond = () => Response.json({ id: "acct_fixture", business_profile: { name: "Example" } });
    expect(await connector.testCredential!("  rk_test_candidate  ", connectorContext())).toEqual({
      ok: true,
      message: "Authenticated to acct_fixture (Example) with a test-mode key.",
    });
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer rk_test_candidate");
    expect(sent[0]!.headers.get("stripe-account")).toBe("acct_fixture");
    expect(sent[0]!.headers.get("stripe-version")).toBe(stripeIndex.version);
    respond = () =>
      Response.json({ error: { type: "invalid_request_error", message: "Permission denied" } }, { status: 403 });
    expect(await connector.testCredential!("rk_test_candidate", connectorContext())).toEqual({
      ok: true,
      message:
        "Stripe accepted the test-mode key; it cannot read the account object, which only get_stripe_account_info needs.",
    });
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
      ["/v1/checkout/sessions/cs_1", account, { fields: ["url"] }],
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
    // Fields are checked before even the alternate-origin PDF dispatch.
    const beforeFields = sent.length;
    expect(
      (
        await refusal(
          connector.callTool("stripe_api_read", { path: "/v1/quotes/qt_1/pdf", fields: ["content"] }, keyed()),
        )
      ).code,
    ).toBe("invalid_args");
    expect(sent).toHaveLength(beforeFields);
    // H3: a lost 424 body never proves a write was refused. Exercise both
    // declared and streamed ceilings without reading beyond either bound.
    for (const streamed of [false, true]) {
      respond = () =>
        streamed
          ? new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1));
                  c.close();
                },
              }),
              { status: 424 },
            )
          : new Response("", { status: 424, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } });
      const before = sent.length;
      const error = await refusal(
        connector.callTool("stripe_api_write", { method: "DELETE", path: "/v1/customers/cus_1" }, keyed()),
      );
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      expect(error.message).toContain("response ceiling");
      expect(sent).toHaveLength(before + 1);
      const readError = await refusal(connector.callTool("stripe_api_read", { path: "/v1/customers/cus_1" }, keyed()));
      expect(readError).toMatchObject({ code: "unavailable", retryable: true });
      const keyedError = await refusal(
        connector.callTool(
          "stripe_api_write",
          {
            method: "POST",
            path: "/v1/customers",
            body: { email: "alice@example.com" },
            idempotencyKey: "h3-recovery",
          },
          keyed(),
        ),
      );
      expect(keyedError.code).toBe("unavailable");
      expect(sent.at(-1)!.headers.get("idempotency-key")).toBe("h3-recovery");
    }
    respond = () => Response.json({ error: { message: "Concurrent request" } }, { status: 409 });
    expect(
      await refusal(connector.callTool("stripe_api_read", { path: "/v1/customers/cus_1" }, keyed())),
    ).toMatchObject({ code: "conflict" });
    // H5: keep a failed body read distinct from malformed JSON, without its cause.
    respond = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("private body failure"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const broken = await refusal(connector.callTool("stripe_api_read", { path: "/v1/customers/cus_1" }, keyed()));
    expect(broken.message).toBe("Stripe's response body could not be read completely.");
    respond = () => new Response("{broken", { headers: { "content-type": "application/json" } });
    expect(
      (await refusal(connector.callTool("stripe_api_read", { path: "/v1/customers/cus_1" }, keyed()))).message,
    ).toBe("Stripe returned malformed JSON.");
  });

  it("INV-1 INV-3 INV-5 INV-9: form-encodes v1 bodies and query lists, pins Stripe-Version, and acts as the connected account", async () => {
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
    const ctx = keyed("rk_live_51abc");
    const args = { path: "/v1/charges", query: { customer: "cus_1", limit: 2 }, fields: ["data.amount"] };
    respond = () =>
      Response.json({
        object: "list",
        data: [
          { id: "ch_first", amount: 200 },
          { id: "ch_last", amount: 300 },
        ],
        has_more: true,
      });
    // First-request anchors retain their raw vendor meaning. Continuations
    // omit the anchor and restore a signed vendor position before dispatch.
    for (const param of ["starting_after", "ending_before"] as const) {
      respond = () =>
        Response.json({
          object: "list",
          data: [
            { id: "ch_first", amount: 200 },
            { id: "ch_last", amount: 300 },
          ],
          has_more: true,
        });
      const first = (await connector.callTool(
        "stripe_api_read",
        { ...args, query: { ...args.query, [param]: "ch_anchor" } },
        ctx,
      )) as any;
      expect(first.page).toEqual({ hasMore: true, nextCursor: expect.any(String), param, in: "query" });
      expect(first.data).toEqual({ data: [{ amount: 200 }, { amount: 300 }] });
      expect(sent.at(-1)!.url.searchParams.get(param)).toBe("ch_anchor");
      const before = sent.length;
      for (const invalid of [
        { ...args, cursor: first.page.nextCursor, query: { ...args.query, [param]: "ch_anchor" } },
        { ...args, query: { ...args.query, starting_after: "ch_a", ending_before: "ch_b" } },
        { ...args, cursor: "ch_plain" },
        { ...args, cursor: first.page.nextCursor, query: { ...args.query, customer: "cus_other" } },
        { ...args, query: { ...args.query, [param]: "ch_[redacted]" } },
      ])
        expect((await refusal(connector.callTool("stripe_api_read", invalid, ctx))).code).toBe("invalid_args");
      expect(sent).toHaveLength(before);
      respond = () => Response.json({ object: "list", data: [], has_more: false });
      const last = (await connector.callTool(
        "stripe_api_read",
        { ...args, cursor: first.page.nextCursor },
        ctx,
      )) as any;
      expect(sent.at(-1)!.url.searchParams.get(param)).toBe(param === "starting_after" ? "ch_last" : "ch_first");
      expect(last.page).toEqual({ hasMore: false, param, in: "query" });
    }
    respond = () => Response.json({ object: "list", data: [], has_more: false });
    expect(await connector.callTool("stripe_api_read", args, ctx)).toMatchObject({
      data: { data: [] },
      page: { hasMore: false, param: "starting_after", in: "query" },
    });
    // Invalid field roots and withheld scalar writes fail before dispatch.
    const before = sent.length;
    for (const bad of [
      { method: "POST", path: "/v1/customers", body: { email: "alice@example.com" }, fields: ["typo"] },
      { method: "POST", path: "/v1/customers", body: { metadata: { tier: "[redacted]" } } },
      { method: "POST", path: "/v1/customers", body: { name: "%5Bredacted%5D" } },
    ])
      expect((await refusal(connector.callTool("stripe_api_write", bad, ctx))).code).toBe("invalid_args");
    expect(sent).toHaveLength(before);
    respond = () => Response.json({ id: "cus_1", object: "customer" });
    await connector.callTool(
      "stripe_api_write",
      { method: "POST", path: "/v1/customers", body: { description: "The log says [redacted]" } },
      ctx,
    );
    expect(sent).toHaveLength(before + 1);
    // Named reads accept fields and reject bad roots before authentication.
    expect(
      (await refusal(connector.callTool("get_balance_summary", { fields: ["typo"] }, connectorContext()))).code,
    ).toBe("invalid_args");
    respond = () =>
      Response.json({ object: "balance", livemode: true, available: [{ amount: 200, currency: "usd" }], pending: [] });
    expect(await connector.callTool("get_balance_summary", { fields: ["available.amount"] }, ctx)).toEqual({
      available: [{ amount: 200 }],
    });
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
    const ctx = keyed();
    const args = { path: "/v2/core/accounts", query: { applied_configurations: ["customer", "merchant"], limit: 2 } };
    respond = () => Response.json({ data: [{ id: "acct_next" }], next_page_url: "/v2/core/accounts?page=page_next" });
    const first = (await connector.callTool("stripe_api_read", args, ctx)) as any;
    expect(first.page).toMatchObject({ hasMore: true, param: "page", in: "query" });
    respond = () => Response.json({ data: [], next_page_url: null });
    const last = (await connector.callTool("stripe_api_read", { ...args, cursor: first.page.nextCursor }, ctx)) as any;
    expect(sent.at(-1)!.url.searchParams.get("page")).toBe("page_next");
    expect(sent.at(-1)!.url.searchParams.getAll("applied_configurations")).toEqual(["customer", "merchant"]);
    expect(last.page).toEqual({ hasMore: false, param: "page", in: "query" });
    for (const url of [
      "https://other.example/v2/core/accounts?page=x",
      "/v2/core/events?page=x",
      "/v2/core/accounts?page=x&page=y",
      "/v2/core/accounts?page=x&limit=99",
    ]) {
      respond = () => Response.json({ data: [], next_page_url: url });
      expect((await refusal(connector.callTool("stripe_api_read", args, ctx))).code).toBe("connector_call_failed");
    }
    const search = { path: "/v1/customers/search", query: { query: "email:'alice@example.com'", limit: 1 } };
    respond = () =>
      Response.json({ object: "search_result", data: [{ id: "cus_1" }], has_more: true, next_page: "next_search" });
    const searched = (await connector.callTool("stripe_api_read", search, ctx)) as any;
    respond = () => Response.json({ object: "search_result", data: [], has_more: false });
    expect(
      await connector.callTool("stripe_api_read", { ...search, cursor: searched.page.nextCursor }, ctx),
    ).toMatchObject({ page: { hasMore: false, param: "page", in: "query" } });
    expect(sent.at(-1)!.url.searchParams.get("page")).toBe("next_search");
    const beforeRaw = sent.length;
    expect(
      (
        await refusal(
          connector.callTool("stripe_api_read", { ...search, query: { ...search.query, page: "next_search" } }, ctx),
        )
      ).code,
    ).toBe("invalid_args");
    expect(sent).toHaveLength(beforeRaw);
  });
});
