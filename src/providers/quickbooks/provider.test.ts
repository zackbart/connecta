import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { makeRegistry } from "../../../test/helpers.js";
import { fixture } from "./fixtures.js";

beforeEach(() => {
  installOwnedTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function connected() {
  const requests: URL[] = [];
  let answer: unknown = {};
  let status = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.href === "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer") {
        expect(new Headers(init.headers).get("authorization")).toBe(`Basic ${btoa("fixture-client:fixture-secret")}`);
        return Response.json({
          access_token: "fixture-access-token",
          refresh_token: "fixture-refresh-token",
          expires_in: 3600,
          token_type: "bearer",
        });
      }
      expect(url.origin).toBe("https://sandbox-quickbooks.api.intuit.com");
      expect(url.pathname.startsWith("/v3/company/123456789/")).toBe(true);
      expect(url.searchParams.get("minorversion")).toBe("75");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-access-token");
      requests.push(url);
      return Response.json(answer, { status });
    }),
  );
  const connector = fixture.create("accounting");
  const registry = makeRegistry([connector]);
  const ctx = () => registry.contextFor("accounting", "https://connecta.example");
  const started = await connector.startAuth!(ctx());
  const state = new URL(started.authorizationUrl!).searchParams.get("state")!;
  expect(await connector.verifyState!(state, ctx())).toBe(true);
  await connector.finishAuth!("company-code", ctx(), new URLSearchParams({ state, realmId: "123456789" }));
  return {
    connector,
    requests,
    ctx,
    respond: (value: unknown, nextStatus = 200) => {
      answer = value;
      status = nextStatus;
    },
    call: (name: string, args: Record<string, unknown> = {}) => connector.callTool(name, args, ctx()),
  };
}

it("INV-5: reads accounting records with public SyncToken and the same private-field boundary through named and hatch reads", async () => {
  const world = await connected();
  world.respond({
    CompanyInfo: {
      Id: "123456789",
      CompanyName: "Example company",
      EmployerId: "private-tax",
      Email: { Address: "alice@example.com" },
    },
  });
  expect(await world.call("get_company_info")).toEqual({ Id: "123456789", CompanyName: "Example company" });
  const invoice = {
    Id: "42",
    SyncToken: "7",
    TotalAmt: 125.5,
    CurrencyRef: { value: "USD" },
    CustomerRef: { value: "9", name: "Alice" },
    BillEmail: { Address: "alice@example.com" },
    BillAddr: { Line1: "Private address" },
    TaxIdentifier: "private-tax",
    CreditCardPayment: { CreditChargeResponse: { CCTransId: "private-card" } },
    InvoiceLink: "https://private.example/pay?token=stored-secret",
    PrivateNote: "private-bank",
    Line: [{ Amount: 125.5, SalesItemLineDetail: { ItemRef: { value: "6" }, Qty: 1 } }],
  };
  world.respond({ Invoice: invoice });
  const named = await world.call("get_record", { entity: "invoices", id: "42" });
  const hatch = await world.call("quickbooks_api_read", { path: "/invoice/42" });
  expect(named).toEqual({
    Id: "42",
    SyncToken: "7",
    TotalAmt: 125.5,
    CurrencyRef: { value: "USD" },
    CustomerRef: { value: "9", name: "Alice" },
    Line: [{ Amount: 125.5, SalesItemLineDetail: { ItemRef: { value: "6" }, Qty: 1 } }],
  });
  expect(hatch).toEqual({ status: 200, data: { Invoice: named } });
  expect(await world.call("get_record", { entity: "invoices", id: "42", fields: ["Id", "SyncToken"] })).toEqual({
    Id: "42",
    SyncToken: "7",
  });
  const sends = world.requests.length;
  await expect(world.call("get_record", { entity: "invoices", id: "42", fields: ["BillEmail"] })).rejects.toMatchObject(
    { code: "invalid_args" },
  );
  expect(world.requests).toHaveLength(sends);
});

it("INV-11: searches exact names safely and continues the original company-bound search", async () => {
  const world = await connected();
  const filters = [{ field: "DisplayName", operator: "eq", value: "Alice's \\ studio" }];
  world.respond({
    QueryResponse: { Customer: [{ Id: "1", DisplayName: "Alice's \\ studio", SyncToken: "2" }, { Id: "2" }] },
  });
  const first = (await world.call("search_records", { entity: "customers", filters, limit: 1 })) as {
    items: unknown[];
    page: { hasMore: boolean; nextCursor: string };
  };
  expect(first.items).toEqual([{ Id: "1", DisplayName: "Alice's \\ studio", SyncToken: "2" }]);
  expect(first.page.hasMore).toBe(true);
  expect(world.requests[0]!.searchParams.get("query")).toBe(
    "SELECT * FROM Customer WHERE DisplayName = 'Alice\\'s \\\\ studio' STARTPOSITION 1 MAXRESULTS 2",
  );
  world.respond({ QueryResponse: { Customer: [{ Id: "2" }] } });
  expect(
    await world.call("search_records", { entity: "customers", filters, limit: 1, cursor: first.page.nextCursor }),
  ).toEqual({ items: [{ Id: "2" }], page: { hasMore: false } });
  expect(world.requests[1]!.searchParams.get("query")).toContain("STARTPOSITION 2 MAXRESULTS 2");
  const sends = world.requests.length;
  await expect(
    world.call("search_records", { entity: "vendors", filters, limit: 1, cursor: first.page.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_args" });
  expect(world.requests).toHaveLength(sends);
});

it("INV-5: preserves report hierarchy, column metadata and empty money without inferring positional metrics", async () => {
  const world = await connected();
  const report = {
    Header: { ReportName: "ProfitAndLoss", Currency: "USD", Option: [{ Name: "NoReportData", Value: "false" }] },
    Columns: { Column: [{ ColType: "Money", ColTitle: "Total", MetaData: [{ Name: "ColKey", Value: "total" }] }] },
    Rows: {
      Row: [
        {
          type: "Section",
          group: "Income",
          Header: { ColData: [{ value: "Income" }, { value: "" }] },
          Rows: { Row: [{ ColData: [{ value: "Consulting", id: "6" }, { value: "125.50" }] }] },
          Summary: { ColData: [{ value: "Total Income" }, { value: "125.50" }] },
        },
      ],
    },
  };
  world.respond(report);
  expect(
    await world.call("get_report", {
      report: "ProfitAndLoss",
      start_date: "2026-10-01",
      end_date: "2026-10-26",
      accounting_method: "Accrual",
    }),
  ).toEqual(report);
  expect(world.requests[0]!.searchParams.get("accounting_method")).toBe("Accrual");
  for (const name of ["AgedReceivables", "AgedPayables"]) {
    world.respond({ ...report, Header: { ...report.Header, ReportName: name } });
    await world.call("get_report", { report: name, end_date: "2026-10-26" });
    const url = world.requests.at(-1)!;
    expect(url.searchParams.get("report_date")).toBe("2026-10-26");
    expect(url.searchParams.get("aging_method")).toBe("Report_Date");
    expect(url.searchParams.has("end_date")).toBe(false);
  }
  const sends = world.requests.length;
  await expect(world.call("get_report", { report: "CashFlow", accounting_method: "Cash" })).rejects.toMatchObject({
    code: "invalid_args",
  });
  await expect(world.call("get_report", { report: "ProfitAndLoss", end_date: "2026-02-30" })).rejects.toMatchObject({
    code: "invalid_args",
  });
  expect(world.requests).toHaveLength(sends);
});

it("INV-5: fails malformed successes and unknown records without exposing vendor error prose", async () => {
  const world = await connected();
  world.respond({});
  await expect(world.call("get_record", { entity: "invoices", id: "42" })).rejects.toMatchObject({
    code: "connector_call_failed",
  });
  await expect(world.call("search_records", { entity: "customers" })).rejects.toMatchObject({
    code: "connector_call_failed",
  });
  world.respond({ QueryResponse: { Invoice: [{ Id: "42" }] } });
  await expect(world.call("search_records", { entity: "customers" })).rejects.toMatchObject({
    code: "connector_call_failed",
  });
  world.respond({ Fault: { Error: [{ code: "610", Message: "private bank account or stored credential" }] } }, 400);
  try {
    await world.call("get_record", { entity: "invoices", id: "999" });
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toMatchObject({ code: "connector_call_failed" });
    expect(String(error)).not.toContain("private bank");
  }
});

it("INV-11: refuses arbitrary SQL, other companies, encoded paths, unreviewed resources and writes before resource dispatch", async () => {
  const world = await connected();
  for (const args of [
    { path: "/query", query: { query: "select * from Employee" } },
    { path: "/companyinfo/999" },
    { path: "/v3/company/999/invoice/42" },
    { path: "/invoice/%34%32" },
    { path: "/invoice/../customer/42" },
    { path: "https://quickbooks.api.intuit.com/v3/company/999/invoice/42" },
    { path: "/employee/42" },
    { path: "/invoice/42", query: { realmId: "999" } },
    { path: "/invoice/42", method: "POST" },
  ])
    await expect(world.call("quickbooks_api_read", args)).rejects.toMatchObject({ code: "invalid_args" });
  expect(world.requests).toHaveLength(0);
  expect(world.connector.staticTools?.map((tool) => tool.name)).not.toContain("quickbooks_api_write");
  for (const override of [
    { baseUrl: "https://example.com" },
    { scopes: ["openid"] },
    { token: "imported" },
    { realmId: "123/../../999" },
  ])
    expect(() => fixture.create("accounting", { ...fixture.options, ...override })).toThrow();
});
