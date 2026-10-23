// The Breeze connection is hand-written fetch against one church's own host.
// Request shapes, projections, and status mapping live in the characterization
// goldens. Every Breeze call is a GET, writes included, so the read hatch's
// allowlist is the safety boundary under test here.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { errors, breezeSafety } from "./api.js";
import { breezeTools } from "./tools.js";
import { resultSafety } from "../../http/safety.js";
import type { Connection } from "../../http/vendor.js";
import { kitInputDisagreements } from "../../../test/helpers/kit-schema.js";
import goldenCalls from "../../../test/goldens/breeze/calls.json";
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

it("preserves vendor in-band failures, missing people, and JSON versus text contracts", async () => {
  for (const [tool, args, body, message] of [
    ["get_person", { personId: "999" }, [], "no person"],
    ["assign_tag", { personId: "1", tagId: "2" }, false, "answered false"],
    ["breeze_api_get", { path: "/giving/view" }, { success: false, errors: "Payment not found" }, "Payment not found"],
    ["breeze_api_mutate", { path: "/people/update" }, { errorCode: 12, errorMessage: "Bad person" }, "Bad person"],
  ] as const) {
    queue({ body });
    expect((await failure(call(connection(), tool, args))).message).toContain(message);
  }
  queue(
    { body: { success: true, errors: null, payment_id: 1320278 } },
    { text: "<html>maintenance</html>" },
    { text: "<html>maintenance</html>" },
  );
  expect(await call(connection(), "breeze_api_mutate", { path: "/giving/add" })).toEqual({
    result: { success: true, errors: null, payment_id: 1320278 },
  });
  expect((await failure(call(connection(), "list_funds"))).code).toBe("connector_call_failed");
  expect(await call(connection(), "breeze_api_get", { path: "/funds/list" })).toEqual({
    result: "<html>maintenance</html>",
  });
});

it("INV-1 INV-4 INV-9: the read hatch refuses unreviewed GET writes, paths, and parameters before dispatch", async () => {
  const connector = connection();
  for (const path of [
    "/people/add",
    "/people/123/delete",
    "/tags/assign",
    "/events/attendance/add",
    "/giving/edit",
    "/giving/brand_new_read",
    "/People",
    "/people/../people/add",
    "/people/%61dd",
    "/people?x=1",
    "//evil.example.com/api",
    "https://evil.example.com/api/people",
  ])
    expect((await failure(call(connector, "breeze_api_get", { path }))).code, path).toBe("invalid_args");
  for (const query of [
    [
      { name: "c", value: "people" },
      { name: "m", value: "delete" },
    ],
    [{ name: "_method", value: "DELETE" }],
    [
      { name: "limit", value: 1 },
      { name: "limit", value: 2 },
    ],
  ])
    expect((await failure(call(connector, "breeze_api_get", { path: "/people", query }))).code).toBe("invalid_args");
  expect(calls).toHaveLength(0);
  const catalog = await connector.listTools(context());
  for (const name of [
    "add_person",
    "update_person",
    "assign_tag",
    "unassign_tag",
    "record_check_in",
    "breeze_api_mutate",
  ])
    expect(catalog.find((tool) => tool.name === name)?.annotations?.readOnlyHint, name).toBe(false);
});

it("INV-5: both hatches remove keyless calendar feeds before returning raw answers", async () => {
  for (const tool of ["breeze_api_get", "breeze_api_mutate"]) {
    queue({
      body: [
        {
          id: 0,
          name: "Main",
          color: "b2cd92",
          address: "https://church.breezechms.com/events/feed/SECRET",
          embed_key: "AbC",
        },
      ],
    });
    expect(await call(connection(), tool, { path: "/events/calendars/list" })).toEqual({
      result: [{ id: 0, name: "Main", color: "b2cd92" }],
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

it("INV-11: every authored catalog agrees with its kit decoder at argument boundaries", () => {
  const tools = breezeTools({
    connection: { errors, safety: resultSafety(breezeSafety) } as Connection,
    pageSize: 100,
  });
  for (const tool of tools) {
    const base = goldenCalls.find((row) => row.tool === tool.name)!.args;
    expect(kitInputDisagreements(tool, base), tool.name).toEqual([]);
  }
});
