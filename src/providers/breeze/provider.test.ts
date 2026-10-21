// The Breeze connection is hand-written fetch against one church's own host.
// Request shapes, projections, and status mapping live in the characterization
// goldens. Every Breeze call is a GET, writes included, so the read hatch's
// allowlist is the safety boundary under test here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function url(index = 0): URL {
  return new URL(calls[index]!.url);
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

describe("breeze() construction", () => {
  it("requires a single-label subdomain, so the host cannot be redirected", () => {
    for (const subdomain of ["https://gracechurch.breezechms.com", "evil.example.com", "grace/church", "-grace"]) {
      expect(() => breeze("church", { subdomain, purpose: "Care" })).toThrow("one hostname label");
    }
  });
});

describe("Breeze vendor parsing", () => {
  it("maps an empty person answer to not_found, since a Breeze key has no scopes", async () => {
    queue({ body: [] });
    const error = await failure(call(connection(), "get_person", { personId: "999" }));
    expect(error.code).toBe("not_found");
  });

  it("refuses a non-numeric person id locally, so no path can be spelled through it", async () => {
    const error = await failure(call(connection(), "get_person", { personId: "delete" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("treats a false answer to a named write as a failure", async () => {
    queue({ body: false });
    const error = await failure(call(connection(), "assign_tag", { personId: "1", tagId: "2" }));
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
  });

  it("reads a failure Breeze reports inside a 200, and not a null errors field", async () => {
    queue(
      { body: { success: false, errors: "Payment not found" } },
      { body: { errorCode: 12, errorMessage: "Bad person" } },
      { body: { success: true, errors: null, payment_id: 1320278 } },
    );
    const connector = connection();
    const reported = await failure(
      call(connector, "breeze_api_get", { path: "/giving/view", query: [{ name: "payment_id", value: "1" }] }),
    );
    expect(reported.code).toBe("connector_call_failed");
    expect(reported.message).toContain("Payment not found");
    const coded = await failure(call(connector, "breeze_api_mutate", { path: "/people/update" }));
    expect(coded.message).toContain("Bad person");
    const ok = await call(connector, "breeze_api_mutate", { path: "/giving/add" });
    expect(ok.result.payment_id).toBe(1320278);
  });
});

describe("Breeze hatches split by endpoint, not by method", () => {
  it("refuses every write endpoint through the read hatch, fail-closed", async () => {
    for (const path of [
      "/people/add",
      "/people/123/delete",
      "/tags/assign",
      "/events/attendance/add",
      "/giving/edit",
      "/giving/brand_new_read",
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
      expect(error.message, path).toContain("breeze_api_mutate");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses paths that are not plain lowercase segments", async () => {
    for (const path of [
      "/People",
      "/people/../people/add",
      "/people/%61dd",
      "/people?x=1",
      "//evil.example.com/api",
      "https://evil.example.com/api/people",
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses unreviewed parameters on a reviewed read path", async () => {
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
    ]) {
      const error = await failure(call(connection(), "breeze_api_get", { path: "/people", query }));
      expect(error.code).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("keeps the mutate hatch confined to the church's /api", async () => {
    const error = await failure(call(connection(), "breeze_api_mutate", { path: "/../extensions/api" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("INV-5: neither hatch returns a calendar's keyless feed address", async () => {
    const calendars = [
      {
        id: 0,
        name: "Main",
        color: "b2cd92",
        address: "https://gracechurch.breezechms.com/events/feed/SECRET",
        embed_key: "AbC",
      },
    ];
    queue({ body: calendars }, { body: calendars });
    const connector = connection();
    for (const tool of ["breeze_api_get", "breeze_api_mutate"]) {
      const result = await call(connector, tool, { path: "/events/calendars/list" });
      expect(result, tool).toEqual({ result: [{ id: 0, name: "Main", color: "b2cd92" }] });
    }
  });
});

describe("Breeze credentials", () => {
  it("fails locally without a key", async () => {
    const error = await failure(call(connection(), "list_funds", {}, context(null)));
    expect(error.code).toBe("auth_required");
    expect(calls).toHaveLength(0);
  });

  it("tests the candidate key against the account summary and refuses another church's key", async () => {
    queue({ body: { id: "1234", name: "Grace Church", subdomain: "gracechurch" } });
    const connector = connection();
    const ok = await connector.testCredential!("candidate-key", context(null));
    expect(ok).toEqual({ ok: true, message: "Authenticated to Grace Church (gracechurch.breezechms.com)." });
    expect(calls[0]!.headers["api-key"]).toBe("candidate-key");

    queue({ body: { id: "9", name: "Other", subdomain: "otherchurch" } });
    const mismatch = await connector.testCredential!("candidate-key", context(null));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.message).toContain("otherchurch");
  });
});

describe("Breeze people and profile reads", () => {
  it("ends paging on a short page and uses the configured default page size", async () => {
    queue({ body: [{ id: "1", first_name: "A", last_name: "B" }] });
    const result = await call(connection({ defaultPageSize: 25 }), "list_people");
    expect(url().searchParams.get("limit")).toBe("25");
    expect(url().searchParams.get("filter_json")).toBeNull();
    expect(result.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("refuses a tag passed both ways before any request", async () => {
    const error = await failure(
      call(connection(), "list_people", {
        tagId: "1",
        filter: { tag_contains: "y_2" },
      }),
    );
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("Breeze events, attendance, forms, volunteers, and the log", () => {
  it("refuses a non-ISO date before the request", async () => {
    const error = await failure(call(connection(), "list_events", { start: "5-3-2025" }));
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("Breeze giving reads (undocumented endpoints)", () => {
  it("refuses includeFamily without a donor before the request", async () => {
    const error = await failure(
      call(connection(), "list_contributions", {
        start: "2022-01-01",
        end: "2022-06-30",
        includeFamily: true,
      }),
    );
    expect(error.code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });
});

describe("Breeze typed failures and credential test", () => {
  it("refuses a non-JSON success on a named read instead of inventing rows", async () => {
    queue({ text: "<html>maintenance</html>" });
    const error = await failure(call(connection(), "list_funds"));
    expect(error.code).toBe("connector_call_failed");
  });
});
