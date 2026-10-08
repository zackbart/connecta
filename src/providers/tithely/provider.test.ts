// The Tithe.ly giving connection is hand-written fetch. Tests stub the network
// and pin the requests, projections, credential handling, and typed failures
// connecta owns — H1, H9, H10, H11, and H12 for this provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { TITHELY_API_BASE_URLS, tithely } from "./index.js";
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
  body: string | undefined;
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
    const text = next.text ?? JSON.stringify(next.body ?? { status: "success" });
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return new Response(text, {
      status: next.status ?? 200,
      ...(next.headers ? { headers: next.headers } : {}),
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const KEYS = { publicKey: "pub_abc123", privateKey: "pri_def456" };

function context(
  values: Record<string, string> | null = KEYS,
): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async (field?: string) => (field ? values?.[field] ?? null : null),
      getAll: async () => values,
    },
  };
}

function connection(overrides: Record<string, unknown> = {}): Connector {
  return tithely("giving", {
    purpose: "Weekly giving reports for Grace Church",
    environment: "live",
    ...overrides,
  } as Parameters<typeof tithely>[1]);
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

const ORGANIZATION = {
  organization_id: "org_1",
  widget_id: "999",
  account_id: "user_owner",
  created_date: "1493928837",
  name: "Grace Church",
  phone_number: "5551231234",
  website: "https://grace.example",
  address: { street_address: "1 Main St", city: "Nashville", state: "TN", postal: "37209", country: "US" },
  giving_types: ["Tithe", "Missions", "Building"],
  giving_types_full: [
    { id: "10", name: "Tithe", status: "1" },
    { id: "11", name: "Missions", status: "2" },
    { id: "12", name: "Building", status: "0" },
  ],
  bank: { account_number_last4: "6789", name: "TEST BANK", country: "US", currency: "USD" },
  legal: { entity_type: "organization", first_name: "Mike", last_name: "Rogers", date_of_birth: "5/23/1985" },
};

const FULL_CHARGE = {
  charge_status: "charged",
  amount: "2500",
  net_amount: "2397",
  fees: "103",
  currency: "USD",
  giving_type: "Tithe",
  charge_date: "1497638090",
  deposit_date: "pending",
  recurring_transaction: false,
  fees_covered: true,
  organization: { ...ORGANIZATION },
  donor_account: {
    account_id: "user_jane",
    email: "jane@example.com",
    first_name: "Jane",
    last_name: "Doe",
    phone_number: "5555551234",
    address: { street_address: "2 Elm", city: "Nashville", state: "TN", postal: "37209", country: "US" },
  },
  payment_method: { pm_id: "pm_9", last_4_digits: "4242", brand: "Visa", pm_type: "card", account_id: "user_jane" },
};

describe("tithely() construction", () => {
  it("rejects a blank purpose, a missing environment, and invalid page sizes (H1, P4)", () => {
    expect(() => tithely("giving", { purpose: "  ", environment: "live" })).toThrow(
      "a non-empty purpose",
    );
    expect(() =>
      tithely("giving", { purpose: "reports" } as Parameters<typeof tithely>[1]),
    ).toThrow('environment: "live"');
    expect(() =>
      tithely("giving", { purpose: "reports", environment: "sandbox" as "live" }),
    ).toThrow('environment: "live"');
    expect(() =>
      tithely("giving", { purpose: "reports", environment: "test", defaultPageSize: 100 }),
    ).toThrow("between 1 and 99");
  });

  it("names the environment in the title, description, and guide's first line (P3)", () => {
    const live = connection();
    const test = connection({ environment: "test" });
    expect(live.title).toBe("Tithe.ly Giving");
    expect(test.title).toBe("Tithe.ly Giving (test)");
    expect(live.description).toContain("live donors and real money");
    expect(test.description).toContain("no real money");
    const firstLine = (connector: Connector) =>
      guide(connector).content.split("\n").filter((line) => line.trim() && !line.startsWith("#"))[0];
    expect(firstLine(live)).toContain("Live Tithe.ly (tithe.ly)");
    expect(firstLine(test)).toContain("Test Tithe.ly (tithelydev.com)");
    expect(guide(live).summary).toMatch(/^Live giving/);
    expect(guide(test).summary).toMatch(/^Test giving/);
  });

  it("appends instructions, keeps the purpose, and declares no default admission (H1, P12)", () => {
    const connector = connection({ instructions: "Funds named Benevolence are confidential." });
    const content = guide(connector).content;
    expect(content).toContain("Weekly giving reports for Grace Church");
    expect(content).toContain("## Account instructions\n\nFunds named Benevolence are confidential.");
    expect(content).toContain("publishes no rate limit");
    expect(connector.callAdmission).toBeUndefined();
    const budget = { rules: [{ budget: { kind: "rolling-window" as const, maxCalls: 60, windowMs: 60_000 } }] };
    expect(connection({ callAdmission: budget }).callAdmission).toEqual(budget);
  });

  it("declares a two-field key-pair credential naming the request-only access (H12)", () => {
    const connector = connection();
    expect(connector.credential?.fields?.map((field) => field.name)).toEqual(["publicKey", "privateKey"]);
    expect(connector.credential?.description).toContain("support@tithe.ly");
    expect(connector.testCredentials).toBeInstanceOf(Function);
  });

  it("splits reads from the always-destructive mutate hatch and names no money-moving tool", async () => {
    const tools = await connection().listTools(context());
    const writes = tools.filter((tool) => !isExplicitlyReadOnly(tool));
    expect(writes.map((tool) => tool.name)).toEqual(["tithely_api_mutate"]);
    expect(writes[0]!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((tool) => tool.name === "tithely_api_get")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.some((tool) => tool.name === "tithely_api_upload")).toBe(false);
  });
});

describe("transport and authentication", () => {
  it("sends HTTP Basic with the public key as user to the selected environment", async () => {
    queue({ body: { status: "success", type: "List", data: [] } });
    await call(connection({ environment: "test" }), "list_organizations");
    expect(url().origin + url().pathname).toBe(`${TITHELY_API_BASE_URLS.test}/organizations-list`);
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("pub_abc123:pri_def456")}`);

    queue({ body: { status: "success", type: "List", data: [] } });
    await call(connection(), "list_organizations");
    expect(url(1).origin + url(1).pathname).toBe("https://tithe.ly/api/v1/organizations-list");
  });

  it("fails auth_required without a request when keys are missing or obviously swapped", async () => {
    await expect(call(connection(), "list_organizations", {}, context(null))).rejects.toMatchObject({
      code: "auth_required",
    });
    await expect(
      call(connection(), "list_organizations", {}, context({ publicKey: "pri_x", privateKey: "pub_y" })),
    ).rejects.toThrow("swapped");
    await expect(
      call(connection(), "list_organizations", {}, context({ publicKey: "pri_x", privateKey: "pri_y" })),
    ).rejects.toMatchObject({ code: "auth_required" });
    expect(calls).toHaveLength(0);
  });

  it("confines hatch paths below /api/v1, so the undocumented v2 is unreachable", async () => {
    await expect(
      call(connection(), "tithely_api_get", { path: "/../v2/transactions" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "tithely_api_get", { path: "https://evil.example/x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });
});

describe("testCredentials (H12)", () => {
  it("refuses a mismatched pair without touching the network", async () => {
    const connector = connection();
    for (const values of [
      { publicKey: "pri_a", privateKey: "pub_b" },
      { publicKey: "pri_a", privateKey: "pri_b" },
      { publicKey: "pub_a", privateKey: "pub_b" },
      { publicKey: "pub_a", privateKey: "" },
      { publicKey: "pub a", privateKey: "pri_b" },
    ]) {
      const result = await connector.testCredentials!(values, context());
      expect(result.ok, JSON.stringify(values)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("makes one cheap read and reports the organization reached", async () => {
    queue({ body: { status: "success", type: "List", data: [ORGANIZATION] } });
    const result = await connection({ environment: "test" }).testCredentials!(KEYS, context(null));
    expect(result).toEqual({
      ok: true,
      message: "Keys accepted by Tithe.ly (test); first organization reached: Grace Church (org_1).",
    });
    expect(calls).toHaveLength(1);
    expect(url().pathname).toBe("/api/v1/organizations-list");
    expect(url().searchParams.get("limit")).toBe("1");
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("pub_abc123:pri_def456")}`);
  });

  it("reports a rejected pair as not ok", async () => {
    queue({ status: 401, body: { status: "fail", reason: "Invalid API keys" } });
    const result = await connection().testCredentials!(KEYS, context());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("other environment");
  });
});

describe("named reads (H9, H10)", () => {
  it("projects organizations to funds and drops bank and legal details unless raw", async () => {
    queue({ body: { status: "success", organization_id: "org_1", type: "Organization", object: { ...ORGANIZATION, organization_id: undefined } } });
    const lean = await call(connection(), "get_organization", { organizationId: "org_1" });
    expect(url().pathname).toBe("/api/v1/organizations/org_1");
    expect(lean).toEqual({
      organizationId: "org_1",
      name: "Grace Church",
      ownerAccountId: "user_owner",
      website: "https://grace.example",
      phoneNumber: "5551231234",
      address: { streetAddress: "1 Main St", city: "Nashville", state: "TN", postal: "37209", country: "US" },
      payoutCurrency: "USD",
      createdAt: "2017-05-04T20:13:57.000Z",
      funds: [
        { id: "10", name: "Tithe", status: "active" },
        { id: "11", name: "Missions", status: "hidden" },
        { id: "12", name: "Building", status: "archived" },
      ],
    });
    expect(JSON.stringify(lean)).not.toContain("6789");
    expect(JSON.stringify(lean)).not.toContain("1985");

    queue({ body: { status: "success", organization_id: "org_1", type: "Organization", object: ORGANIZATION } });
    const raw = await call(connection(), "get_organization", { organizationId: "org_1", raw: true });
    expect(raw.bank.account_number_last4).toBe("6789");
  });

  it("falls back to fund names when giving_types_full is absent", async () => {
    const { giving_types_full: _omit, ...older } = ORGANIZATION;
    queue({ body: { status: "success", type: "List", data: [older] } });
    const result = await call(connection(), "list_organizations");
    expect(result.organizations[0].funds).toEqual([{ name: "Tithe" }, { name: "Missions" }, { name: "Building" }]);
  });

  it("pages by asking for one extra row and passing the last kept id back", async () => {
    const rows = [1, 2, 3].map((n) => ({
      charge_id: `ch_${n}`,
      charge_status: "charged",
      amount: "2700",
      net_amount: "2591",
      fees: 109,
      currency: "USD",
      giving_type: "Tithe",
      charge_date: "1498665995",
      payment_method: "pm_1",
      organization: "org_1",
      donor_account: "user_1",
    }));
    queue({ body: { status: "success", type: "List", data: rows } });
    const first = await call(connection(), "list_charges", { organizationId: "org_1", limit: 2 });
    expect(Object.fromEntries(url().searchParams)).toEqual({
      organization_id: "org_1",
      limit: "3",
      order_by: "DESC",
    });
    expect(first.page).toEqual({ hasMore: true, nextCursor: "ch_2" });
    expect(first.charges).toHaveLength(2);
    expect(first.charges[0]).toEqual({
      chargeId: "ch_1",
      status: "charged",
      amountCents: 2700,
      netAmountCents: 2591,
      feesCents: 109,
      currency: "USD",
      fund: "Tithe",
      chargedAt: "2017-06-28T16:06:35.000Z",
      organizationId: "org_1",
      accountId: "user_1",
      paymentMethodId: "pm_1",
    });

    queue({ body: { status: "success", type: "List", data: rows.slice(2) } });
    const last = await call(connection(), "list_charges", {
      organizationId: "org_1",
      limit: 2,
      cursor: "ch_2",
      order: "asc",
    });
    expect(url(1).searchParams.get("starting_after")).toBe("ch_2");
    expect(url(1).searchParams.get("order_by")).toBe("ASC");
    expect(last.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("filters charges by created date from Unix seconds or ISO 8601", async () => {
    queue({ body: { status: "success", type: "List", data: [] } });
    await call(connection(), "list_charges", {
      accountId: "user_1",
      createdAfter: "2026-01-01",
      createdBefore: 1798761600,
    });
    expect(url().searchParams.get("account_id")).toBe("user_1");
    expect(url().searchParams.get("created_after")).toBe("1767225600");
    expect(url().searchParams.get("created_before")).toBe("1798761600");
    expect(url().searchParams.get("limit")).toBe("26");
  });

  it("reads an offsetless ISO date-time as UTC whatever the runtime's timezone", async () => {
    // Node re-reads TZ on change; workerd is UTC and has no process.env to set.
    const env = typeof process === "undefined" ? undefined : process.env;
    const previous = env?.["TZ"];
    if (env) env["TZ"] = "America/New_York";
    try {
      queue({ body: { status: "success", type: "List", data: [] } });
      await call(connection(), "list_charges", {
        organizationId: "org_1",
        createdAfter: "2026-01-01T00:00:00",
        createdBefore: "2026-01-01T05:30:00.250+05:30",
      });
      expect(url().searchParams.get("created_after")).toBe(String(Date.UTC(2026, 0, 1) / 1000));
      // An explicit offset is honored, not replaced.
      expect(url().searchParams.get("created_before")).toBe(String(Date.UTC(2026, 0, 1) / 1000));
    } finally {
      if (env) {
        if (previous === undefined) delete env["TZ"];
        else env["TZ"] = previous;
      }
    }
  });

  it("refuses calls that can only fail before any request", async () => {
    await expect(call(connection(), "list_charges", {})).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connection(), "list_recurring_charges", {})).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "list_charges", { organizationId: "org_1", createdAfter: "not a date" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "list_charges", { organizationId: "org_1", createdAfter: 200, createdBefore: 100 }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connection(), "list_charges", { organizationId: "org_1", limit: 100 })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(0);
  });

  it("unwraps a charge envelope and keeps the donor to name and email", async () => {
    queue({ body: { status: "success", charge_id: "ch_7", type: "Charge", object: FULL_CHARGE } });
    const charge = await call(connection(), "get_charge", { chargeId: "ch_7" });
    expect(url().pathname).toBe("/api/v1/charges/ch_7");
    expect(charge).toEqual({
      chargeId: "ch_7",
      status: "charged",
      amountCents: 2500,
      netAmountCents: 2397,
      feesCents: 103,
      currency: "USD",
      fund: "Tithe",
      chargedAt: "2017-06-16T18:34:50.000Z",
      depositedAt: "pending",
      recurring: false,
      feesCovered: true,
      organizationId: "org_1",
      organizationName: "Grace Church",
      accountId: "user_jane",
      donor: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      paymentMethodId: "pm_9",
      paymentMethod: { type: "card", brand: "Visa", last4: "4242" },
    });
    expect(JSON.stringify(charge)).not.toContain("6789");
    expect(JSON.stringify(charge)).not.toContain("2 Elm");
  });

  it("accepts the reference's bare charge object too", async () => {
    queue({ body: { ...FULL_CHARGE, deposit_date: "1497838090" } });
    const charge = await call(connection(), "get_charge", { chargeId: "ch_7" });
    expect(charge.depositedAt).toBe("2017-06-19T02:08:10.000Z");
    expect(charge.amountCents).toBe(2500);
  });

  it("lists recurring gifts by organization and projects one by id", async () => {
    const recurring = {
      recurring_id: "rc_1",
      amount: "1000",
      currency: "USD",
      giving_type: "Missions",
      start_date: "1497632472",
      term: "monthly",
      organization: ORGANIZATION,
      donor_account: FULL_CHARGE.donor_account,
    };
    queue({ body: { status: "success", type: "List", data: [recurring] } });
    const listed = await call(connection(), "list_recurring_charges", { organizationId: "org_1" });
    expect(url().pathname).toBe("/api/v1/recurring-list");
    expect(listed).toEqual({
      recurringCharges: [{
        recurringId: "rc_1",
        amountCents: 1000,
        currency: "USD",
        fund: "Missions",
        term: "monthly",
        startAt: "2017-06-16T17:01:12.000Z",
        organizationId: "org_1",
        organizationName: "Grace Church",
        accountId: "user_jane",
        donor: { firstName: "Jane", lastName: "Doe", email: "jane@example.com" },
      }],
      page: { hasMore: false, nextCursor: null },
    });

    const { recurring_id: _id, ...object } = recurring;
    queue({ body: { status: "success", recurring_id: "rc_1", type: "Recurring", object } });
    const single = await call(connection(), "get_recurring_charge", { recurringId: "rc_1" });
    expect(single.recurringId).toBe("rc_1");
    expect(url(1).pathname).toBe("/api/v1/recurring/rc_1");
  });

  it("reads donors from either account list and one donor in full", async () => {
    const account = {
      account_id: "user_1",
      created_date: "1487792831",
      email: "mike@example.com",
      first_name: "Mike",
      last_name: "Rogers",
      address: { street_address: "123 Test Ave", city: "Nashville", state: "TN", postal: "37209", country: "US" },
      phone_number: "5555551234",
    };
    queue({ body: { status: "success", type: "List", data: [account] } });
    const all = await call(connection(), "list_accounts");
    expect(url().pathname).toBe("/api/v1/accounts-list-all");
    expect(all.accounts).toEqual([{
      accountId: "user_1",
      firstName: "Mike",
      lastName: "Rogers",
      email: "mike@example.com",
      createdAt: "2017-02-22T19:47:11.000Z",
    }]);

    queue({ body: { status: "success", type: "List", data: [] } });
    await call(connection(), "list_accounts", { scope: "api" });
    expect(url(1).pathname).toBe("/api/v1/accounts-list");

    const { account_id: _id, created_date: _created, ...object } = account;
    queue({ body: { status: "success", account_id: "user_1", type: "Account", object } });
    const one = await call(connection(), "get_account", { accountId: "user_1" });
    expect(one).toEqual({
      accountId: "user_1",
      firstName: "Mike",
      lastName: "Rogers",
      email: "mike@example.com",
      phoneNumber: "5555551234",
      address: { streetAddress: "123 Test Ave", city: "Nashville", state: "TN", postal: "37209", country: "US" },
    });
  });

  it("lists a donor's payment methods as metadata in one unpaged response", async () => {
    queue({
      body: {
        status: "success",
        type: "List",
        data: [
          { pm_id: "pm_1", last_4_digits: "4242", brand: "Visa", pm_type: "card", account_id: "user_1" },
          { pm_id: "pm_2", last_4_digits: "6789", brand: "Test Bank", pm_type: "bank", account_id: "user_1" },
        ],
      },
    });
    const result = await call(connection(), "list_payment_methods", { accountId: "user_1" });
    expect(url().pathname).toBe("/api/v1/payment-methods-list");
    expect(url().searchParams.get("account_id")).toBe("user_1");
    expect(result).toEqual({
      paymentMethods: [
        { paymentMethodId: "pm_1", accountId: "user_1", type: "card", brand: "Visa", last4: "4242" },
        { paymentMethodId: "pm_2", accountId: "user_1", type: "bank", brand: "Test Bank", last4: "6789" },
      ],
    });
  });
});

describe("escape hatches (H14)", () => {
  it("returns any GET untouched", async () => {
    queue({ body: { status: "success", pm_id: "pm_1", type: "Payment Method", object: { brand: "Visa" } } });
    const result = await call(connection(), "tithely_api_get", {
      path: "/payment-methods/pm_1",
      query: [{ name: "account_id", value: "user_1" }],
    });
    expect(calls[0]!.method).toBe("GET");
    expect(url().pathname).toBe("/api/v1/payment-methods/pm_1");
    expect(url().searchParams.get("account_id")).toBe("user_1");
    expect(result.result.object.brand).toBe("Visa");
  });

  it("form-encodes a mutation the way Tithe.ly's examples send it", async () => {
    queue({ body: { status: "success", charge_id: "ch_new", type: "Charge", object: {} } });
    await call(connection(), "tithely_api_mutate", {
      method: "POST",
      path: "/charges",
      form: [
        { name: "account_id", value: "user_1" },
        { name: "pm_id", value: "pm_1" },
        { name: "organization_id", value: "org_1" },
        { name: "amount", value: 2555 },
        { name: "giving_type", value: "General Fund" },
      ],
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      account_id: "user_1",
      pm_id: "pm_1",
      organization_id: "org_1",
      amount: "2555",
      giving_type: "General Fund",
    });
  });

  it("sends a bodiless DELETE with its query", async () => {
    queue({ body: { status: "success", note: "Payment method removed." } });
    const result = await call(connection(), "tithely_api_mutate", {
      method: "DELETE",
      path: "/payment-methods/pm_1",
      query: [{ name: "account_id", value: "user_1" }],
    });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.body).toBeUndefined();
    expect(url().searchParams.get("account_id")).toBe("user_1");
    expect(result.result.note).toBe("Payment method removed.");
  });

  it("refuses a method outside POST and DELETE before any request", async () => {
    await expect(
      call(connection(), "tithely_api_mutate", { method: "PUT", path: "/charges" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });
});

describe("typed failures (H11)", () => {
  const cases: Array<{
    name: string;
    response: StubResponse;
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
    message?: string;
  }> = [
    { name: "401", response: { status: 401, body: { status: "fail", reason: "Bad keys" } }, code: "auth_required", retryable: false, message: "other environment" },
    { name: "403", response: { status: 403, body: {} }, code: "connector_call_failed", retryable: false, message: "does not say which" },
    { name: "404", response: { status: 404, text: "Not Found" }, code: "connector_call_failed", retryable: false, message: "does not distinguish" },
    { name: "400", response: { status: 400, body: { status: "fail", reason: "amount is required" } }, code: "invalid_args", retryable: false, message: "amount is required" },
    { name: "422", response: { status: 422, body: {} }, code: "invalid_args", retryable: false },
    { name: "429", response: { status: 429, body: {}, headers: { "Retry-After": "7" } }, code: "rate_limited", retryable: true, retryAfterMs: 7_000 },
    { name: "503", response: { status: 503, text: "<html>down</html>" }, code: "unavailable", retryable: true },
    { name: "418", response: { status: 418, body: {} }, code: "connector_call_failed", retryable: false },
    { name: "in-band fail", response: { body: { status: "fail", reason: "There was a problem using that payment method." } }, code: "connector_call_failed", retryable: false, message: "There was a problem using that payment method." },
    { name: "non-JSON success", response: { text: "<html>login</html>" }, code: "connector_call_failed", retryable: false, message: "not JSON" },
  ];

  it.each(cases)("maps $name", async ({ response, code, retryable, retryAfterMs, message }) => {
    queue(response);
    const error = await call(connection(), "get_charge", { chargeId: "ch_1" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ConnectorCallError);
    const typed = error as ConnectorCallError;
    expect(typed.code).toBe(code);
    expect(typed.retryable).toBe(retryable);
    if (retryAfterMs !== undefined) expect(typed.retryAfterMs).toBe(retryAfterMs);
    if (message) expect(typed.message).toContain(message);
  });

  it("never maps a 404 to not_found, because absence and reach are indistinguishable", async () => {
    queue({ status: 404, body: {} });
    await expect(call(connection(), "get_account", { accountId: "user_x" })).rejects.not.toMatchObject({
      code: "not_found",
    });
  });
});
