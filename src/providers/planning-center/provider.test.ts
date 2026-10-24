import { kitInputDisagreements } from "../../../test/helpers/kit-schema.js";
import goldenSpec from "../../../test/goldens/planning-center/spec.js";
import { resultSafety } from "../../http/safety.js";
import type { Connection } from "../../http/vendor.js";
import { validateToolInput } from "../../validate.js";
import { errors, safety, PCO_INDEX, PCO_VERDICTS, PLANNING_CENTER_API_VERSIONS } from "./api.js";
import { planningCenterTools } from "./tools.js";
// The Planning Center connection uses the provider kit over JSON:API. Request
// shapes, projections, and typed failures live in the characterization
// goldens; these tests pin what the goldens do not: credential admission, the
// hatch confinement, credential stripping, and the excludeApps boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { ConnectorCallError } from "../../errors.js";
import { planningCenter } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

interface StubResponse {
  streamError?: true;
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
  installOwnedTransport();
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
    if (next.streamError)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("unseen-stream-cause"));
          },
        }),
        { status },
      );
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

/** Tool arguments without the keys a case leaves undefined. */
function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function person(id: string, attributes: Record<string, unknown>, relationships: Record<string, unknown> = {}) {
  return { type: "Person", id, attributes, relationships };
}

describe("Planning Center contracts", () => {
  it("INV-5 INV-11: preserves credential withholding and body-failure wording", async () => {
    const connector = connection(),
      ctx = context();
    const invoke = (name: string, args: Record<string, unknown>) => call(name, args, connector, ctx);
    const subscription = {
      type: "WebhookSubscription",
      id: "w1",
      attributes: { name: "people.v2.events.person.created", url: "https://hooks.example", active: true },
    };
    const signed = { ...subscription, attributes: { ...subscription.attributes, authenticity_secret: "whsec_live" } };
    const organization = { type: "Organization", id: "1", attributes: { name: "Church", secret: "org_secret_live" } };
    const paths: Array<[string, Record<string, unknown>, unknown]> = [
      ["pco_api_read", { path: "/webhooks/v2/webhook_subscriptions" }, { data: [signed] }],
      ["pco_api_read", { path: "/webhooks/v2/webhook_subscriptions/w1" }, { data: signed }],
      ["pco_api_read", { path: "/services/v2/me" }, { data: organization, included: [signed] }],
      [
        "pco_api_write",
        {
          method: "POST",
          path: "/webhooks/v2/webhook_subscriptions",
          body: { data: { type: "WebhookSubscription", attributes: { name: "x", url: "https://hooks.example" } } },
        },
        { data: signed },
      ],
    ];
    for (const [tool, args, body] of paths) {
      queue({ body });
      const result = await invoke(tool, args);
      const text = JSON.stringify(result);
      expect(text, tool).not.toMatch(/whsec_live|org_secret_live|authenticity_secret|"secret"/);
      // Everything else in the body still comes back.
      expect(text).toContain("hooks.example");
    }
    // These actions create credentials that the connection must never return.
    // Refusing before transport avoids minting a private link or breaking a
    // webhook receiver by rotating to a signing key that remains withheld.
    const beforeRefused = calls.length;
    for (const path of [
      "/publishing/v2/episodes/1/generate_download_url",
      "/webhooks/v2/webhook_subscriptions/w1/rotate_secret",
    ]) {
      await expect(invoke("pco_api_write", { method: "POST", path })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("Planning Center refuses"),
      });
    }
    expect(calls).toHaveLength(beforeRefused);
    // Safety applies before either fields selection or a named projection.
    const privateRecord = {
      type: "Attachment",
      id: "a1",
      attributes: {
        url: "https://files.example/private-download",
        thumbnail_url: "https://files.example/private-thumbnail",
        linked_url: "https://example.com/public",
        secret: "stored-org-value",
        ical_code: "private-feed-code",
      },
    };
    for (const body of [privateRecord, { data: privateRecord, included: [privateRecord] }, { data: [privateRecord] }]) {
      queue({ body });
      const result = JSON.stringify(await invoke("pco_api_read", { path: "/services/v2/media/1" }));
      expect(result).not.toMatch(
        /private-download|private-thumbnail|stored-org-value|private-feed-code|"secret"|ical_code/,
      );
      expect(result).toContain("example.com/public");
    }
    queue({
      body: {
        data: {
          type: "Delivery",
          id: "d1",
          attributes: {
            request_headers: "Authorization: unseen-stored-key",
            response_headers: "Set-Cookie: unseen-cookie",
            request_body: '{"secret":"opaque-key"}',
            response_body: "unseen-response-key",
            payload: "opaque-event-key",
          },
        },
      },
    });
    expect(
      JSON.stringify(
        await invoke("pco_api_read", {
          path: "/webhooks/v2/webhook_subscriptions/1/events/2/deliveries/3",
          fields: ["data.attributes"],
        }),
      ),
    ).not.toMatch(/unseen-|opaque-/);
    queue({
      body: {
        data: {
          type: "Person",
          id: "1",
          attributes: {
            signature: "Kind regards",
            ical_code: "calendar-credential",
            photo_url: "https://images.example/alice.jpg",
          },
        },
      },
    });
    expect(await invoke("pco_api_read", { path: "/services/v2/people/1", fields: ["data.attributes"] })).toMatchObject({
      data: { data: { attributes: { signature: "Kind regards", photo_url: "https://images.example/alice.jpg" } } },
    });
    queue({ status: 500, body: { errors: [{ detail: "unseen-error-signing-key" }] } });
    const protectedFailure = await invoke("pco_api_read", { path: "/webhooks/v2/webhook_subscriptions/1" }).catch(
      (error) => error,
    );
    expect(protectedFailure.message).not.toContain("unseen-error-signing-key");

    queue({ streamError: true }, { text: "{broken" });
    await expect(invoke("get_person", { personId: "1" })).rejects.toMatchObject({
      code: "connector_call_failed",
      message: "Planning Center's response body could not be read completely.",
    });
    await expect(invoke("get_person", { personId: "1" })).rejects.toMatchObject({
      code: "connector_call_failed",
      message: "Planning Center returned malformed JSON.",
    });
  });

  it("INV-1 INV-11: ranks full-index discovery and continues large contracts within their byte budgets", async () => {
    const connector = connection(),
      ctx = context();
    const invoke = (name: string, args: Record<string, unknown>) => call(name, args, connector, ctx);
    // The source's one empty-path artifact is omitted: 1,752 real operations.
    const beforeDiscovery = calls.length;
    expect(PCO_INDEX.ops).toHaveLength(1752);
    expect(Object.keys(PCO_VERDICTS)).toHaveLength(1752);
    expect(PCO_INDEX.operation("POST", "/people/v2")).toBeUndefined();
    for (const [query, expected, method] of [
      ["person mergers", "/people/v2/person_mergers", "GET"],
      ["note categories", "/people/v2/note_categories", "GET"],
      ["song arrangements", "/services/v2/songs/{song_id}/arrangements", "GET"],
      ["group memberships", "/groups/v2/groups/{group_id}/memberships", "GET"],
      ["volunteer roster", "/services/v2/people"],
      ["church group leaders", "/groups/v2/groups"],
      ["volunteer", "/services/v2/people"],
      ["group leaders", "/groups/v2/groups/{group_id}/memberships"],
      ["custom field", "/people/v2/field_definitions"],
      ["order of service", "/services/v2/service_types"],
      ["person", "/people/v2/people"],
    ]) {
      const found = await invoke("pco_api_search", { query, ...(method ? { method } : {}) });
      expect(found.operations.length, query).toBeLessThanOrEqual(8);
      expect(new TextEncoder().encode(JSON.stringify(found)).length).toBeLessThanOrEqual(16 * 1024);
      expect(
        found.operations.map((op: any) => op.path),
        query,
      ).toContain(expected);
      if (query === "person") expect(found.operations[0].path).toBe(expected);
    }
    const detailArgs = { method: "GET", path: "/people/v2/list_categories/{list_category_id}/lists" };
    const parameters: any[] = [],
      chunks: Record<string, string> = {};
    let cursor: string | undefined,
      detailPages = 0;
    do {
      const detail = await invoke("pco_api_details", { ...detailArgs, ...(cursor ? { cursor } : {}) });
      expect(new TextEncoder().encode(JSON.stringify(detail)).length).toBeLessThanOrEqual(32 * 1024);
      parameters.push(...detail.parameters);
      if (detail.chunk) chunks[detail.chunk.of] = (chunks[detail.chunk.of] ?? "") + detail.chunk.text;
      cursor = detail.page?.nextCursor;
      detailPages++;
      expect(detailPages).toBeLessThan(20);
    } while (cursor);
    expect(detailPages).toBeGreaterThan(1);
    for (const text of Object.values(chunks)) parameters.push(JSON.parse(text));
    const operation = PCO_INDEX.operation("GET", detailArgs.path)!;
    expect(parameters.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...PCO_INDEX.contract(operation).parameters].sort((a, b) => a.name.localeCompare(b.name)),
    );
    expect(calls).toHaveLength(beforeDiscovery);
  });

  it("INV-3 INV-9 INV-11: binds paging, validates fields before dispatch and preserves scoped error meanings", async () => {
    const connector = connection(),
      ctx = context();
    const invoke = (name: string, args: Record<string, unknown>) => call(name, args, connector, ctx);
    // A real signed continuation changes only the vendor offset, preserving filters and projection.
    queue({ body: { data: [person("1", { name: "Alice" })], meta: { total_count: 2, next: { offset: 1 } } } });
    const first = await invoke("search_people", { status: "active", limit: 1, fields: ["id"] });
    expect(first).toMatchObject({ items: [{ id: "1" }], page: { hasMore: true, nextCursor: expect.any(String) } });
    expect(first.page.nextCursor).not.toBe("1");
    queue({ body: { data: [person("2", { name: "Bob" })], meta: { total_count: 2, next: null } } });
    expect(
      await invoke("search_people", { status: "active", limit: 1, cursor: first.page.nextCursor, fields: ["name"] }),
    ).toEqual({
      items: [{ name: "Bob" }],
      page: { hasMore: false },
    });
    expect(calls.at(-1)!.url.searchParams.get("offset")).toBe("1");
    expect(calls.at(-1)!.url.searchParams.get("where[status]")).toBe("active");
    const noRequest = calls.length;
    const peopleOperation = PCO_INDEX.operation("GET", "/people/v2/people")!;
    expect(PCO_INDEX.contract(peopleOperation).parameters.find((p) => p.name === "per_page")?.schema).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 100,
    });
    for (const per_page of [1000, "abc", -1, 0, 101, 1.5, "1.5", "", null, true]) {
      await expect(invoke("pco_api_read", { path: "/people/v2/people", query: { per_page } })).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    for (const per_page of [1, "1", 100, "100"])
      expect(() => PCO_INDEX.check(peopleOperation, { per_page }, undefined)).not.toThrow();
    for (const args of [
      { limit: 0 },
      { limit: 101 },
      { cursor: first.page.nextCursor, status: "inactive", limit: 1 },
      { fields: ["invented"] },
      { perPage: 1 },
      { offset: 2 },
      { raw: true },
    ]) {
      await expect(invoke("search_people", args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    await expect(invoke("pco_api_read", { path: "/people/v2/people", version: "1900-01-01" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(invoke("pco_api_read", { path: "/people/v2/people", query: { offset: 1 } })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(invoke("pco_api_write", { method: "POST", path: "/people/v2", body: {} })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      invoke("pco_api_write", {
        method: "PATCH",
        path: "/people/v2/people/1",
        body: { data: { attributes: { nickname: "[redacted]" } } },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(noRequest);
    queue({ body: { data: [], meta: { next: { offset: 0 } } } });
    await expect(invoke("search_people", {})).rejects.toMatchObject({ code: "connector_call_failed" });
    queue(
      { status: 409, body: { errors: [{ title: "Duplicate Record" }] } },
      { status: 409, body: {} },
      { status: 404, body: {} },
    );
    await expect(
      invoke("pco_api_write", {
        method: "POST",
        path: "/people/v2/people",
        body: { data: { type: "Person", attributes: { first_name: "Alice" } } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      invoke("pco_api_write", {
        method: "POST",
        path: "/giving/v2/batches",
        body: { data: { type: "Batch", attributes: {} } },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(invoke("get_person", { personId: "999" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("Planning Center excludeApps", () => {
  const withoutGiving = () => connection({ excludeApps: ["giving"] });
  const names = async (connector: Connector) => (await connector.listTools(context())).map((tool) => tool.name);

  it("INV-4: refuses excluded and ambiguous paths through both hatches before any request", async () => {
    const connector = withoutGiving();
    for (const path of ["/giving/v2/donations", "/GIVING/v2/donations", "/%67iving/v2/donations"]) {
      for (const [tool, args] of [
        ["pco_api_read", { path }],
        [
          "pco_api_write",
          {
            method: "POST",
            path: path.replace("donations", "batches"),
            body: { data: { type: "Batch", attributes: {} } },
          },
        ],
      ] as const) {
        const error = (await call(tool, args, connector).catch((caught) => caught)) as ConnectorCallError;
        expect(error, `${tool} ${path}`).toBeInstanceOf(ConnectorCallError);
        expect(error).toMatchObject({
          code: path === "/giving/v2/donations" ? "provider_permission_denied" : "invalid_args",
          retryable: false,
        });
        if (path === "/giving/v2/donations")
          expect(error.message).toContain("Planning Center Giving (/giving/v2) is disabled in this deployment");
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }

    // Ambiguous or unindexed paths also refuse before any transport.

    for (const path of [
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
    ]) {
      for (const [tool, args] of [
        ["pco_api_read", { path }],
        [
          "pco_api_write",
          {
            method: "POST",
            path: path.replace("donations", "batches"),
            body: { data: { type: "Batch", attributes: {} } },
          },
        ],
        ["pco_api_write", { method: "DELETE", path }],
      ] as const) {
        const error = (await call(tool, args, connector).catch((caught) => caught)) as ConnectorCallError;
        expect(error, `${tool} ${path}`).toBeInstanceOf(ConnectorCallError);
        expect(["invalid_args", "provider_permission_denied"], `${tool} ${path}`).toContain(error.code);
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    }
  });

  it("INV-4 INV-11: checks the exact transport URL, query and reviewed product-version headers", async () => {
    const connector = withoutGiving();
    for (const path of ["/people/v2/%23/../../../giving/v2/donations", "/people/v2/x%3Fy/../../../giving/v2/funds"]) {
      await expect(call("pco_api_read", { path }, connector), path).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    // A proxy base keeps its prefix; the exclusion is read below it.
    const proxied = connection({ excludeApps: ["giving"], baseUrl: "https://proxy.example/pco" });
    await expect(call("pco_api_read", { path: "/giving/v2/funds" }, proxied)).rejects.toMatchObject({
      code: "provider_permission_denied",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    queue({ body: {} });
    await call("pco_api_read", { path: "/people/v2/people/1" }, proxied);
    expect(calls.map((entry) => entry.url.href)).toEqual(["https://proxy.example/pco/people/v2/people/1"]);
    const pinned = connection();
    for (const [app, resource] of Object.entries({
      people: "people",
      services: "service_types",
      groups: "groups",
      "check-ins": "events",
      calendar: "event_instances",
      registrations: "signups",
      giving: "funds",
      publishing: "episodes",
      webhooks: "webhook_subscriptions",
      api: "personal_access_tokens",
    })) {
      queue({ body: { data: [], meta: { total_count: 0 } } });
      await call("pco_api_read", { path: `/${app}/v2/${resource}` }, pinned);
      expect(calls.at(-1)!.headers["x-pco-api-version"]).toBe(
        PLANNING_CENTER_API_VERSIONS[app as keyof typeof PLANNING_CENTER_API_VERSIONS],
      );
    }
  });

  it("INV-4: refuses excluded webhook payloads and subscription changes while admitting reachable subscriptions", async () => {
    const connector = withoutGiving();
    for (const name of ["giving.v2.events.donation.created", "  Giving.V2.events.batch.committed"]) {
      await expect(
        call(
          "pco_api_write",
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
      await expect(call("pco_api_read", { path }, connector), path).rejects.toMatchObject(
        path.includes("/subscriptions/") || path.includes("%")
          ? { code: "invalid_args" }
          : {
              code: "provider_permission_denied",
              message: expect.stringContaining("webhook event or delivery payload"),
            },
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const existing = expect.stringContaining("does not enable, disable, delete, or re-key an existing subscription");
    const enable = (type: string) => ({ data: { type, attributes: { active: true } } });
    for (const [method, path, body] of [
      ["PATCH", "/webhooks/v2/webhook_subscriptions/123", enable("WebhookSubscription")],
      ["DELETE", "/webhooks/v2/subscriptions/123", undefined],
      ["POST", "/webhooks/v2/webhook_subscriptions/123/rotate_secret", undefined],
    ] as const) {
      await expect(
        call("pco_api_write", compactArgs({ method, path, body }), connector),
        `${method} ${path}`,
      ).rejects.toMatchObject(
        path.includes("/subscriptions/") || path.endsWith("/rotate_secret")
          ? { code: "invalid_args", retryable: false }
          : { code: "provider_permission_denied", retryable: false, message: existing },
      );
    }
    const unnamed = expect.stringContaining("a new webhook subscription must name one product's event");
    for (const body of [
      { data: { type: "WebhookSubscription", attributes: { url: "https://evil.example/hook" } } },
      { data: [{ type: "WebhookSubscription", attributes: { name: "people.v2.events.person.created" } }] },
    ]) {
      await expect(
        call("pco_api_write", { method: "POST", path: "/webhooks/v2/webhook_subscriptions", body }, connector),
        JSON.stringify(body),
      ).rejects.toMatchObject(
        Array.isArray(body.data) ? { code: "invalid_args" } : { code: "provider_permission_denied", message: unnamed },
      );
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Subscriptions to other products still reach Planning Center.
    queue({ status: 201, body: { data: { type: "WebhookSubscription", id: "9" } } });
    await call(
      "pco_api_write",
      {
        method: "POST",
        path: "/webhooks/v2/webhook_subscriptions",
        body: { data: { type: "WebhookSubscription", attributes: { name: "people.v2.events.person.created" } } },
      },
      connector,
    );
    expect(calls.map((entry) => entry.url.pathname)).toEqual(["/webhooks/v2/webhook_subscriptions"]);
    // Nothing excluded, nothing refused: the same change reaches Planning Center.
    queue({ body: { data: { type: "WebhookSubscription", id: "123" } } });
    await call("pco_api_write", {
      method: "PATCH",
      path: "/webhooks/v2/webhook_subscriptions/123",
      body: enable("WebhookSubscription"),
    });
    expect(calls.map((entry) => [entry.method, entry.url.pathname])).toEqual([
      ["POST", "/webhooks/v2/webhook_subscriptions"],
      ["PATCH", "/webhooks/v2/webhook_subscriptions/123"],
    ]);
  });

  it("INV-4: removes the list tools and refuses every list, result, rule, and condition read while an app is excluded", async () => {
    const connector = withoutGiving();
    const remaining = await names(connector);
    for (const name of ["list_lists", "list_list_people", "run_list"]) expect(remaining).not.toContain(name);
    const lists = expect.stringContaining("a People list's conditions can draw on a disabled product");
    for (const path of ["/people/v2/lists/7/people", "/people/v2/%6Cists/7", "/people/v2/campuses/1/lists"]) {
      await expect(call("pco_api_read", { path }, connector), path).rejects.toMatchObject(
        path.includes("%") ? { code: "invalid_args" } : { code: "provider_permission_denied", message: lists },
      );
    }
    await expect(
      call("pco_api_write", { method: "POST", path: "/people/v2/lists/7/run" }, connector),
    ).rejects.toMatchObject({ code: "provider_permission_denied", message: lists });
    for (const [path, name, value] of [
      ["/people/v2/people/42", "include", "emails, primary_campus.LISTS"],
      ["/people/v2/emails/1/person", "include[]", "primary_campus.lists"],
      ["/people/v2/campuses", "include", "rules.conditions"],
    ] as const) {
      // The index can reject a malformed/undeclared include before the product guard.
      const error = await call("pco_api_read", { path, query: { [name]: value } }, connector).catch((error) => error);
      expect(error).toBeInstanceOf(ConnectorCallError);
      expect(["invalid_args", "provider_permission_denied"]).toContain(error.code);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Everything else about People is still reached, including list categories' own names.
    queue({ body: {} }, { body: { data: person("42", { name: "Ada" }), included: [] } });
    await call("pco_api_read", { path: "/people/v2/list_categories" }, connector);
    await call("get_person", { personId: "42" }, connector);
    expect(calls.map((entry) => entry.url.pathname)).toEqual(["/people/v2/list_categories", "/people/v2/people/42"]);
  });
});

it("INV-5 INV-10 INV-11: catalog decoding and credential probes preserve candidate keys, framing, failures, and response descriptions", async () => {
  const kitConnection = { errors, safety: resultSafety(safety) } as Connection;
  for (const tool of planningCenterTools({
    connection: kitConnection,
    pageSize: 100,
    options: { purpose: "Catalog agreement" },
  })) {
    const base = goldenSpec.calls.find((fixture) => fixture.tool === tool.name)?.args ?? {};
    expect(validateToolInput(tool.inputSchema!, base, { address: tool.name, failClosed: true }), tool.name).toBeNull();
    expect(kitInputDisagreements(tool, base), tool.name).toEqual([]);
  }
  const connector = connection({ userAgent: "fixture-agent/1", authScope: "personal" });
  const candidate = { applicationId: "candidate-id", secret: "candidate-secret" };
  for (const [body, expected] of [
    [
      {
        data: person("7", { name: "Alice" }),
        included: [{ type: "Organization", id: "1", attributes: { name: "Example" } }],
      },
      { ok: true, message: "Authenticated as Alice (person 7) in Example." },
    ],
    [{ data: person("7", {}) }, { ok: true, message: "Authenticated as person 7 (person 7)." }],
    [{ data: [] }, { ok: false, message: "Planning Center answered without the person record it should return." }],
    [
      { data: person("7", { name: candidate.secret }) },
      { ok: true, message: "Authenticated as [redacted] (person 7)." },
    ],
  ] as const) {
    queue({ body });
    expect(await connector.testCredentials!(candidate, context({ applicationId: "stored", secret: "stored" }))).toEqual(
      expected,
    );
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      headers: {
        authorization: `Basic ${btoa("candidate-id:candidate-secret")}`,
        "x-pco-api-version": "2026-06-04",
        "user-agent": "fixture-agent/1",
      },
    });
    expect(calls.at(-1)!.url.href).toBe("https://api.planningcenteronline.com/people/v2/me?include=organization");
  }
  for (const values of [{}, { applicationId: "a" }, { applicationId: "bad:id", secret: "x" }]) {
    const count = calls.length;
    expect(await connector.testCredentials!(values, context())).toMatchObject({ ok: false });
    expect(calls).toHaveLength(count);
  }
});
