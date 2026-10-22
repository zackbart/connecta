// The Tithe.ly giving connection is hand-written fetch. Request shapes,
// projections, and status mapping live in the characterization goldens; these
// tests pin the environment choice, key-pair admission, the hatch confinement,
// the bank and legal boundary, and the vendor shapes that once parsed wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { TITHELY_API_BASE_URLS, tithely } from "./index.js";
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

function context(values: Record<string, string> | null = KEYS): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    credential: {
      get: async (field?: string) => (field ? (values?.[field] ?? null) : null),
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
  it("requires an explicit live or test environment (H1)", () => {
    expect(() => tithely("giving", { purpose: "reports" } as Parameters<typeof tithely>[1])).toThrow(
      'environment: "live"',
    );
    expect(() => tithely("giving", { purpose: "reports", environment: "sandbox" as "live" })).toThrow(
      'environment: "live"',
    );
  });
});

describe("transport and authentication", () => {
  it("sends HTTP Basic with the public key as user to the test environment", async () => {
    queue({ body: { status: "success", type: "List", data: [] } });
    await call(connection({ environment: "test" }), "list_organizations");
    expect(url().origin + url().pathname).toBe(`${TITHELY_API_BASE_URLS.test}/organizations-list`);
    expect(calls[0]!.headers["authorization"]).toBe(`Basic ${btoa("pub_abc123:pri_def456")}`);
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
    await expect(call(connection(), "tithely_api_get", { path: "/../v2/transactions" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(call(connection(), "tithely_api_get", { path: "https://evil.example/x" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("testCredentials (H12)", () => {
  it("refuses a mismatched pair without touching the network", async () => {
    const connector = connection();
    for (const values of [
      { publicKey: "pri_a", privateKey: "pub_b" },
      { publicKey: "pub_a", privateKey: "" },
      { publicKey: "pub a", privateKey: "pri_b" },
    ]) {
      const result = await connector.testCredentials!(values, context());
      expect(result.ok, JSON.stringify(values)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("named reads (H9, H10)", () => {
  it("INV-4: raw rows and hatch replies drop bank and legal details unless deployment code returns them", async () => {
    const organization = { status: "success", organization_id: "org_1", type: "Organization", object: ORGANIZATION };
    const reads: Array<[string, Record<string, unknown>, StubResponse]> = [
      ["get_organization", { organizationId: "org_1", raw: true }, { body: organization }],
      ["list_organizations", { raw: true }, { body: { status: "success", type: "List", data: [ORGANIZATION] } }],
      ["get_charge", { chargeId: "ch_1", raw: true }, { body: { status: "success", object: FULL_CHARGE } }],
      ["tithely_api_get", { path: "/organizations/org_1" }, { body: organization }],
    ];
    for (const [tool, args, response] of reads) {
      queue(response);
      const text = JSON.stringify(await call(connection(), tool, args));
      for (const secret of ["6789", "TEST BANK", "1985", "Rogers", '"bank"', '"legal"']) {
        expect(text, `${tool} ${secret}`).not.toContain(secret);
      }
      // An argument cannot widen it; only the deployment's option can.
      queue(response);
      expect(JSON.stringify(await call(connection({ sensitiveFields: "return" }), tool, args))).toContain("6789");
    }
    queue({ body: { status: "success", object: ORGANIZATION } });
    const written = await call(connection(), "tithely_api_mutate", { method: "POST", path: "/organizations/org_1" });
    expect(JSON.stringify(written)).not.toContain("6789");
    expect(() => connection({ sensitiveFields: "raw" })).toThrow(/sensitiveFields/);
  });

  it("falls back to fund names when giving_types_full is absent", async () => {
    const { giving_types_full: _omit, ...older } = ORGANIZATION;
    queue({ body: { status: "success", type: "List", data: [older] } });
    const result = await call(connection(), "list_organizations");
    expect(result.organizations[0].funds).toEqual([{ name: "Tithe" }, { name: "Missions" }, { name: "Building" }]);
  });

  it("pages past the last kept id and ends on a short page", async () => {
    const row = { charge_id: "ch_3", charge_status: "charged", amount: "2700", organization: "org_1" };
    queue({ body: { status: "success", type: "List", data: [row] } });
    const last = await call(connection(), "list_charges", {
      organizationId: "org_1",
      limit: 2,
      cursor: "ch_2",
      order: "asc",
    });
    expect(url().searchParams.get("starting_after")).toBe("ch_2");
    expect(url().searchParams.get("limit")).toBe("3");
    expect(url().searchParams.get("order_by")).toBe("ASC");
    expect(last.page).toEqual({ hasMore: false, nextCursor: null });
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

  it("accepts the reference's bare charge object too", async () => {
    queue({ body: { ...FULL_CHARGE, deposit_date: "1497838090" } });
    const charge = await call(connection(), "get_charge", { chargeId: "ch_7" });
    expect(charge.depositedAt).toBe("2017-06-19T02:08:10.000Z");
    expect(charge.amountCents).toBe(2500);
  });

  it("fails a 200 that reports status fail in-band", async () => {
    queue({ body: { status: "fail", reason: "There was a problem using that payment method." } });
    const error = (await call(connection(), "get_charge", { chargeId: "ch_1" }).catch(
      (caught: unknown) => caught,
    )) as ConnectorCallError;
    expect(error).toBeInstanceOf(ConnectorCallError);
    expect(error).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(error.message).toContain("There was a problem using that payment method.");
  });
});
