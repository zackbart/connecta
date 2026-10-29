// Tithe.ly fixture regressions cover key-pair admission, credential probes,
// connection modes, the bank/legal privacy boundary and vendor response shapes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorCallError } from "../../errors.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
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
  // listen() from the Node entry owns the write transport; here it is the stubbed fetch.
  installOwnedTransport();
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

function context(values: Record<string, string> | null = KEYS, signal?: AbortSignal): ConnectorContext {
  return {
    storage: memoryStorage(),
    logger: silentLogger,
    baseUrl: "https://connecta.example",
    ...(signal ? { signal } : {}),
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
  it("INV-4: named reads and hatch replies drop bank and legal details unless deployment code returns them", async () => {
    const organization = { status: "success", organization_id: "org_1", type: "Organization", object: ORGANIZATION };
    const reads: Array<[string, Record<string, unknown>, StubResponse, boolean]> = [
      ["list_organizations", {}, { body: { status: "success", type: "List", data: [ORGANIZATION] } }, false],
      ["get_charge", { chargeId: "ch_1" }, { body: { status: "success", object: FULL_CHARGE } }, false],
      ["tithely_api_read", { path: "/organizations/org_1" }, { body: organization }, true],
      [
        "tithely_api_write",
        { method: "POST", path: "/accounts/user_jane", body: { first_name: "Jane" } },
        { body: organization },
        true,
      ],
    ];
    for (const [tool, args, response, hatch] of reads) {
      queue(response);
      const text = JSON.stringify(await call(connection(), tool, args));
      for (const secret of ["6789", "TEST BANK", "1985", "Rogers", '"bank"', '"legal"']) {
        expect(text, `${tool} ${secret}`).not.toContain(secret);
      }
      // Only the deployment's option widens the hatch; the named projections never carry them.
      queue(response);
      const returned = JSON.stringify(await call(connection({ sensitiveFields: "return" }), tool, args));
      expect(returned.includes("6789"), tool).toBe(hatch);
    }
    // No argument widens it, and fields can only narrow: both are refused before any request.
    calls.length = 0;
    for (const [tool, args] of [
      ["list_organizations", { raw: true }],
      ["get_charge", { chargeId: "ch_1", fields: ["bank"] }],
      ["list_charges", { organizationId: "org_1", fields: ["legal.date_of_birth"] }],
      // A hatch write never leaves with a root no declared charge answer has.
      ["tithely_api_write", { method: "POST", path: "/refunds/ch_1", fields: ["nope"] }],
    ] as const) {
      await expect(call(connection({ sensitiveFields: "return" }), tool, args), tool).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
    // Charge answers arrive bare (as the reference documents) or enveloped; fields selects either.
    const { organization: _organization, ...bare } = FULL_CHARGE;
    for (const [tool, args, body, data] of [
      [
        "tithely_api_read",
        { path: "/charges/ch_1", fields: ["amount", "donor_account.email"] },
        bare,
        { amount: "2500", donor_account: { email: "jane@example.com" } },
      ],
      [
        "tithely_api_read",
        { path: "/charges/ch_1", fields: ["object.amount"] },
        { status: "success", charge_id: "ch_1", type: "Charge", object: bare },
        { object: { amount: "2500" } },
      ],
      [
        "tithely_api_write",
        { method: "POST", path: "/refunds/ch_1", fields: ["charge_status"] },
        { ...bare, charge_status: "refunded" },
        { charge_status: "refunded" },
      ],
    ] as const) {
      queue({ body });
      expect(await call(connection(), tool, args), tool).toEqual({ status: 200, data });
    }
    expect(() => connection({ sensitiveFields: "raw" })).toThrow(/sensitiveFields/);
    // Details advertises the deployment's choice: dropped names are withheld, never listed as readable.
    calls.length = 0;
    const response = async (options: Record<string, unknown> = {}) =>
      ((await call(connection(options), "tithely_api_details", { method: "GET", path: "/organizations/org_1" })) as any)
        .response;
    const dropped = await response();
    expect(dropped.withheld).toEqual(expect.arrayContaining(["object.bank", "object.legal"]));
    expect(dropped.fields.some((path: string) => /^object\.(bank|legal)\b/.test(path))).toBe(false);
    const returned = await response({ sensitiveFields: "return" });
    expect(returned.fields).toEqual(expect.arrayContaining(["object.bank", "object.legal"]));
    expect(calls).toEqual([]);
  });

  it("falls back to fund names when giving_types_full is absent", async () => {
    const { giving_types_full: _omit, ...older } = ORGANIZATION;
    queue({ body: { status: "success", type: "List", data: [older] } });
    const result = await call(connection(), "list_organizations");
    expect(result.items[0].funds).toEqual([{ name: "Tithe" }, { name: "Missions" }, { name: "Building" }]);
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

describe("keys and writes", () => {
  it("INV-5: refuses a missing or swapped key pair before any request leaves", async () => {
    for (const values of [null, { publicKey: "pri_x", privateKey: "pub_y" }]) {
      const error = await call(connection(), "get_charge", { chargeId: "ch_1" }, context(values)).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: "auth_required" });
      expect(calls).toEqual([]);
    }
  });

  it("INV-7 INV-9: a caller who leaves while a write's 401 is still being read gets its auth code and unknown outcome", async () => {
    const controller = new AbortController();
    let reading!: () => void;
    const reached = new Promise<void>((resolve) => (reading = resolve));
    globalThis.fetch = vi.fn(
      async () =>
        // The status is in; the body is pulled only once read, and never finishes.
        new Response(new ReadableStream({ pull: () => (reading(), new Promise(() => {})) }, { highWaterMark: 0 }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;
    const pending = call(
      connection(),
      "tithely_api_write",
      { method: "POST", path: "/refunds/ch_1" },
      context(KEYS, controller.signal),
    ).catch((caught: unknown) => caught);
    await reached;
    controller.abort(new Error("caller left"));
    const error = await pending;
    expect(error).toMatchObject({ code: "auth_required", retryable: false, writeOutcome: "unknown" });
    expect((error as Error).message).toContain("whether it took effect is unknown");
  });
});

describe("connection modes", () => {
  it("INV-5: the probe tests the candidate keys, refusing a missing, swapped or empty pair before any request", async () => {
    const stored = context({ publicKey: "pub_stored", privateKey: "pri_stored" });
    stored.credential!.getAll = vi.fn(stored.credential!.getAll);
    for (const [values, message] of [
      [{}, "Both the Tithe.ly public key and private key are required."],
      [{ publicKey: " ", privateKey: "pri_def456" }, "Both the Tithe.ly public key and private key are required."],
      [
        { publicKey: "pri_def456", privateKey: "pub_abc123" },
        "The Tithe.ly keys are swapped: the pub_ key belongs in the public-key field and the pri_ key in the private-key field.",
      ],
    ] as const) {
      expect(await connection().testCredentials!(values, stored)).toEqual({ ok: false, message });
    }
    expect(calls).toEqual([]);
    for (const [environment, host] of [
      ["live", "tithe.ly"],
      ["test", "tithelydev.com"],
    ] as const) {
      calls.length = 0;
      queue({ body: { status: "success", type: "List", data: [ORGANIZATION] } });
      expect(await connection({ environment }).testCredentials!(KEYS, stored)).toEqual({
        ok: true,
        message: `Keys accepted by Tithe.ly (${environment}); first organization reached: Grace Church (org_1).`,
      });
      expect(calls).toEqual([
        {
          url: `https://${host}/api/v1/organizations-list?limit=1`,
          method: "GET",
          headers: { accept: "application/json", authorization: `Basic ${btoa("pub_abc123:pri_def456")}` },
          body: undefined,
        },
      ]);
    }
    expect(stored.credential!.getAll).not.toHaveBeenCalled();
  });
});
