// The Overflow connection is hand-written fetch. Request shapes, projections,
// pagination, and status mapping live in the characterization goldens; these
// tests pin the environment choice, the credential admission, the money-unit
// guidance, the hatch confinement, and Overflow's own rate-limit header.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { OVERFLOW_API_BASE_URLS, overflow } from "./index.js";
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
  url: string;
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
    const text = next.text ?? JSON.stringify(next.body ?? {});
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response([204, 205, 304].includes(next.status ?? 200) ? null : text, {
      status: next.status ?? 200,
      ...(next.headers ? { headers: next.headers } : {}),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEYS = { clientId: "client-123", apiKey: "secret-key" };

function context(values: Record<string, string> | null = KEYS): ConnectorContext {
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
  return overflow("giving", {
    environment: "production",
    purpose: "Grace Church giving and deposits",
    ...overrides,
  } as Parameters<typeof overflow>[1]);
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

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorCallError);
  return error as ConnectorCallError;
}

describe("overflow() environment", () => {
  it("requires an explicit environment, with no default", () => {
    expect(() => overflow("giving", { purpose: "Giving" } as unknown as Parameters<typeof overflow>[1])).toThrow(
      'requires environment: "production" or "staging"',
    );
    expect(() =>
      overflow("giving", { environment: "sandbox", purpose: "Giving" } as unknown as Parameters<typeof overflow>[1]),
    ).toThrow('requires environment: "production" or "staging"');
  });

  it("sends each environment to its own origin below /api/v3", async () => {
    queue({ body: { data: [], totalCount: 0 } }, { body: { data: [], totalCount: 0 } });
    await call(connection(), "list_locations");
    await call(connection({ environment: "staging" }), "list_locations");
    expect(url(0).origin).toBe(OVERFLOW_API_BASE_URLS.production);
    expect(url(1).origin).toBe(OVERFLOW_API_BASE_URLS.staging);
    expect(url(0).pathname).toBe("/api/v3/locations");
  });

  it("states each write's money unit as Overflow's request schemas define it", async () => {
    // CreateSubscriptionRequest and UpdateSubscriptionRequest define `amount`
    // in dollars; AuthorizePaymentRequest takes `amountInCents`. A blanket
    // "cents" would turn a $50 recurring gift into $5,000.
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const content = flat(guide(connection()).content);
    expect(content).toContain("Recurring-gift `amount` is dollars");
    expect(content).toContain("a $50.00 monthly gift is `amount: 50`");
    expect(content).toContain("`POST /payments/authorize` takes `amountInCents`");
    expect(content).not.toMatch(/read as cents|amounts are cents/);
    const mutate = (await connection().listTools(context())).find((tool) => tool.name === "overflow_api_mutate")!;
    const body = flat(
      String((mutate.inputSchema!.properties as Record<string, { description?: string }>)["body"]!.description),
    );
    expect(body).not.toContain("amounts in cents");
    expect(body).toContain("subscription `amount` is dollars");
  });
});

describe("overflow() authentication", () => {
  it("refuses locally when either field is missing", async () => {
    const error = await failure(call(connection(), "list_locations", {}, context({ clientId: "client-123" })));
    expect(error.code).toBe("auth_required");
    expect(error.message).toContain("client id and API key");
    expect((await failure(call(connection(), "list_locations", {}, context(null)))).code).toBe("auth_required");
    expect(calls).toHaveLength(0);
  });

  it("tests credentials with one authenticated location read and names what it reached", async () => {
    queue({ body: { data: [{ id: "loc1", name: "Main Campus", isDefaultLocation: true }], totalCount: 3 } });
    const result = await connection({ environment: "staging" }).testCredentials!(KEYS, context(null));
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Overflow staging accepted");
    expect(result.message).toContain('"Main Campus" of 3');
    expect(url().pathname).toBe("/api/v3/locations");
    expect(url().searchParams.get("limit")).toBe("1");
    expect(url().origin).toBe(OVERFLOW_API_BASE_URLS.staging);
    expect(calls[0]!.headers["x-api-key"]).toBe("secret-key");
  });
});

describe("overflow() paths", () => {
  it("refuses a resource id that would spell another path, before any request", async () => {
    expect((await failure(call(connection(), "get_contribution", { contributionId: "../donors" }))).code).toBe(
      "invalid_args",
    );
    expect(calls).toHaveLength(0);
  });

  it("confines hatch paths below /api/v3", async () => {
    for (const path of ["https://evil.example/x", "/../docs/openapi.json", "/donors?x=1", "donors"]) {
      const error = await failure(call(connection(), "overflow_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("overflow() rate limits", () => {
  it("waits out a 429 for Overflow's reported window remainder, or the whole window without one", async () => {
    queue(
      {
        status: 429,
        body: { message: "ThrottlerException: Too Many Requests" },
        headers: { "x-ratelimit-reset": "37" },
      },
      { status: 429, body: {} },
    );
    const error = await failure(call(connection(), "list_locations"));
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 37_000 });
    expect((await failure(call(connection(), "list_locations"))).retryAfterMs).toBe(60_000);
  });
});

describe("overflow() named reads", () => {
  it("fails a successful named read that is not JSON", async () => {
    queue({ text: "<html>maintenance</html>" });
    const error = await failure(call(connection(), "list_locations"));
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
  });
});
