import { kitInputDisagreements } from "../../../test/helpers/kit-schema.js";
import goldenSpec from "../../../test/goldens/overflow/spec.js";
import { resultSafety } from "../../http/safety.js";
import type { Connection } from "../../http/vendor.js";
import { validateToolInput } from "../../validate.js";
import { errors, safety } from "./api.js";
import { overflowTools } from "./tools.js";
// The goldens cover tools, projections and errors. Keep only Overflow's
// reset-header fallback and candidate credential probe beyond that evidence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { overflow } from "./index.js";
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
    purpose: "Nonprofit giving and deposits",
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

async function failure(promise: Promise<unknown>): Promise<ConnectorCallError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConnectorCallError);
  return error as ConnectorCallError;
}

describe("overflow() rate limits", () => {
  it("INV-11: aligns catalog decoding and waits out the reported 429 window or the whole window without one", async () => {
    const kitConnection = { errors, safety: resultSafety(safety) } as Connection;
    for (const tool of overflowTools({ connection: kitConnection, pageSize: 25 })) {
      const base = goldenSpec.calls.find((fixture) => fixture.tool === tool.name)?.args ?? {};
      expect(
        validateToolInput(tool.inputSchema!, base, { address: tool.name, failClosed: true }),
        tool.name,
      ).toBeNull();
      expect(kitInputDisagreements(tool, base), tool.name).toEqual([]);
    }
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

describe("overflow() credential probe", () => {
  it("INV-5 INV-10: probes the candidate pair in both environments and preserves its refusal messages", async () => {
    for (const environment of ["production", "staging"] as const) {
      queue({ body: { data: [{ name: "Main Campus" }], totalCount: 2 } });
      const connector = connection({ environment });
      const result = await connector.testCredentials!(
        KEYS,
        context({ clientId: "ambient-client", apiKey: "ambient-key" }),
      );
      expect(result).toEqual({
        ok: true,
        message: `Overflow ${environment} accepted the client id and API key. The nonprofit's first location is "Main Campus" of 2.`,
      });
      const sent = calls.at(-1)!;
      expect(sent.url).toBe(
        `https://server.${environment === "staging" ? "stage." : ""}overflow.co/api/v3/locations?limit=1&sortBy=displayOrder`,
      );
      expect(sent.headers).toMatchObject({ "x-client-id": KEYS.clientId, "x-api-key": KEYS.apiKey });
    }
    const before = calls.length;
    const missing = await connection().testCredentials!({ clientId: KEYS.clientId }, context());
    expect(missing).toEqual({
      ok: false,
      message:
        "No Overflow client id and API key are configured for this connector. Call authorize_connector for recovery options; an operator adds both fields in this connection in the operator UI.",
    });
    expect(calls).toHaveLength(before);
    queue({ status: 403, body: { message: "Forbidden resource" } }, { text: "maintenance" });
    expect(await connection().testCredentials!(KEYS, context())).toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 403"),
    });
    expect(await connection().testCredentials!(KEYS, context())).toEqual({
      ok: false,
      message: "Overflow returned a non-JSON body for a successful read.",
    });
  });
});
