// The Overflow connection is hand-written fetch. Tests stub the network and
// pin what connecta owns: the environment choice, the two-header credential,
// array query encoding, projections that keep donor PII out of list rows,
// both pagination shapes, the hatch split, and the typed failures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import {
  OVERFLOW_API_BASE_URLS,
  overflow,
} from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { isExplicitlyReadOnly } from "../../tool-safety.js";
import { silentLogger } from "../../../test/helpers.js";
import type {
  Connector,
  ConnectorContext,
  ConnectorUsageGuide,
} from "../../types.js";

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
      get: async (field?: string) => (field && values ? values[field] ?? null : null),
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

const CONTRIBUTION = {
  id: "6710f34fd5061afeec3eab57",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
  type: "CASH",
  amount: 5000,
  donorCoveredFees: false,
  contributionDate: "2025-01-01T00:00:00.000Z",
  contributionReceivedAt: "2025-01-01T00:00:00.000Z",
  liquidationInitiatedAt: null,
  receivedTokensAt: null,
  status: "PAID_OUT",
  stocks: null,
  crypto: null,
  frequency: "one-time",
  paymentMethod: { type: "Card", last4: "4242", logoUrl: "https://cdn.example/visa.png" },
  depositId: "8810f34fd5061afeec3eab67",
  campaign: { id: "7710f34fd5061afeec3eab78", name: "Mission 2025" },
  subcampaign: null,
  dedication: null,
  donorNotes: null,
  anonymous: false,
  locationId: "6710f34fd5061afeec3eab58",
  donor: {
    id: "6710f34fd5061afeec3eab50",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane.doe@example.com",
    phone: "+15555550100",
    address: { line1: "1 Main St", city: "Springfield", state: "IL", zip: "62701" },
    totalContributionsCount: 12,
  },
  givingLinkId: null,
  pledgeId: null,
  metadata: null,
};

describe("overflow() construction", () => {
  it("requires a purpose and an explicit environment, with no default", () => {
    expect(() =>
      overflow("giving", { environment: "production", purpose: "  " }),
    ).toThrow("a non-empty purpose");
    expect(() =>
      overflow("giving", { purpose: "Giving" } as unknown as Parameters<typeof overflow>[1]),
    ).toThrow('requires environment: "production" or "staging"');
    expect(() =>
      overflow("giving", { environment: "sandbox", purpose: "Giving" } as unknown as Parameters<typeof overflow>[1]),
    ).toThrow('requires environment: "production" or "staging"');
    expect(() => connection({ defaultPageSize: 101 })).toThrow("between 1 and 100");
    expect(() => connection({ defaultPageSize: 0 })).toThrow("between 1 and 100");
  });

  it("names the environment in the title, description, and guide's first line", () => {
    const production = connection();
    const staging = connection({ environment: "staging" });
    expect(production.title).toBe("Overflow (production)");
    expect(staging.title).toBe("Overflow (staging)");
    expect(production.description).toContain("production: Grace Church");
    const firstLine = (connector: Connector) =>
      guide(connector).content.split("\n").find((line) => line && !line.startsWith("#"));
    expect(firstLine(production)).toContain("**production**");
    expect(firstLine(production)).toContain("real money");
    expect(firstLine(staging)).toContain("**staging**");
    expect(connection({ title: "Giving" }).title).toBe("Giving");
  });

  it("sends each environment to its own origin below /api/v3", async () => {
    queue({ body: { data: [], totalCount: 0 } }, { body: { data: [], totalCount: 0 } });
    await call(connection(), "list_locations");
    await call(connection({ environment: "staging" }), "list_locations");
    expect(url(0).origin).toBe(OVERFLOW_API_BASE_URLS.production);
    expect(url(1).origin).toBe(OVERFLOW_API_BASE_URLS.staging);
    expect(url(0).pathname).toBe("/api/v3/locations");
  });

  it("accepts a proxy origin override", async () => {
    queue({ body: { data: [], totalCount: 0 } });
    await call(connection({ baseUrl: "http://127.0.0.1:8787" }), "list_locations");
    expect(calls[0]!.url).toContain("http://127.0.0.1:8787/api/v3/locations");
  });

  it("ships named reads plus a GET hatch and a destructive mutate hatch, no upload", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    expect(connector.kind).toBe("api");
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_contribution",
      "get_deposit",
      "get_deposit_summary",
      "get_donor",
      "list_campaigns",
      "list_chargebacks",
      "list_contributions",
      "list_deposits",
      "list_donors",
      "list_locations",
      "list_payment_methods",
      "list_refunds",
      "list_subscriptions",
      "list_tap_events",
      "list_webhook_event_logs",
      "list_webhooks",
      "overflow_api_get",
      "overflow_api_mutate",
    ]);
    const writes = tools.filter((tool) => !isExplicitlyReadOnly(tool));
    expect(writes.map((tool) => tool.name)).toEqual(["overflow_api_mutate"]);
    expect(writes[0]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.every((tool) => typeof tool.annotations?.readOnlyHint === "boolean")).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("declares a two-field credential slot and the default rate budget", () => {
    const connector = connection();
    expect(connector.credential?.fields?.map((field) => field.name)).toEqual(["clientId", "apiKey"]);
    expect(connector.credential?.fields?.[1]?.inputType).toBe("password");
    expect(connector.testCredentials).toBeTypeOf("function");
    expect(connector.testCredential).toBeUndefined();
    expect(connector.callAdmission?.rules[0]).toMatchObject({
      maxConcurrency: 4,
      budget: { kind: "rolling-window", maxCalls: 120, windowMs: 60_000 },
    });
    const custom = { rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 30, windowMs: 60_000 } }] };
    expect(connection({ callAdmission: custom }).callAdmission).toEqual(custom);
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
    const body = flat(String((mutate.inputSchema!.properties as Record<string, { description?: string }>)["body"]!.description));
    expect(body).not.toContain("amounts in cents");
    expect(body).toContain("subscription `amount` is dollars");
  });

  it("appends nonprofit instructions to the maintained guide", () => {
    const content = guide(connection({ instructions: "Tithes live under the General campaign." })).content;
    expect(content).toContain("## Nonprofit instructions");
    expect(content).toContain("Tithes live under the General campaign.");
    expect(content).toContain("Reduce inside\n`execute_code`");
    expect(guide(connection()).required).toBe(true);
    expect(guide(connection()).summary!.length).toBeLessThanOrEqual(120);
  });
});

describe("overflow() authentication", () => {
  it("sends the client id and key as Overflow's two headers", async () => {
    queue({ body: { data: [], totalCount: 0 } });
    await call(connection(), "list_locations");
    expect(calls[0]!.headers["x-client-id"]).toBe("client-123");
    expect(calls[0]!.headers["x-api-key"]).toBe("secret-key");
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

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

  it("reports a rejected credential without throwing", async () => {
    queue({ status: 403, body: { error: "Forbidden resource" } });
    const result = await connection().testCredentials!(KEYS, context(null));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Forbidden resource");
    expect(result.message).toContain("other environment");
  });
});

describe("overflow() named reads", () => {
  it("lists contributions with bracketed array filters and Overflow's page defaults", async () => {
    queue({ body: { data: [CONTRIBUTION], totalCount: 60 } });
    const result = await call(connection(), "list_contributions", {
      statusBucket: ["PENDING", "CONFIRMED"],
      locationIds: ["6710f34fd5061afeec3eab58"],
      minimumUpdatedDate: "2025-01-01",
      campaignId: "7710f34fd5061afeec3eab78",
    });
    const sent = url();
    expect(sent.pathname).toBe("/api/v3/contributions");
    expect(sent.searchParams.getAll("statusBucket[]")).toEqual(["PENDING", "CONFIRMED"]);
    expect(sent.searchParams.getAll("locationIds[]")).toEqual(["6710f34fd5061afeec3eab58"]);
    expect(sent.searchParams.get("minimumUpdatedDate")).toBe("2025-01-01");
    expect(sent.searchParams.get("page")).toBe("1");
    expect(sent.searchParams.get("limit")).toBe("25");
    expect(result.page).toEqual({ page: 1, limit: 25, totalCount: 60, hasMore: true });
  });

  it("projects a contribution to donor identity, dropping contact details and noise", async () => {
    queue({ body: { data: [CONTRIBUTION], totalCount: 1 } });
    const [row] = (await call(connection(), "list_contributions")).contributions;
    expect(row).toEqual({
      id: CONTRIBUTION.id,
      type: "CASH",
      status: "PAID_OUT",
      amount: 5000,
      frequency: "one-time",
      contributionDate: CONTRIBUTION.contributionDate,
      donor: { id: CONTRIBUTION.donor.id, firstName: "Jane", lastName: "Doe" },
      anonymous: false,
      donorCoveredFees: false,
      campaign: { id: "7710f34fd5061afeec3eab78", name: "Mission 2025" },
      locationId: CONTRIBUTION.locationId,
      depositId: CONTRIBUTION.depositId,
      paymentMethod: { type: "Card", last4: "4242" },
      createdAt: CONTRIBUTION.createdAt,
      updatedAt: CONTRIBUTION.updatedAt,
    });
    expect(JSON.stringify(row)).not.toContain("jane.doe@example.com");
  });

  it("returns untouched rows with raw: true", async () => {
    queue({ body: { data: [CONTRIBUTION], totalCount: 1 } });
    const result = await call(connection(), "list_contributions", { raw: true, page: 1, limit: 1 });
    expect(result.contributions[0]).toEqual(CONTRIBUTION);
    expect(result.page.hasMore).toBe(false);
  });

  it("derives hasMore from a full page when Overflow omits totalCount", async () => {
    queue({ body: { data: [CONTRIBUTION, CONTRIBUTION] } });
    const result = await call(connection({ defaultPageSize: 2 }), "list_contributions", { page: 3 });
    expect(result.page).toEqual({ page: 3, limit: 2, totalCount: 6, hasMore: true });
  });

  it("refuses an argument the schema does not declare before any request", async () => {
    const error = await failure(call(connection(), "list_contributions", { donorEmail: "x" }));
    expect(error.code).toBe("invalid_args");
    expect((await failure(call(connection(), "list_contributions", { limit: 101 }))).code).toBe("invalid_args");
    expect((await failure(call(connection(), "get_contribution", { contributionId: "../donors" }))).code).toBe("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("unwraps a single contribution", async () => {
    queue({ body: { data: CONTRIBUTION } });
    const result = await call(connection(), "get_contribution", { contributionId: CONTRIBUTION.id });
    expect(url().pathname).toBe(`/api/v3/contributions/${CONTRIBUTION.id}`);
    expect(result.donor).toEqual({ id: CONTRIBUTION.donor.id, firstName: "Jane", lastName: "Doe" });
  });

  it("lists deposits with renamed filters and gets one with its line items and summary", async () => {
    const deposit = {
      id: "8810f34fd5061afeec3eab67",
      status: "PAID",
      type: "AUTOMATED",
      amountInCents: 125000,
      arrivalAt: "2026-01-15T00:00:00.000Z",
      startingBalanceInCents: null,
      endingBalanceInCents: null,
      bankName: "First Bank",
      bankLast4: "6789",
      statementDescriptor: "OVERFLOW",
      paymentMethodType: ["card", "ach"],
      name: null,
      reconciledAt: null,
      createdAt: "2026-01-13T00:00:00.000Z",
      updatedAt: "2026-01-15T00:00:00.000Z",
      lineItems: [{ type: "payment", grossValueInCents: 5000, grossFeeValueInCents: 175, referenceId: CONTRIBUTION.id }],
    };
    queue(
      { body: { data: [deposit], totalCount: 1 } },
      { body: { data: deposit } },
      {
        body: {
          data: {
            contributions: { count: 30, grossInCents: 130000, feesInCents: 5000, totalInCents: 125000 },
            refunds: {},
            chargebacks: { count: 0 },
            adjustments: { count: 0, grossInCents: 0, feesInCents: 0, totalInCents: 0 },
          },
        },
      },
    );
    const listed = await call(connection(), "list_deposits", {
      types: ["AUTOMATED"],
      reconciled: false,
      minimumAmountInCents: 1000,
    });
    expect(url(0).searchParams.getAll("types[]")).toEqual(["AUTOMATED"]);
    expect(url(0).searchParams.get("reconciled")).toBe("false");
    expect(url(0).searchParams.get("minimumEstimatedValueInCents")).toBe("1000");
    expect(listed.deposits[0].lineItems).toBeUndefined();
    expect(listed.deposits[0].reconciledAt).toBeNull();
    expect(listed.deposits[0].paymentMethodTypes).toEqual(["card", "ach"]);

    const one = await call(connection(), "get_deposit", { depositId: deposit.id });
    expect(one.lineItems).toEqual([{ type: "payment", grossValueInCents: 5000, grossFeeValueInCents: 175, referenceId: CONTRIBUTION.id }]);

    const summary = await call(connection(), "get_deposit_summary", { depositId: deposit.id });
    expect(url(2).pathname).toBe(`/api/v3/deposits/${deposit.id}/summary`);
    expect(summary.contributions.totalInCents).toBe(125000);
    expect(summary.refunds).toEqual({ count: 0, grossInCents: 0, feesInCents: 0, totalInCents: 0 });
    expect(summary.depositId).toBe(deposit.id);
  });

  it("keeps phone and address out of donor lists but returns them from get_donor", async () => {
    const donor = CONTRIBUTION.donor;
    queue({ body: { data: [donor], totalCount: 1 } }, { body: { data: donor } });
    const listed = await call(connection(), "list_donors", { sortBy: "totalContributionsCount", sortDirection: "DESC" });
    expect(listed.donors[0]).toEqual({
      id: donor.id, firstName: "Jane", lastName: "Doe", email: donor.email, totalContributionsCount: 12,
    });
    expect(url(0).searchParams.get("sortBy")).toBe("totalContributionsCount");
    const full = await call(connection(), "get_donor", { donorId: donor.id });
    expect(full.phone).toBe(donor.phone);
    expect(full.address).toEqual(donor.address);
  });

  it("routes recurring gifts to the donor path when donorId is given", async () => {
    const subscription = {
      id: "5510f34fd5061afeec3eab11",
      donorId: CONTRIBUTION.donor.id,
      status: "active",
      amount: 2500,
      frequency: "monthly",
      startDate: "2025-01-01",
      nextPaymentDate: "2025-02-01",
      anonymous: false,
      paymentMethod: { id: "pm1", holderName: "Jane Doe", type: "card", last4: "4242", expiration: "12/30" },
      campaign: null,
      subcampaign: null,
      createdAt: "2025-01-01",
      updatedAt: "2025-01-01",
    };
    queue({ body: { data: [subscription], totalCount: 1 } }, { body: { data: [], totalCount: 0 } });
    const result = await call(connection(), "list_subscriptions", {
      donorId: CONTRIBUTION.donor.id,
      status: ["active", "paused"],
    });
    expect(url(0).pathname).toBe(`/api/v3/subscriptions/${CONTRIBUTION.donor.id}`);
    expect(url(0).searchParams.getAll("status[]")).toEqual(["active", "paused"]);
    expect(result.subscriptions[0].paymentMethod).toEqual({ id: "pm1", type: "card", last4: "4242", expiration: "12/30" });
    await call(connection(), "list_subscriptions");
    expect(url(1).pathname).toBe("/api/v3/subscriptions");
  });

  it("lists payment methods without holder names, unpaginated", async () => {
    queue({ body: { data: [{ id: "pm1", holderName: "Jane Doe", last4: "4242", type: "card", isExpired: false, updatedAt: "2025-01-01" }] } });
    const result = await call(connection(), "list_payment_methods", { donorId: CONTRIBUTION.donor.id, showExpired: true });
    expect(url().pathname).toBe(`/api/v3/payment-methods/${CONTRIBUTION.donor.id}`);
    expect(url().searchParams.get("showExpired")).toBe("true");
    expect(result).toEqual({ paymentMethods: [{ id: "pm1", type: "card", last4: "4242", isExpired: false, updatedAt: "2025-01-01" }] });
  });

  it("asks for subcampaigns when a parent campaign is named", async () => {
    queue({ body: { data: [], totalCount: 0 } }, { body: { data: [], totalCount: 0 } });
    await call(connection(), "list_campaigns", { parentCampaignId: "7710f34fd5061afeec3eab78" });
    expect(url(0).searchParams.get("isSubcampaign")).toBe("true");
    await call(connection(), "list_campaigns", { isSubcampaign: false });
    expect(url(1).searchParams.get("isSubcampaign")).toBe("false");
  });

  it("flattens tap events to the ids and names they touched", async () => {
    queue({
      body: {
        data: [{
          id: "t1", createdAt: "2026-05-01T10:00:00.000Z", deviceId: "d1", groupId: "g1", destinationId: "x1",
          device: { id: "d1", serialNumber: 12345 }, group: { id: "g1", name: "Sunday" },
          destination: { id: "x1", name: "Give", type: "web" },
        }],
        totalCount: 1,
      },
    });
    const result = await call(connection(), "list_tap_events", { groupIds: ["6710f34fd5061afeec3eab58"] });
    expect(url().pathname).toBe("/api/v3/tap/events");
    expect(url().searchParams.getAll("groupIds[]")).toEqual(["6710f34fd5061afeec3eab58"]);
    expect(result.events[0]).toEqual({
      id: "t1", createdAt: "2026-05-01T10:00:00.000Z", deviceId: "d1", deviceSerialNumber: 12345,
      groupId: "g1", groupName: "Sunday", destinationId: "x1", destinationName: "Give", destinationType: "web",
    });
  });

  it("pages webhook delivery logs by cursor and drops payloads unless raw", async () => {
    const attempt = {
      id: "a1", eventId: "e1", webhookEventName: "contribution.approved", subscriptionId: "w1",
      status: "failed", attemptNumber: 2, deliverySource: "automated",
      originatedAt: "2026-01-01T00:00:00.000Z", attemptedAt: "2026-01-01T00:00:05.000Z",
      request: { url: "https://hooks.example/overflow", body: '{"donor":{"email":"jane.doe@example.com"}}' },
      response: { code: 500, body: "boom", durationMs: 120, errorMessage: "Internal Server Error" },
    };
    queue(
      { body: { data: [attempt], pageInfo: { hasNextPage: true, nextCursor: "c2" } } },
      { body: { data: [attempt], pageInfo: { hasNextPage: false, nextCursor: null } } },
    );
    const webhookId = "6710f34fd5061afeec3eab99";
    const first = await call(connection(), "list_webhook_event_logs", { webhookId, status: "failed" });
    expect(url(0).pathname).toBe(`/api/v3/webhooks/${webhookId}/event-logs`);
    expect(url(0).searchParams.get("limit")).toBe("25");
    expect(url(0).searchParams.has("page")).toBe(false);
    expect(first.nextCursor).toBe("c2");
    expect(first.page).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain("jane.doe@example.com");
    expect(first.attempts[0]).toMatchObject({ status: "failed", responseCode: 500, errorMessage: "Internal Server Error", url: "https://hooks.example/overflow" });
    const second = await call(connection(), "list_webhook_event_logs", { webhookId, cursor: "c2", raw: true });
    expect(url(1).searchParams.get("cursor")).toBe("c2");
    expect(second.nextCursor).toBeUndefined();
    expect(second.attempts[0].request.body).toContain("jane.doe");
    expect((await failure(call(connection(), "list_webhook_event_logs", { webhookId, limit: 51 }))).code).toBe("invalid_args");
  });

  it("fails a successful named read that is not JSON", async () => {
    queue({ text: "<html>maintenance</html>" });
    const error = await failure(call(connection(), "list_locations"));
    expect(error.code).toBe("connector_call_failed");
    expect(error.retryable).toBe(false);
  });
});

describe("overflow() hatches", () => {
  it("GETs any provider-relative path with repeated query pairs and returns text untouched", async () => {
    queue({ body: { data: { id: "r1" } } }, { text: "ok" });
    const refund = await call(connection(), "overflow_api_get", {
      path: "/refunds/r1",
      query: [
        { name: "statusBucket[]", value: "PENDING" },
        { name: "statusBucket[]", value: "FAILED" },
        { name: "limit", value: 5 },
      ],
    });
    expect(refund).toEqual({ result: { data: { id: "r1" } } });
    expect(url(0).pathname).toBe("/api/v3/refunds/r1");
    expect(url(0).searchParams.getAll("statusBucket[]")).toEqual(["PENDING", "FAILED"]);
    expect(url(0).searchParams.get("limit")).toBe("5");
    expect(await call(connection(), "overflow_api_get", { path: "/health" })).toEqual({ result: "ok" });
  });

  it("confines hatch paths below /api/v3", async () => {
    for (const path of ["https://evil.example/x", "/../docs/openapi.json", "/donors?x=1", "donors"]) {
      const error = await failure(call(connection(), "overflow_api_get", { path }));
      expect(error.code, path).toBe("invalid_args");
    }
    expect(calls).toHaveLength(0);
  });

  it("sends a mutation body, including on DELETE, and returns null for an empty answer", async () => {
    queue({ status: 200, text: "" });
    const result = await call(connection(), "overflow_api_mutate", {
      method: "DELETE",
      path: "/subscriptions/d1/s1",
      body: { cancellationReason: "Donor request" },
    });
    expect(result).toEqual({ result: null });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.body).toEqual({ cancellationReason: "Donor request" });
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("refuses a method the hatch does not offer", async () => {
    expect((await failure(call(connection(), "overflow_api_mutate", { method: "GET", path: "/donors" }))).code).toBe("invalid_args");
    expect((await failure(call(connection(), "overflow_api_mutate", { method: "PUT", path: "/donors" }))).code).toBe("invalid_args");
  });
});

describe("overflow() failures map to the caller's next move", () => {
  it("waits out a 429 for Overflow's reported window remainder", async () => {
    queue({ status: 429, body: { message: "ThrottlerException: Too Many Requests" }, headers: { "x-ratelimit-reset": "37" } });
    const error = await failure(call(connection(), "list_locations"));
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(37_000);
    expect(error.message).toContain("120 requests per minute");
  });

  it("falls back to the whole documented window when a 429 carries no reset", async () => {
    queue({ status: 429, body: {} });
    expect((await failure(call(connection(), "list_locations"))).retryAfterMs).toBe(60_000);
  });

  it("treats 401 and 403 on a read as a credential problem", async () => {
    queue({ status: 401, body: { message: "Unauthorized" } }, { status: 403, body: { error: "Forbidden resource" } });
    for (let index = 0; index < 2; index += 1) {
      const error = await failure(call(connection(), "list_locations"));
      expect(error.code).toBe("auth_required");
      expect(error.retryable).toBe(false);
      expect(error.message).toContain("not interchangeable");
      expect(error.message).not.toContain("donor account");
    }
  });

  it("states the 403 ambiguity on a write", async () => {
    queue({ status: 403, body: { message: "This Donor Profile is associated to a Donor and cannot be updated." } });
    const error = await failure(call(connection(), "overflow_api_mutate", {
      method: "PATCH", path: "/donors/d1", body: { phone: "+15555550100" },
    }));
    expect(error.code).toBe("auth_required");
    expect(error.message).toContain("donor account cannot be edited");
  });

  it("maps 404 to not_found and 400 to invalid_args", async () => {
    queue({ status: 404, body: { message: "Contribution not found" } }, { status: 400, body: { message: ["limit must not be greater than 100"] } });
    const missing = await failure(call(connection(), "get_contribution", { contributionId: CONTRIBUTION.id }));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toContain("Contribution not found");
    const invalid = await failure(call(connection(), "overflow_api_get", { path: "/contributions" }));
    expect(invalid.code).toBe("invalid_args");
    expect(invalid.message).toContain("limit must not be greater than 100");
  });

  it("marks 409 and 422 refusals as final", async () => {
    queue({ status: 409, body: { message: "Refunds not supported for this processing gateway." } }, { status: 422, body: {} });
    for (let index = 0; index < 2; index += 1) {
      const error = await failure(call(connection(), "overflow_api_mutate", { method: "POST", path: "/contributions/c1/initiate-refund" }));
      expect(error.code).toBe("connector_call_failed");
      expect(error.retryable).toBe(false);
    }
  });

  it("retries a failing read but never a failing write", async () => {
    queue({ status: 503, text: "<html>bad gateway</html>" }, { status: 500, body: { message: "Failed to validate campaign." } });
    const read = await failure(call(connection(), "list_locations"));
    expect(read.code).toBe("unavailable");
    expect(read.retryable).toBe(true);
    const write = await failure(call(connection(), "overflow_api_mutate", {
      method: "POST", path: "/contributions", body: { donorId: "d1", paymentMethodId: "pm1", amount: 5000 },
    }));
    expect(write.code).toBe("connector_call_failed");
    expect(write.retryable).toBe(false);
    expect(write.message).toContain("may or may not have taken effect");
  });
});
