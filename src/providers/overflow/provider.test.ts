import { kitInputDisagreements } from "../../../test/helpers/kit-schema.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import goldenSpec from "../../../test/goldens/overflow/spec.js";
import { resultSafety } from "../../http/safety.js";
import type { Connection } from "../../http/vendor.js";
import { validateToolInput } from "../../validate.js";
import { errors, safety, OVERFLOW_INDEX, OVERFLOW_VERDICTS } from "./api.js";
import { overflowTools } from "./tools.js";
// Goldens own catalog and fixture bytes. Fold wire-edge regressions into the
// existing reset-header and candidate-credential cases without adding rows.
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
  it("INV-1 INV-5 INV-9 INV-11: admits the standard contracts, binds exact-count pages, strips secrets and preserves single-send recovery", async () => {
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

    const connector = connection();
    const ctx = context();
    const id = "0123456789abcdef01234567";
    expect(OVERFLOW_INDEX.ops).toHaveLength(38);
    expect(Object.keys(OVERFLOW_VERDICTS)).toHaveLength(38);
    const beforeDiscovery = calls.length;
    for (const [query, path] of [
      ["payout", "/deposits"],
      ["recurring gift", "/subscriptions"],
      ["refund", `/contributions/{contributionId}/initiate-refund`],
      ["delivery failures", "/webhooks/{webhookId}/event-logs"],
    ]) {
      const found = await call(connector, "overflow_api_search", { query, limit: 8 }, ctx);
      expect(
        found.operations.some((op: { path: string }) => op.path === path),
        query,
      ).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify(found)).length).toBeLessThanOrEqual(16 * 1024);
    }
    const details = await call(
      connector,
      "overflow_api_details",
      { method: "POST", path: "/subscriptions/{donorId}" },
      ctx,
    );
    expect(details.body.schema.required).toEqual(expect.arrayContaining(["paymentMethodId", "amount", "frequency"]));
    expect(calls).toHaveLength(beforeDiscovery);

    // Fields and withheld values fail before auth or dispatch, including on writes.
    for (const [tool, args] of [
      ["get_donor", { donorId: id, fields: ["not_a_property"] }],
      [
        "overflow_api_write",
        { method: "PATCH", path: `/donors/${id}`, body: { phone: "new" }, fields: ["not_a_property"] },
      ],
      ["overflow_api_write", { method: "POST", path: `/contributions/${id}/initiate-refund`, fields: ["id"] }],
      ["overflow_api_read", { path: "/unsupported" }],
      ["overflow_api_read", { path: "/donors/%2e%2e/health" }],
      ["overflow_api_write", { method: "PATCH", path: `/donors/${id}`, body: { phone: "[redacted]" } }],
      ["overflow_api_read", { path: "/donors/%5Bredacted%5D" }],
    ] as const) {
      expect(await failure(call(connector, tool, args, context(null)))).toMatchObject({ code: "invalid_args" });
    }
    for (const limit of [0, -1, 101, 1.5]) {
      expect(await failure(call(connector, "list_donors", { limit }, ctx))).toMatchObject({ code: "invalid_args" });
      expect(
        await failure(call(connector, "overflow_api_read", { path: "/donors", query: { limit } }, ctx)),
      ).toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toHaveLength(beforeDiscovery);

    queue({ body: { data: [{ id, email: "alice@example.com" }], totalCount: 2 } });
    const first = await call(connector, "list_donors", { limit: 1, fields: ["id"] }, ctx);
    expect(first).toMatchObject({ items: [{ id }], page: { hasMore: true, total: 2 } });
    const start = calls.length;
    for (const args of [
      { limit: 2, cursor: first.page.nextCursor },
      { limit: 1, sortBy: "email", cursor: first.page.nextCursor },
      { limit: 1, cursor: first.page.nextCursor + "x" },
    ])
      expect(await failure(call(connector, "list_donors", args, ctx))).toMatchObject({ code: "invalid_args" });
    expect(
      await failure(call(connection(), "list_donors", { limit: 1, cursor: first.page.nextCursor }, context())),
    ).toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(start);
    queue({ body: { data: [{ id, email: "bob@example.com" }], totalCount: 2 } });
    expect(
      await call(connector, "list_donors", { limit: 1, cursor: first.page.nextCursor, fields: ["email"] }, ctx),
    ).toEqual({ items: [{ email: "bob@example.com" }], page: { hasMore: false, total: 2 } });
    expect(new URL(calls.at(-1)!.url).searchParams.get("page")).toBe("2");
    queue({ body: { data: [{ id }] } });
    const uncounted = await call(connector, "list_donors", { limit: 1 }, ctx);
    expect(uncounted.page).toMatchObject({ hasMore: true });
    expect(uncounted.page).not.toHaveProperty("total");
    queue({ body: { data: [] } });
    expect(await call(connector, "list_donors", { limit: 1, cursor: uncounted.page.nextCursor }, ctx)).toEqual({
      items: [],
      page: { hasMore: false },
    });
    queue({ body: { data: [], totalCount: 0 } });
    expect(await call(connector, "list_donors", { fields: ["id"] }, ctx)).toEqual({
      items: [],
      page: { hasMore: false, total: 0 },
    });
    for (const totalCount of [-1, "2", 1.5]) {
      queue({ body: { data: [], totalCount } });
      expect(await failure(call(connector, "list_donors", {}, ctx))).toMatchObject({
        code: "connector_call_failed",
        retryable: false,
      });
    }

    // Hatch adapters inspect safe metadata before fields, restore numeric pages and bind filters/fields.
    const hatchArgs = { path: "/donors", query: { limit: 1 }, fields: ["data.id"] };
    queue({ body: { data: [{ id, email: "alice@example.com" }], totalCount: 2 } });
    const hatchFirst = await call(connector, "overflow_api_read", hatchArgs, ctx);
    expect(hatchFirst).toMatchObject({
      status: 200,
      data: { data: [{ id }] },
      page: { hasMore: true, param: "page", in: "query" },
    });
    const bound = calls.length;
    expect(
      await failure(
        call(
          connector,
          "overflow_api_read",
          { ...hatchArgs, query: { limit: 2, page: hatchFirst.page.nextCursor } },
          ctx,
        ),
      ),
    ).toMatchObject({ code: "invalid_args" });
    expect(
      await failure(
        call(
          connector,
          "overflow_api_read",
          { ...hatchArgs, fields: ["data.email"], query: { limit: 1, page: hatchFirst.page.nextCursor } },
          ctx,
        ),
      ),
    ).toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(bound);
    queue({ body: { data: [{ id }], totalCount: 2 } });
    const hatchLast = await call(
      connector,
      "overflow_api_read",
      { ...hatchArgs, query: { limit: 1, page: hatchFirst.page.nextCursor } },
      ctx,
    );
    expect(hatchLast.page).toEqual({ hasMore: false, param: "page", in: "query" });
    expect(new URL(calls.at(-1)!.url).searchParams.get("page")).toBe("2");
    queue({ body: { data: [], totalCount: 0 } });
    await call(
      connector,
      "overflow_api_read",
      { path: "/contributions", query: { "statusBucket[]": ["PENDING", "CONFIRMED"], "locationIds[]": [id] } },
      ctx,
    );
    expect(new URL(calls.at(-1)!.url).searchParams.getAll("statusBucket[]")).toEqual(["PENDING", "CONFIRMED"]);
    expect(new URL(calls.at(-1)!.url).searchParams.getAll("locationIds[]")).toEqual([id]);

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
    ]) {
      queue({ body });
      expect(
        JSON.stringify(await call(connector, "overflow_api_read", { path: `/webhooks/${id}` }, ctx)),
      ).not.toContain("private-signing-value");
    }

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
    queue({ status: 204 });
    expect(
      await call(
        connector,
        "overflow_api_write",
        { method: "PATCH", path: `/donors/${id}`, body: { phone: "new" } },
        ctx,
      ),
    ).toEqual({ status: 204, data: null });
    queue({ status: 500, body: { message: "Upstream failure" } });
    const sent = calls.length;
    expect(
      await failure(
        call(connector, "overflow_api_write", { method: "PATCH", path: `/donors/${id}`, body: { phone: "new" } }, ctx),
      ),
    ).toMatchObject({ retryable: false, writeOutcome: "unknown" });
    expect(calls).toHaveLength(sent + 1);
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
