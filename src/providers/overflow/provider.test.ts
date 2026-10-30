import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";

// Overflow fixture regressions cover reset headers, candidate credentials,
// pagination, privacy and single-send recovery.
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
  installOwnedTransport();
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

describe("overflow() standard surface", () => {
  it("INV-3 INV-5 INV-9: rejects malformed vendor totals, protects webhook signing keys and recognizes refund acknowledgements", async () => {
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

    const connector = connection();
    const ctx = context();
    const id = "0123456789abcdef01234567";
    for (const totalCount of [-1, "2", 1.5]) {
      queue({ body: { data: [], totalCount } });
      expect(await failure(call(connector, "list_donors", {}, ctx))).toMatchObject({
        code: "connector_call_failed",
        retryable: false,
      });
    }

    const logs = { path: `/webhooks/${id}/event-logs`, query: { limit: 1 } };
    queue({
      body: { data: [{ id: "attempt" }], pageInfo: { hasNextPage: true, nextCursor: "native-delivery-token" } },
    });
    const delivery = await call(connector, "overflow_api_read", logs, ctx);
    queue({ body: { data: [], pageInfo: { hasNextPage: false, nextCursor: null } } });
    expect(
      (
        await call(
          connector,
          "overflow_api_read",
          { ...logs, query: { limit: 1, cursor: delivery.page.nextCursor } },
          ctx,
        )
      ).page.hasMore,
    ).toBe(false);
    expect(new URL(calls.at(-1)!.url).searchParams.get("cursor")).toBe("native-delivery-token");
    for (const pageInfo of [
      { hasNextPage: true, nextCursor: null },
      { hasNextPage: "true", nextCursor: "x" },
      { hasNextPage: true, nextCursor: KEYS.apiKey },
    ]) {
      queue({ body: { data: [], pageInfo } });
      const error = await failure(call(connector, "overflow_api_read", logs, ctx));
      expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(error.message).not.toContain(KEYS.apiKey);
    }
    for (const body of [
      { id, secret: "private-signing-value" },
      { data: { id, signingSecret: "private-signing-value" } },
      [{ id, secret: "private-signing-value" }],
      { data: [{ id, signingKey: "private-signing-value" }] },
      {
        data: [
          {
            id,
            Secret: "private-signing-value",
            secretKey: "private-signing-value",
            signing_key: "private-signing-value",
            delivery: { hmacSecret: "private-signing-value", HMAC_KEY: "private-signing-value" },
          },
        ],
      },
    ]) {
      queue({ body });
      expect(
        JSON.stringify(await call(connector, "overflow_api_read", { path: `/webhooks/${id}` }, ctx)),
      ).not.toContain("private-signing-value");
    }
    queue({ body: { data: { id, metadata: { secretKey: "ordinary-operator-data" } } } });
    expect(await call(connector, "get_contribution", { contributionId: id, fields: ["metadata"] }, ctx)).toEqual({
      metadata: { secretKey: "ordinary-operator-data" },
    });
    queue({ body: { data: { id, phone: "+15555550123", address: { city: "Example" } } } });
    expect(await call(connector, "get_donor", { donorId: id, fields: ["phone", "address"] }, ctx)).toEqual({
      phone: "+15555550123",
      address: { city: "Example" },
    });

    queue({ text: "ok", headers: { "content-type": "text/plain" } });
    expect(await call(connector, "overflow_api_read", { path: "/health" }, ctx)).toEqual({ status: 200, data: "ok" });
    queue({ status: 202, body: "Refund initiated" });
    expect(
      await call(
        connector,
        "overflow_api_write",
        { method: "POST", path: `/contributions/${id}/initiate-refund` },
        ctx,
      ),
    ).toEqual({ status: 202, data: "Refund initiated" });
    queue({ status: 202, text: "Refund initiated", headers: { "content-type": "text/plain; charset=utf-8" } });
    const beforeRefund = calls.length;
    expect(
      await call(
        connector,
        "overflow_api_write",
        {
          method: "POST",
          path: `/contributions/${id}/initiate-refund`,
        },
        ctx,
      ),
    ).toEqual({ status: 202, data: "Refund initiated" });
    expect(calls).toHaveLength(beforeRefund + 1);
    for (const type of [
      "text/html",
      "application/octet-stream",
      "application/pdf",
      "application/xml",
      "application/json",
    ]) {
      queue({
        status: 200,
        text: type === "application/json" ? '{"ok":true}' : "Unexpected acknowledgement",
        headers: { "content-type": type },
      });
      const before = calls.length;
      const error = await failure(
        call(connector, "overflow_api_write", { method: "POST", path: `/contributions/${id}/initiate-refund` }, ctx),
      );
      expect(error).toMatchObject({ code: "connector_call_failed", writeOutcome: "unknown", retryable: false });
      expect(error.message).toContain("check the target before repeating");
      if (type === "text/html") expect(error.message).toContain("unexpected text/HTML");
      expect(calls).toHaveLength(before + 1);
    }
    queue({ status: 204 });
    expect(
      await call(
        connector,
        "overflow_api_write",
        { method: "PATCH", path: `/donors/${id}`, body: { phone: "new" } },
        ctx,
      ),
    ).toEqual({ status: 204, data: null });
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
      // An incomplete candidate is refused before anything is sent.
      failure: "rejected",
    });
    expect(calls).toHaveLength(before);
    queue({ status: 403, body: { message: "Forbidden resource" } }, { text: "maintenance" });
    expect(await connection().testCredentials!(KEYS, context())).toMatchObject({
      ok: false,
      message: expect.stringContaining("HTTP 403"),
      failure: "scope",
    });
    expect(await connection().testCredentials!(KEYS, context())).toEqual({
      ok: false,
      message: "Overflow returned a non-JSON body for a successful read.",
      failure: "failed",
    });
  });
});
