// The Planning Center connection is hand-written fetch over JSON:API. Request
// shapes, projections, and typed failures live in the characterization
// goldens; these tests pin what the goldens do not: credential admission, the
// hatch confinement, credential stripping, and the excludeApps boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { planningCenter } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../../types.js";

interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let responses: StubResponse[] = [];
const calls: StubCall[] = [];
const realFetch = globalThis.fetch;

function queue(...items: StubResponse[]): void {
  responses.push(...items);
}

beforeEach(() => {
  responses = [];
  calls.length = 0;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const next = responses.shift() ?? {};
    const headers = new Headers(init.headers);
    calls.push({
      url: new URL(String(input)),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    });
    const status = next.status ?? 200;
    return new Response(
      [204, 205, 304].includes(status) ? null : (next.text ?? JSON.stringify(next.body ?? { data: [] })),
      { status, ...(next.headers ? { headers: next.headers } : {}) },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(
  values: Record<string, string> | null = { applicationId: "app123", secret: "shh456" },
): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async (field?: string) => (field && values ? (values[field] ?? null) : null),
      getAll: async () => values,
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return planningCenter("church", {
    purpose: "Downtown campus staff operations",
    ...overrides,
  } as Parameters<typeof planningCenter>[1]);
}

function call(
  name: string,
  args: Record<string, unknown> = {},
  connector: Connector = connection(),
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

/** Tool arguments without the keys a case leaves undefined. */
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function person(id: string, attributes: Record<string, unknown>, relationships: Record<string, unknown> = {}) {
  return { type: "Person", id, attributes, relationships };
}

describe("Planning Center credentials", () => {
  it("fails locally without both credential fields, and on a pasted id that cannot be a token", async () => {
    await expect(call("search_people", {}, connection(), context({ applicationId: "app123" }))).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringMatching(/Application ID and the Secret.*authorize_connector/),
    });
    await expect(call("search_people", {}, connection(), context(null))).rejects.toMatchObject({
      code: "auth_required",
    });
    await expect(
      call("search_people", {}, connection(), context({ applicationId: "app:123", secret: "shh" })),
    ).rejects.toMatchObject({ code: "auth_required", message: expect.stringContaining("re-paste") });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("refuses an id that is not Planning Center's numeric shape before any request", async () => {
    await expect(call("get_person", { personId: "../../oauth" })).rejects.toMatchObject({ code: "invalid_args" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("INV-5: never returns a webhook signing secret or the Services organization secret, on any path", async () => {
    const subscription = {
      type: "WebhookSubscription",
      id: "w1",
      attributes: { name: "people.v2.events.person.created", url: "https://hooks.example", active: true },
    };
    const signed = { ...subscription, attributes: { ...subscription.attributes, authenticity_secret: "whsec_live" } };
    const organization = { type: "Organization", id: "1", attributes: { name: "Church", secret: "org_secret_live" } };
    const paths: Array<[string, Record<string, unknown>, unknown]> = [
      ["pco_api_get", { path: "/webhooks/v2/webhook_subscriptions" }, { data: [signed] }],
      ["pco_api_get", { path: "/webhooks/v2/webhook_subscriptions/w1" }, { data: signed }],
      ["pco_api_get", { path: "/services/v2" }, { data: organization, included: [signed] }],
      [
        "pco_api_mutate",
        { method: "POST", path: "/webhooks/v2/webhook_subscriptions/w1/rotate_secret" },
        { data: signed },
      ],
      [
        "pco_api_mutate",
        {
          method: "POST",
          path: "/webhooks/v2/webhook_subscriptions",
          body: { data: { type: "WebhookSubscription", attributes: { name: "x", url: "https://hooks.example" } } },
        },
        { data: signed },
      ],
      ["list_webhook_subscriptions", {}, { data: [signed] }],
    ];
    for (const [tool, args, body] of paths) {
      queue({ body });
      const result = await call(tool, args);
      const text = JSON.stringify(result);
      expect(text, tool).not.toMatch(/whsec_live|org_secret_live|authenticity_secret|"secret"/);
      // Everything else in the body still comes back.
      if (tool !== "list_webhook_subscriptions") expect(text).toContain("hooks.example");
    }
  });

  it("reports the person and organization the candidate token acts as", async () => {
    queue({
      body: {
        data: person("42", { name: "Ada Lovelace" }),
        included: [{ type: "Organization", id: "1", attributes: { name: "Grace Church" } }],
      },
    });
    const result = await connection().testCredentials!({ applicationId: "candidate", secret: "s3cret" }, context(null));
    expect(calls[0]!.url.pathname).toBe("/people/v2/me");
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("candidate:s3cret")}`);
    expect(result).toEqual({ ok: true, message: "Authenticated as Ada Lovelace (person 42) in Grace Church." });
  });
});

describe("Planning Center hatches", () => {
  it("confines paths to a product below /<app>/v2", async () => {
    for (const path of [
      "/oauth/token",
      "/people/v1/people",
      "/people/v2/../../oauth/token",
      "/people/v2/%2e%2e/%2e%2e/oauth/token",
      "//evil.example/people/v2",
      "https://evil.example/people/v2/people",
      "/accounting/v2/ledgers",
      "/people/v2/people?per_page=1",
    ]) {
      await expect(call("pco_api_get", { path }), path).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("assigns only a header's item_type; song and media items come from what is attached", async () => {
    // Services 2018-11-01: "The only value that you can pass is `header`. If
    // no value is passed then `item` will be used."
    const item = (id: string, attributes: Record<string, unknown>) => ({
      status: 201,
      body: { data: { type: "Item", id, attributes } },
    });
    queue(item("i1", { item_type: "header", title: "Welcome" }), item("i3", { item_type: "item", title: "Prayer" }));
    await call("add_plan_item", { serviceTypeId: "10", planId: "20", title: "Welcome", itemType: "header" });
    await call("add_plan_item", { serviceTypeId: "10", planId: "20", title: "Prayer", itemType: "item" });
    expect(calls[0]!.body).toEqual({ data: { type: "Item", attributes: { title: "Welcome", item_type: "header" } } });
    expect(calls[1]!.body).toEqual({ data: { type: "Item", attributes: { title: "Prayer" } } });
  });
});

describe("Planning Center excludeApps", () => {
  const GIVING_TOOLS = [
    "list_donations",
    "list_funds",
    "list_batches",
    "list_pledge_campaigns",
    "list_pledges",
    "list_recurring_donations",
  ];
  const withoutGiving = () => connection({ excludeApps: ["giving"] });
  const names = async (connector: Connector) => (await connector.listTools(context())).map((tool) => tool.name);

  it("INV-11: refuses an unknown, miscased, or non-list app and People at construction", () => {
    expect(() => connection({ excludeApps: ["tithing"] })).toThrow('excludeApps has unknown app "tithing"');
    expect(() => connection({ excludeApps: ["Giving"] })).toThrow('App names are lowercase path segments: "giving".');
    expect(() => connection({ excludeApps: "giving" })).toThrow("excludeApps to be an array of app names");
    expect(() => connection({ excludeApps: ["giving", "people"] })).toThrow('cannot exclude "people"');
  });

  it("removes every Giving tool and every mention of Giving an agent or operator sees", async () => {
    const connector = withoutGiving();
    const tools = await connector.listTools(context());
    const remaining = tools.map((tool) => tool.name);
    expect(remaining).toEqual(
      (await names(connection())).filter(
        (name) => !GIVING_TOOLS.includes(name) && !["list_lists", "list_list_people", "run_list"].includes(name),
      ),
    );
    expect(connector.describe?.().tools?.map((tool) => tool.name)).toEqual(remaining);
    const visible = JSON.stringify({ tools, describe: connector.describe?.(), connector, guide: guide(connector) });
    expect(visible).not.toMatch(/giving|donat|pledge|money/i);
  });

  it.each(["/giving/v2/donations", "/GIVING/v2/donations", "/%67iving/v2/donations"])(
    "INV-4: refuses %s through both hatches before any request",
    async (path) => {
      const connector = withoutGiving();
      for (const [tool, args] of [
        ["pco_api_get", { path }],
        ["pco_api_mutate", { method: "POST", path, body: { data: { type: "Batch", attributes: {} } } }],
      ] as const) {
        const error = (await call(tool, args, connector).catch((caught) => caught)) as ConnectorCallError;
        expect(error, `${tool} ${path}`).toBeInstanceOf(ConnectorCallError);
        expect(error).toMatchObject({ code: "provider_permission_denied", retryable: false });
        expect(error.message).toContain("Planning Center Giving (/giving/v2) is disabled in this deployment");
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  // Each of these once normalized, decoded, or delimited differently on the
  // way to Planning Center than where it was checked. While an app is
  // excluded none is admitted: the path must be literal.
  it.each([
    "/people/v2/%23/../../../giving/v2/donations",
    "/people/v2/%3F/../giving/v2/donations",
    "/people/v2/../../giving/v2/donations",
    "/people/v2/.%2E/.%2e/giving/v2/donations",
    "/people/v2/..%2F..%2Fgiving/v2/donations",
    "/people/v2/..\\..\\giving/v2/donations",
    "/people/v2/.%09./.%09./giving/v2/donations",
    "/%2567iving/v2/donations",
    "/giving//v2/funds",
    "/giving/v2/donations#fragment",
    "/giving/v2/%E0%A4%A",
  ])("INV-4: refuses the non-literal path %s through both hatches before any request", async (path) => {
    const connector = withoutGiving();
    for (const [tool, args] of [
      ["pco_api_get", { path }],
      ["pco_api_mutate", { method: "POST", path, body: { data: { type: "Batch", attributes: {} } } }],
      ["pco_api_mutate", { method: "DELETE", path }],
    ] as const) {
      const error = (await call(tool, args, connector).catch((caught) => caught)) as ConnectorCallError;
      expect(error, `${tool} ${path}`).toBeInstanceOf(ConnectorCallError);
      expect(["invalid_args", "provider_permission_denied"], `${tool} ${path}`).toContain(error.code);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("INV-4: checks the exact URL the transport would fetch, including the query it encodes", async () => {
    const connector = withoutGiving();
    for (const path of ["/people/v2/%23/../../../giving/v2/donations", "/people/v2/x%3Fy/../../../giving/v2/funds"]) {
      await expect(call("pco_api_get", { path }, connector), path).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("a path must be literal"),
      });
    }
    // A proxy base keeps its prefix; the exclusion is read below it.
    const proxied = connection({ excludeApps: ["giving"], baseUrl: "https://proxy.example/pco" });
    await expect(call("pco_api_get", { path: "/giving/v2/funds" }, proxied)).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    queue({ body: {} });
    await call("pco_api_get", { path: "/people/v2/people/1" }, proxied);
    expect(calls.map((entry) => entry.url.href)).toEqual(["https://proxy.example/pco/people/v2/people/1"]);
  });

  it("INV-4: refuses a webhook subscription to Giving events and every webhook payload, before any request", async () => {
    const connector = withoutGiving();
    for (const name of ["giving.v2.events.donation.created", "  Giving.V2.events.batch.committed"]) {
      await expect(
        call(
          "pco_api_mutate",
          {
            method: "POST",
            path: "/webhooks/v2/webhook_subscriptions",
            body: { data: { type: "WebhookSubscription", attributes: { name, url: "https://evil.example/hook" } } },
          },
          connector,
        ),
        name,
      ).rejects.toMatchObject({
        code: "provider_permission_denied",
        message: expect.stringContaining("cannot subscribe to its webhook events"),
      });
    }
    for (const path of [
      "/webhooks/v2/webhook_subscriptions/1/events/2/deliveries/3",
      "/webhooks/v2/subscriptions/1/events",
      "/webhooks/v2/webhook_subscriptions/1/%65vents",
    ]) {
      await expect(call("pco_api_get", { path }, connector), path).rejects.toMatchObject({
        code: "provider_permission_denied",
        message: expect.stringContaining("webhook event or delivery payload"),
      });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Subscriptions to other products still reach Planning Center.
    queue({ status: 201, body: { data: { type: "WebhookSubscription", id: "9" } } });
    await call(
      "pco_api_mutate",
      {
        method: "POST",
        path: "/webhooks/v2/webhook_subscriptions",
        body: { data: { type: "WebhookSubscription", attributes: { name: "people.v2.events.person.created" } } },
      },
      connector,
    );
    expect(calls.map((entry) => entry.url.pathname)).toEqual(["/webhooks/v2/webhook_subscriptions"]);
  });

  it("INV-4: removes the list tools and refuses every list, result, rule, and condition read while an app is excluded", async () => {
    const connector = withoutGiving();
    const remaining = await names(connector);
    for (const name of ["list_lists", "list_list_people", "run_list"]) expect(remaining).not.toContain(name);
    const lists = expect.stringContaining("a People list's conditions can draw on a disabled product");
    for (const path of ["/people/v2/lists/7/people", "/people/v2/%6Cists/7", "/people/v2/campuses/1/lists"]) {
      await expect(call("pco_api_get", { path }, connector), path).rejects.toMatchObject({
        code: "provider_permission_denied",
        message: lists,
      });
    }
    await expect(
      call("pco_api_mutate", { method: "POST", path: "/people/v2/lists/7/run" }, connector),
    ).rejects.toMatchObject({ code: "provider_permission_denied", message: lists });
    for (const [path, name, value] of [
      ["/people/v2/people/42", "include", "emails, primary_campus.LISTS"],
      ["/people/v2/emails/1/person", "include[]", "primary_campus.lists"],
      ["/people/v2/campuses", "include", "rules.conditions"],
    ] as const) {
      await expect(
        call("pco_api_get", { path, query: [{ name, value }] }, connector),
        `${path} ${name}=${value}`,
      ).rejects.toMatchObject({ code: "provider_permission_denied", message: lists });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Everything else about People is still reached, including list categories' own names.
    queue({ body: {} }, { body: { data: person("42", { name: "Ada" }), included: [] } });
    await call("pco_api_get", { path: "/people/v2/list_categories" }, connector);
    await call("get_person", { personId: "42" }, connector);
    expect(calls.map((entry) => entry.url.pathname)).toEqual(["/people/v2/list_categories", "/people/v2/people/42"]);
  });

  it("INV-4: refuses every change to an existing webhook subscription, current or 2018-08-01, before any request", async () => {
    const connector = withoutGiving();
    const existing = expect.stringContaining("does not enable, disable, delete, or re-key an existing subscription");
    const enable = (type: string) => ({ data: { type, attributes: { active: true } } });
    for (const [method, path, body, version] of [
      ["PATCH", "/webhooks/v2/webhook_subscriptions/123", enable("WebhookSubscription"), undefined],
      ["DELETE", "/webhooks/v2/subscriptions/123", undefined, "2018-08-01"],
      ["POST", "/webhooks/v2/webhook_subscriptions/123/rotate_secret", undefined, undefined],
    ] as const) {
      await expect(
        call("pco_api_mutate", compactArgs({ method, path, body, version }), connector),
        `${method} ${path}`,
      ).rejects.toMatchObject({ code: "provider_permission_denied", retryable: false, message: existing });
    }
    const unnamed = expect.stringContaining("a new webhook subscription must name one product's event");
    for (const body of [
      { data: { type: "WebhookSubscription", attributes: { url: "https://evil.example/hook" } } },
      { data: [{ type: "WebhookSubscription", attributes: { name: "people.v2.events.person.created" } }] },
    ]) {
      await expect(
        call("pco_api_mutate", { method: "POST", path: "/webhooks/v2/webhook_subscriptions", body }, connector),
        JSON.stringify(body),
      ).rejects.toMatchObject({ code: "provider_permission_denied", message: unnamed });
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Nothing excluded, nothing refused: the same change reaches Planning Center.
    queue({ body: { data: { type: "WebhookSubscription", id: "123" } } });
    await call("pco_api_mutate", {
      method: "PATCH",
      path: "/webhooks/v2/webhook_subscriptions/123",
      body: enable("WebhookSubscription"),
    });
    expect(calls.map((entry) => [entry.method, entry.url.pathname])).toEqual([
      ["PATCH", "/webhooks/v2/webhook_subscriptions/123"],
    ]);
  });
});
