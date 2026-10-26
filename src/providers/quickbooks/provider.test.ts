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

it("INV-11: refuses endpoint, scope and imported-token configuration overrides", () => {
  for (const override of [
    { baseUrl: "https://example.com" },
    { scopes: ["openid"] },
    { token: "imported" },
    { realmId: "123/../../999" },
  ])
    expect(() => fixture.create("accounting", { ...fixture.options, ...override })).toThrow();
});

it("INV-11: refuses cross-entity cursors and invalid report dates before dispatch", async () => {
  const world = await connected();
  world.respond({ QueryResponse: { Customer: [{ Id: "1" }, { Id: "2" }] } });
  const first = (await world.call("search_records", { entity: "customers", limit: 1 })) as {
    page: { nextCursor: string };
  };
  const sends = world.requests.length;
  await expect(
    world.call("search_records", { entity: "vendors", limit: 1, cursor: first.page.nextCursor }),
  ).rejects.toMatchObject({ code: "invalid_args" });
  await expect(world.call("get_report", { report: "ProfitAndLoss", end_date: "2026-02-30" })).rejects.toMatchObject({
    code: "invalid_args",
  });
  await expect(world.call("get_report", { report: "CashFlow", accounting_method: "Cash" })).rejects.toMatchObject({
    code: "invalid_args",
  });
  expect(world.requests).toHaveLength(sends);
});

it.each([
  {
    name: "null report rows",
    response: { Header: { ReportName: "ProfitAndLoss" }, Columns: { Column: [] }, Rows: null },
    tool: "get_report",
    args: { report: "ProfitAndLoss" },
  },
  {
    name: "malformed report rows",
    response: { Header: { ReportName: "ProfitAndLoss" }, Columns: { Column: [] }, Rows: { Row: "malformed" } },
    tool: "quickbooks_api_read",
    args: { path: "/reports/ProfitAndLoss" },
  },
  {
    name: "metadata-only nonempty query",
    response: { QueryResponse: { totalCount: 27 } },
    tool: "search_records",
    args: { entity: "invoices" },
  },
])("INV-5: refuses $name", async ({ response, tool, args }) => {
  const world = await connected();
  world.respond(response);
  await expect(world.call(tool, args)).rejects.toMatchObject({ code: "connector_call_failed" });
});

it("INV-5: preserves legitimate empty query and report responses", async () => {
  const world = await connected();
  world.respond({ QueryResponse: {} });
  expect(await world.call("search_records", { entity: "invoices" })).toEqual({ items: [], page: { hasMore: false } });
  for (const Rows of [{}, { Row: [] }]) {
    const report = { Header: { ReportName: "ProfitAndLoss" }, Columns: { Column: [] }, Rows };
    world.respond(report);
    expect(await world.call("get_report", { report: "ProfitAndLoss" })).toEqual(report);
  }
});
