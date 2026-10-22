// The Tithe.ly giving connection is hand-written fetch. Request shapes,
// projections, and status mapping live in the characterization goldens; these
// tests pin the environment choice, key-pair admission, the hatch confinement,
// the bank and legal boundary, and the vendor shapes that once parsed wrong.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { tithely } from "./index.js";
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
