/**
 * A stateful fake of Tithe.ly's giving API v1, served on loopback and reached
 * through the provider's `baseUrl` test-double override. Envelopes, paging and
 * refusals follow Tithe.ly's reference: lists answer `{status, type, data}`,
 * single records `{status, <kind>_id, type, object}`, writes are form-encoded,
 * paging is `starting_after`/`ending_before` by id with `limit` (default 10,
 * at most 100) and no `has_more`, and most refusals are HTTP 200
 * `{status: "fail", reason}`. Every record is deterministic, so graders can
 * compute their expected answers from a fresh seed.
 */
import { serveFetch, type Served } from "../support/serve.js";
import type { CallRecord, Ledger } from "./service.js";

type Row = Record<string, any>;

const TITHELY_KEYS = { publicKey: "pub_eval_giving", privateKey: "pri_eval_giving_7d41c2" };
export const GRACE = "org_Gr8cE21fQx";
const HOPE = "org_H0peC9pLm2";
export const GRACE_WIDGET = "48213";
const JANE = "user_J4neD0e7rk";
export const BOB = "user_B0bSm1th4q";
export const BOB_WEEKLY = "rc_B0bWk1y9Tz";
export const BOB_HOPE = "rc_B0bH0pe3Lx";
export const DUP_FIRST = "ch_Dup1aQ8m2K";
export const DUP_SECOND = "ch_Dup2bW5n7R";
export const SEPT_START = Date.UTC(2026, 8, 1) / 1000;
export const OCT_START = Date.UTC(2026, 9, 1) / 1000;
export const NOV_START = Date.UTC(2026, 10, 1) / 1000;
export const DOMAIN = "gracechurch.example";

/** Base-62 ids like Tithe.ly's, from a fixed linear congruential sequence. */
function idFactory(seed: number) {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let state = seed;
  return (prefix: string) => {
    let id = "";
    for (let i = 0; i < 10; i++) {
      state = (state * 1103515245 + 12345) % 2147483648;
      id += alphabet[state % 62];
    }
    return `${prefix}_${id}`;
  };
}

const FIRST = ["Ava", "Liam", "Mia", "Noah", "Ella", "Owen", "Ruth", "Caleb", "Hannah", "Isaac", "Leah", "Micah"];
const LAST = ["Garcia", "Nguyen", "Okafor", "Patel", "Kim", "Rossi", "Silva", "Novak", "Haddad", "Brooks", "Ward"];
const DOMAINS = [DOMAIN, "example.com", "example.org", DOMAIN, "mail.example", "example.net", "example.com"];
const FUNDS = ["General Fund", "Missions", "Building Fund", "Youth"];

const bank = { account_number_last4: "6789", name: "TEST BANK", country: "US", currency: "USD" };
const legal = { entity_type: "organization", first_name: "Mike", last_name: "Rogers", date_of_birth: "5/23/1985" };

function organizations(): Row[] {
  return [
    {
      organization_id: GRACE,
      widget_id: GRACE_WIDGET,
      account_id: "user_0wn3rGr8c",
      created_date: String(Date.UTC(2019, 4, 4) / 1000),
      name: "Grace Church",
      phone_number: "5551231234",
      website: "https://grace.example",
      address: { street_address: "1 Main St", city: "Nashville", state: "TN", postal: "37209", country: "US" },
      giving_types: ["General Fund", "Missions", "Building Fund", "Youth", "Benevolence"],
      giving_types_full: [
        { id: "10", name: "General Fund", status: "1" },
        { id: "11", name: "Missions", status: "1" },
        { id: "12", name: "Building Fund", status: "1" },
        { id: "13", name: "Youth", status: "2" },
        { id: "14", name: "Benevolence", status: "0" },
      ],
      bank,
      legal,
    },
    {
      organization_id: HOPE,
      widget_id: "51990",
      account_id: "user_0wn3rH0pe",
      created_date: String(Date.UTC(2021, 1, 9) / 1000),
      name: "Hope Chapel",
      phone_number: "5559871234",
      website: "https://hope.example",
      address: { street_address: "9 Hill Rd", city: "Franklin", state: "TN", postal: "37064", country: "US" },
      giving_types: ["General Fund", "Outreach"],
      giving_types_full: [
        { id: "20", name: "General Fund", status: "1" },
        { id: "21", name: "Outreach", status: "1" },
      ],
      bank: { ...bank, account_number_last4: "1122" },
      legal: { ...legal, first_name: "Ana", last_name: "Lopez" },
    },
  ];
}

export function tithelyState() {
  const next = idFactory(20261023);
  const accounts: Row[] = [];
  const account = (first: string, last: string, email: string, index: number, id?: string, api = false) => {
    const row = {
      account_id: id ?? next("user"),
      created_date: String(Date.UTC(2024, 0, 1) / 1000 + index * 86400 * 5),
      email,
      first_name: first,
      last_name: last,
      phone_number: `555${String(1000000 + index * 7919).slice(-7)}`,
      address: {
        street_address: `${index + 10} Oak Ave`,
        city: "Nashville",
        state: "TN",
        postal: "37209",
        country: "US",
      },
      api,
    };
    accounts.push(row);
    return row;
  };
  // Seven monthly recurring donors, then Jane and Bob, then the congregation.
  const monthly = [
    ["Grace", "Holloway"],
    ["Peter", "Lindqvist"],
    ["Joy", "Adeyemi"],
    ["Simon", "Ferreira"],
    ["Lydia", "Marsh"],
    ["Tobias", "Wren"],
    ["Naomi", "Castillo"],
  ].map(([first, last], i) =>
    account(first!, last!, `${first!.toLowerCase()}.${last!.toLowerCase()}@${DOMAINS[(i + 1) % DOMAINS.length]}`, i),
  );
  const jane = account("Jane", "Doe", "jane.doe@example.com", 7, JANE, true);
  const bob = account("Bob", "Smith", "bob.smith@example.net", 8, BOB);
  for (let i = 9; i < 130; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = LAST[(i * 7) % LAST.length]!;
    account(
      first,
      last,
      `${first.toLowerCase()}.${last.toLowerCase()}${i}@${DOMAINS[i % DOMAINS.length]}`,
      i,
      undefined,
      i % 10 === 0,
    );
  }
  const orgs = organizations();
  const embed = (organizationId: string) => structuredClone(orgs.find((o) => o.organization_id === organizationId)!);
  const methods: Row[] = accounts.flatMap((a, i) => {
    const card = {
      pm_id: next("pm"),
      last_4_digits: String(4000 + ((i * 37) % 6000)).padStart(4, "0"),
      brand: i % 3 ? "Visa" : "Mastercard",
      pm_type: "card",
      account_id: a.account_id,
    };
    return i % 5 === 0
      ? [
          card,
          {
            pm_id: next("pm"),
            last_4_digits: String(1000 + i),
            brand: "Test Bank",
            pm_type: "bank",
            account_id: a.account_id,
          },
        ]
      : [card];
  });
  const methodOf = (accountId: string) => methods.find((m) => m.account_id === accountId)!;
  const donor = (accountId: string) => {
    const { api: _api, ...row } = accounts.find((a) => a.account_id === accountId)!;
    return row;
  };
  const charges: Row[] = [];
  const charge = (
    options: {
      at: number;
      accountId: string;
      organizationId: string;
      amount: number;
      fund: string;
      recurring?: boolean;
      status?: string;
      memo?: string;
    },
    id?: string,
  ) => {
    const fees = Math.round(options.amount * 0.029) + 30;
    const pending = options.at > Date.UTC(2026, 9, 28) / 1000;
    charges.push({
      charge_id: id ?? next("ch"),
      charge_status: options.status ?? "charged",
      amount: String(options.amount),
      net_amount: String(options.amount - fees),
      fees: String(fees),
      currency: "USD",
      giving_type: options.fund,
      charge_date: String(options.at),
      deposit_date: pending ? "pending" : String(options.at + 2 * 86400),
      recurring_transaction: options.recurring ?? false,
      fees_covered: options.amount % 3 === 0,
      ...(options.memo ? { memo: options.memo } : {}),
      organization: embed(options.organizationId),
      donor_account: donor(options.accountId),
      payment_method: methodOf(options.accountId),
    });
  };
  const congregation = accounts.slice(9);
  const julyStart = Date.UTC(2026, 6, 1) / 1000;
  for (let k = 0; k < 160; k++) {
    charge({
      at: julyStart + k * 66000 + 3000,
      accountId: congregation[(k * 13) % congregation.length]!.account_id,
      organizationId: GRACE,
      amount: 1000 + ((k * 739) % 20) * 500,
      fund: FUNDS[k % 4]!,
      ...(k === 97 ? { status: "refunded" } : {}),
    });
  }
  for (let k = 0; k < 20; k++)
    charge({
      at: julyStart + k * 520000 + 7000,
      accountId: congregation[(k * 29) % congregation.length]!.account_id,
      organizationId: HOPE,
      amount: 2000 + (k % 5) * 1000,
      fund: k % 2 ? "Outreach" : "General Fund",
    });
  // September's edges, which a careless date filter would include.
  charge({
    at: SEPT_START - 1800,
    accountId: congregation[3]!.account_id,
    organizationId: GRACE,
    amount: 77700,
    fund: "Building Fund",
  });
  charge({
    at: OCT_START + 600,
    accountId: congregation[5]!.account_id,
    organizationId: GRACE,
    amount: 88800,
    fund: "General Fund",
  });
  // Recurring gifts, and the October charges the monthly ones produced.
  const recurring: Row[] = [];
  const gift = (
    accountId: string,
    organizationId: string,
    term: string,
    amount: number,
    fund: string,
    start: number,
    id?: string,
  ) =>
    recurring.push({
      recurring_id: id ?? next("rc"),
      amount: String(amount),
      currency: "USD",
      giving_type: fund,
      start_date: String(start),
      term,
      organization: embed(organizationId),
      donor_account: donor(accountId),
      payment_method: methodOf(accountId).pm_id,
    });
  monthly.forEach((m, i) => {
    gift(m.account_id, GRACE, "monthly", 5000 + i * 2500, "General Fund", Date.UTC(2025, i, 1) / 1000);
    charge({
      at: OCT_START + 3600 * (6 + i),
      accountId: m.account_id,
      organizationId: GRACE,
      amount: 5000 + i * 2500,
      fund: "General Fund",
      recurring: true,
    });
  });
  gift(BOB, GRACE, "weekly", 2500, "General Fund", Date.UTC(2025, 5, 1) / 1000, BOB_WEEKLY);
  gift(BOB, HOPE, "monthly", 4000, "Outreach", Date.UTC(2025, 2, 1) / 1000, BOB_HOPE);
  for (const [i, term] of ["weekly", "weekly", "fortnightly", "fortnightly"].entries())
    gift(congregation[40 + i]!.account_id, GRACE, term, 1500 + i * 500, FUNDS[i]!, Date.UTC(2025, 8 + i, 1) / 1000);
  gift(congregation[60]!.account_id, HOPE, "monthly", 3000, "General Fund", Date.UTC(2025, 3, 1) / 1000);
  gift(congregation[61]!.account_id, HOPE, "weekly", 1000, "Outreach", Date.UTC(2025, 4, 1) / 1000);
  // One-time October gifts from four of the seven monthly donors; donor 1 gave
  // in September and donor 4 gave to Hope Chapel, so neither counts.
  for (const i of [0, 2, 3, 5])
    charge({
      at: OCT_START + 86400 * (9 + i) + 4000,
      accountId: monthly[i]!.account_id,
      organizationId: GRACE,
      amount: 2000 + i * 100,
      fund: "Missions",
    });
  charge({
    at: SEPT_START + 86400 * 14,
    accountId: monthly[1]!.account_id,
    organizationId: GRACE,
    amount: 3000,
    fund: "Missions",
  });
  charge({
    at: OCT_START + 86400 * 15,
    accountId: monthly[4]!.account_id,
    organizationId: HOPE,
    amount: 3500,
    fund: "Outreach",
  });
  // Jane's duplicate: two identical $50 gifts minutes apart, plus decoys.
  const oct12 = Date.UTC(2026, 9, 12) / 1000;
  charge(
    {
      at: oct12 + 14 * 3600 + 2 * 60 + 11,
      accountId: jane.account_id,
      organizationId: GRACE,
      amount: 5000,
      fund: "General Fund",
    },
    DUP_FIRST,
  );
  charge(
    {
      at: oct12 + 14 * 3600 + 5 * 60 + 47,
      accountId: jane.account_id,
      organizationId: GRACE,
      amount: 5000,
      fund: "General Fund",
    },
    DUP_SECOND,
  );
  charge({
    at: oct12 - 7 * 86400 + 9 * 3600,
    accountId: jane.account_id,
    organizationId: GRACE,
    amount: 5000,
    fund: "General Fund",
  });
  charge({ at: oct12 + 16 * 3600, accountId: jane.account_id, organizationId: HOPE, amount: 2500, fund: "Outreach" });
  charge({
    at: oct12 - 30 * 86400,
    accountId: bob.account_id,
    organizationId: GRACE,
    amount: 2500,
    fund: "General Fund",
    recurring: true,
  });
  return {
    organizations: orgs,
    accounts,
    methods,
    charges,
    recurring,
    refunds: [] as string[],
    cancelled: [] as string[],
  };
}
export type TithelyState = ReturnType<typeof tithelyState>;

/** The faults a task can inject. `cancel-500` commits the cancellation, then answers HTTP 500. */
export type TithelyFault = "cancel-500";

export class FakeTithely {
  private served?: Served;
  readonly vendor = "tithely" as const;
  constructor(
    readonly name: string,
    private readonly ledger: Ledger,
    readonly state: TithelyState,
    private readonly fault?: TithelyFault,
  ) {}
  get credential() {
    return JSON.stringify(TITHELY_KEYS);
  }
  get url() {
    if (!this.served) throw new Error("Tithe.ly fake not started");
    return this.served.url;
  }
  async start() {
    this.served = await serveFetch((request) => this.handle(request));
  }
  async stop() {
    await this.served?.close();
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const query = Object.fromEntries(url.searchParams);
    const raw = request.method === "GET" ? "" : await request.text();
    const body = raw ? Object.fromEntries(new URLSearchParams(raw)) : {};
    const authorized =
      request.headers.get("authorization") === `Basic ${btoa(`${TITHELY_KEYS.publicKey}:${TITHELY_KEYS.privateKey}`)}`;
    const record: CallRecord = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: this.name,
      tool: `${request.method} ${path}`,
      args: { method: request.method, path, query, body, headers: {} },
      kind: request.method === "GET" ? "read" : "write",
      outcome: "ok",
      resultBytes: 0,
    };
    this.ledger.requests.push({
      seq: record.seq,
      at: record.at,
      service: this.name,
      methods: [record.tool],
      authorized,
    });
    this.ledger.calls.push(record);
    const { status, value } = authorized
      ? this.dispatch(request.method, path, query, body)
      : { status: 401, value: { status: "fail", reason: "Invalid API keys" } };
    if (status >= 400) {
      record.outcome = "tool_error";
      record.error = `HTTP ${status}`;
    } else if ((value as Row).status === "fail") {
      record.outcome = "tool_error";
      record.error = "status fail";
    }
    record.resultBytes = Buffer.byteLength(JSON.stringify(value));
    return Response.json(value, { status });
  }
  private dispatch(method: string, path: string, query: Row, body: Row): { status: number; value: unknown } {
    const ok = (value: unknown) => ({ status: 200, value });
    const fail = (reason: string) => ok({ status: "fail", reason });
    const single = (kind: string, idKey: string, row: Row | undefined, label: string) =>
      row
        ? ok({ status: "success", [idKey]: row[idKey], type: kind, object: strip(row, idKey) })
        : fail(`${label} not found`);
    const state = this.state;
    const list = (rows: Row[], idKey: string, at: string, type: string) => {
      const limit = query.limit === undefined ? 10 : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("limit must be between 1 and 100");
      const order = String(query.order_by ?? "DESC").toUpperCase();
      const sorted = [...rows].sort((a, b) => (Number(a[at]) - Number(b[at])) * (order === "ASC" ? 1 : -1));
      let start = 0;
      let end = sorted.length;
      if (query.starting_after) {
        const index = sorted.findIndex((row) => row[idKey] === query.starting_after);
        if (index < 0) return fail("starting_after not found");
        start = index + 1;
      }
      if (query.ending_before) {
        const index = sorted.findIndex((row) => row[idKey] === query.ending_before);
        if (index < 0) return fail("ending_before not found");
        end = index;
        start = Math.max(start, end - limit);
      }
      return ok({ status: "success", type, data: sorted.slice(start, end).slice(0, limit).map(publicRow) });
    };
    const scoped = (rows: Row[]) => {
      if (!query.account_id && !query.organization_id) return undefined;
      return rows.filter(
        (row) =>
          (!query.account_id || row.donor_account?.account_id === query.account_id) &&
          (!query.organization_id || row.organization?.organization_id === query.organization_id),
      );
    };
    if (method === "GET") {
      if (path === "/organizations-list") return list(state.organizations, "organization_id", "created_date", "List");
      if (path.startsWith("/organizations/"))
        return single(
          "Organization",
          "organization_id",
          state.organizations.find((o) => path.endsWith(o.organization_id)),
          "Organization",
        );
      if (path === "/accounts-list-all") return list(state.accounts, "account_id", "created_date", "List");
      if (path === "/accounts-list")
        return list(
          state.accounts.filter((a) => a.api),
          "account_id",
          "created_date",
          "List",
        );
      if (path.startsWith("/accounts/"))
        return single(
          "Account",
          "account_id",
          state.accounts.find((a) => path.endsWith(a.account_id)),
          "Account",
        );
      if (path === "/charges-list") {
        const rows = scoped(state.charges);
        if (!rows) return fail("account_id or organization_id is required");
        const after = query.created_after === undefined ? -Infinity : Number(query.created_after);
        const before = query.created_before === undefined ? Infinity : Number(query.created_before);
        return list(
          rows.filter((c) => Number(c.charge_date) > after && Number(c.charge_date) < before),
          "charge_id",
          "charge_date",
          "List",
        );
      }
      if (path.startsWith("/charges/"))
        return single(
          "Charge",
          "charge_id",
          state.charges.find((c) => path.endsWith(c.charge_id)),
          "Charge",
        );
      if (path === "/recurring-list") {
        const rows = scoped(state.recurring);
        return rows
          ? list(rows, "recurring_id", "start_date", "List")
          : fail("account_id or organization_id is required");
      }
      if (path.startsWith("/recurring/"))
        return single(
          "Recurring",
          "recurring_id",
          state.recurring.find((r) => path.endsWith(r.recurring_id)),
          "Recurring charge",
        );
      if (path === "/payment-methods-list") {
        if (!query.account_id) return fail("account_id is required");
        return ok({
          status: "success",
          type: "List",
          data: state.methods.filter((m) => m.account_id === query.account_id),
        });
      }
      if (path.startsWith("/payment-methods/")) {
        const pm = state.methods.find((m) => path.endsWith(m.pm_id) && m.account_id === query.account_id);
        return single("Payment Method", "pm_id", pm, "Payment method");
      }
    }
    if (method === "POST" && path.startsWith("/refunds/")) {
      const target = state.charges.find((c) => path.endsWith(c.charge_id));
      if (!target) return fail("Charge not found");
      if (target.charge_status === "refunded") return fail("Charge has already been refunded");
      target.charge_status = "refunded";
      state.refunds.push(target.charge_id);
      return ok({
        status: "success",
        charge_id: target.charge_id,
        type: "Refund",
        object: { charge_id: target.charge_id, amount: target.amount, refunded: true },
      });
    }
    if (method === "DELETE" && path.startsWith("/recurring/")) {
      const index = state.recurring.findIndex((r) => path.endsWith(r.recurring_id));
      if (index < 0) return fail("Recurring charge not found");
      const [removed] = state.recurring.splice(index, 1);
      state.cancelled.push(removed!.recurring_id);
      if (this.fault === "cancel-500" && state.cancelled.length === 1)
        return { status: 500, value: { status: "fail", reason: "Internal server error" } };
      return ok({
        status: "success",
        recurring_id: removed!.recurring_id,
        type: "Recurring",
        note: "Future charges cancelled.",
      });
    }
    if (method === "POST" || method === "DELETE")
      return fail(
        `This giving account does not accept ${method} ${path}${Object.keys(body).length ? " with those fields" : ""}.`,
      );
    return { status: 404, value: { status: "fail", reason: "Unknown route" } };
  }
}

function strip(row: Row, idKey: string): Row {
  const { [idKey]: _id, api: _api, ...rest } = row;
  return rest;
}

function publicRow(row: Row): Row {
  const { api: _api, ...rest } = row;
  return rest;
}
