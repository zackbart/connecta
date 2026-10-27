// Breeze uses GET for writes as well as reads. These regressions exercise
// hatch admission, credential probes, projection and input decoding.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { ConnectorCallError } from "../../errors.js";
import { breeze } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
    const text = next.text ?? JSON.stringify(next.body ?? []);
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    // Breeze labels JSON responses text/html; the stub does the same.
    return new Response(text, {
      status: next.status ?? 200,
      headers: { "content-type": "text/html; charset=UTF-8", ...next.headers },
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function context(key: string | null = "breeze-key"): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async () => key,
      getAll: async () => (key ? { value: key } : null),
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return breeze("church", {
    subdomain: "gracechurch",
    purpose: "Pastoral care and giving reports",
    ...overrides,
  } as Parameters<typeof breeze>[1]);
}

function call(
  connector: Connector,
  name: string,
  args: Record<string, unknown> = {},
  ctx: ConnectorContext = context(),
): Promise<any> {
  return connector.callTool(name, args, ctx) as Promise<any>;
}

async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorCallError) return error;
    throw error;
  }
  throw new Error("expected a ConnectorCallError");
}

it("INV-11: confines a church hostname and rejects invalid construction", () => {
  for (const subdomain of ["https://church.breezechms.com", "evil.example.com", "church/path", "-church"])
    expect(() => breeze("church", { subdomain, purpose: "Care" })).toThrow("one hostname label");
  for (const options of [
    { title: "" },
    { title: " " },
    { purpose: "" },
    { defaultPageSize: 0 },
    { defaultPageSize: 1001 },
  ])
    expect(() => connection(options)).toThrow();
});

it("INV-9: preserves factual in-band failures and JSON success contracts", async () => {
  for (const [tool, args, body, message] of [
    ["get_person", { personId: "999" }, [], "no person"],
    ["add_person", { firstName: "Alice", lastName: "New" }, false, "answered false"],
    [
      "breeze_api_write",
      { method: "GET", path: "/tags/assign", query: { person_id: "1", tag_id: "2" } },
      false,
      "answered false",
    ],
    [
      "breeze_api_write",
      { method: "GET", path: "/tags/unassign", query: { person_id: "1", tag_id: "2" } },
      false,
      "answered false",
    ],
    [
      "breeze_api_write",
      { method: "GET", path: "/events/attendance/add", query: { person_id: "1", instance_id: "2", direction: "in" } },
      false,
      "answered false",
    ],
    [
      "breeze_api_read",
      { path: "/giving/view", query: { payment_id: "1" } },
      { success: false, errors: "Payment not found" },
      "Payment not found",
    ],
    [
      "breeze_api_write",
      { method: "GET", path: "/people/update", query: { person_id: "1", fields_json: "[]" } },
      { errorCode: 12, errorMessage: "Bad person" },
      "Bad person",
    ],
  ] as const) {
    const count = calls.length;
    queue({ body });
    const error = await failure(call(connection(), tool, args));
    expect(error.message).toContain(message);
    if (body === false)
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
    expect(calls).toHaveLength(count + 1);
  }
  queue({ body: false });
  expect(await call(connection(), "breeze_api_read", { path: "/events/locations" })).toEqual({
    status: 200,
    data: false,
  });
  queue({ body: { success: true, errors: null, payment_id: 1 } });
  expect(
    await call(connection(), "breeze_api_write", { method: "GET", path: "/giving/add", query: { amount: "1.00" } }),
  ).toEqual({ status: 200, data: { success: true, errors: null, payment_id: 1 } });
  for (const tool of ["list_funds", "breeze_api_read"]) {
    queue({ text: "<html>maintenance</html>" });
    expect((await failure(call(connection(), tool, tool === "list_funds" ? {} : { path: "/funds/list" }))).code).toBe(
      "connector_call_failed",
    );
  }
  for (const tool of ["add_person", "update_person"]) {
    queue({ body: true });
    expect(
      await call(
        connection(),
        tool,
        tool === "add_person"
          ? { firstName: "Alice", lastName: "New" }
          : { personId: "1", values: [{ fieldId: "2", type: "text", response: "ok" }] },
      ),
    ).toEqual({ ok: true });
  }
});

it("INV-1 INV-4 INV-9: refuses GET-shaped mutations and dispatcher overrides on the read hatch", async () => {
  const connector = connection(),
    ctx = context();
  for (const path of [
    "/people/add",
    "/people/123/delete",
    "/tags/assign",
    "/events/attendance/add",
    "/giving/edit",
    "/giving/brand_new_read",
    "/people/new_dispatch",
    "/People",
    "/people/../people/add",
    "/people/%61dd",
    "/people?x=1",
    "/people/",
    "//evil.example.com/api",
    "https://evil.example.com/api/people",
  ])
    expect((await failure(call(connector, "breeze_api_read", { path }, ctx))).code, path).toBe("invalid_args");
  for (const query of [
    { c: "people", m: "delete" },
    { _method: "DELETE" },
    { filter_json: { tag_contains: "y_1" } },
    { details: "[redacted]" },
    { details: [0, 1] },
    ...["abc", "-1", "1.5", " 2", "2e0", "1001", "9007199254740992"].map((limit) => ({ limit })),
  ])
    expect((await failure(call(connector, "breeze_api_read", { path: "/people", query }, ctx))).code).toBe(
      "invalid_args",
    );
  for (const args of [
    { method: "GET", path: "/people/add", query: { first: "Alice", last: "New" }, fields: ["nope"] },
    { method: "GET", path: "/tags/assign", query: { person_id: "1", tag_id: "2" }, fields: ["id"] },
    { method: "GET", path: "/people/add", query: { first: "Alice" } },
    { method: "GET", path: "/people" },
  ])
    expect((await failure(call(connector, "breeze_api_write", args, ctx))).code).toBe("invalid_args");
  expect(calls).toHaveLength(0);
});

it("INV-5: calendar credentials stay removed across vendor response envelopes", async () => {
  const connector = connection(),
    ctx = context();
  for (const fields of [undefined, ["id", "address", "embed_key"]]) {
    queue({
      body: [
        {
          id: 0,
          name: "Main",
          color: "blue",
          address: "https://church.breezechms.com/events/feed/SECRET",
          embed_key: "AbC",
        },
      ],
    });
    const result = await call(
      connector,
      "breeze_api_read",
      { path: "/events/calendars/list", ...(fields ? { fields } : {}) },
      ctx,
    );
    expect(result).toEqual({ status: 200, data: [fields ? { id: 0 } : { id: 0, name: "Main", color: "blue" }] });
  }
  const calendar = {
    id: "1",
    name: "Main",
    address: "https://church.breezechms.com/events/feed/SECRET",
    embed_key: "AbC",
  };
  for (const [body, safe] of [
    [calendar, { id: "1", name: "Main" }],
    [{ "1": calendar }, { "1": { id: "1", name: "Main" } }],
    [{ calendars: [calendar] }, { calendars: [{ id: "1", name: "Main" }] }],
  ]) {
    queue({ body });
    expect(await call(connector, "breeze_api_read", { path: "/events/calendars/list" }, ctx)).toEqual({
      status: 200,
      data: safe,
    });
  }
});

it("INV-5: probes only the candidate key and refuses a different reported church", async () => {
  const connector = connection();
  for (const [body, expected] of [
    [
      { id: "1234", name: "Grace Church", subdomain: "gracechurch" },
      { ok: true, message: "Authenticated to Grace Church (gracechurch.breezechms.com)." },
    ],
    [
      { id: "9", name: "Other", subdomain: "otherchurch" },
      { ok: false, message: "The key belongs to otherchurch.breezechms.com, not gracechurch.breezechms.com." },
    ],
  ] as const) {
    queue({ body });
    expect(await connector.testCredential!("candidate-key", context(null))).toEqual(expected);
    expect(calls.at(-1)!.headers["api-key"]).toBe("candidate-key");
  }
});
