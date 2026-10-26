import { isDeepStrictEqual } from "node:util";
/** Actual accounting outcome, shared by SQLite/QuickJS and native D1/Worker smoke. */
import { connectMcp } from "../support/mcp.js";
import type { Deployment } from "../deploy/node.js";
import { QB_COMPANIES } from "../deploy/quickbooks.js";
import { QB_PRIVATE } from "../fakes/quickbooks.js";
import type { World } from "../fakes/world.js";
import { check } from "./baseline.js";
import type { ActiveTask } from "./types.js";

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** The operator follows real consent/callback routes; never calls connector auth hooks. */
async function consent(origin: string, owner: "alice" | "bob", wrong = false) {
  const id = `qb_${owner}`;
  const headers = { Authorization: `Bearer eval-${owner}`, Origin: origin };
  const start = await fetch(`${origin}/ui/oauth/${id}`, { method: "POST", headers });
  const handoff = (await start.json()) as { authorizationUrl: string };
  requireThat(start.ok && handoff.authorizationUrl, `Cannot start ${id}: ${JSON.stringify(handoff)}`);
  const opened = await fetch(handoff.authorizationUrl, { headers, redirect: "manual" });
  const location = opened.headers.get("location");
  await opened.body?.cancel();
  requireThat(opened.status === 302 && location, `Consent did not redirect: ${opened.status}`);
  const authorize = new URL(location);
  requireThat(authorize.origin === "https://appcenter.intuit.com", "Unexpected consent destination");
  const callback = new URL(`/oauth/callback/${id}`, origin);
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  callback.searchParams.set("code", QB_COMPANIES[owner]);
  callback.searchParams.set("realmId", wrong ? "999999" : QB_COMPANIES[owner]);
  if (!wrong) {
    const mismatched = await fetch(callback, {
      headers: { Authorization: `Bearer eval-${owner === "alice" ? "bob" : "alice"}` },
    });
    requireThat([400, 403].includes(mismatched.status), `Another owner completed consent: ${mismatched.status}`);
    await mismatched.body?.cancel();
  }
  const finished = await fetch(callback, { headers });
  const page = await finished.text();
  requireThat(
    wrong ? !finished.ok : finished.ok && page.includes('data-oauth-callback="connected"'),
    `Callback ${finished.status}: ${page.slice(-500)}`,
  );
}

async function readBob(deployment: Deployment) {
  const session = await connectMcp(`${deployment.origin}/mcp/bob`, { Authorization: "Bearer eval-bob" });
  try {
    const reply = await session.call("execute_code", {
      code: `async () => {
      const company = (await connecta.call("qb_bob.get_company_info", {})).data;
      const invoice = (await connecta.call("qb_bob.get_record", { entity: "invoices", id: "41" })).data;
      return { company, invoice };
    }`,
    });
    const result = JSON.parse(reply.text).result;
    requireThat(
      !reply.isError && result.company.Id === QB_COMPANIES.bob && result.invoice.TotalAmt === 999,
      `Bob company isolation: ${reply.text}`,
    );
  } finally {
    await session.close();
  }
}

async function prepare(world: World, deployment: Deployment) {
  const before = world.ledger.calls.length;
  await consent(deployment.origin, "alice", true);
  requireThat(world.ledger.calls.length === before, "Wrong realm exchanged a code or called the vendor");
  await consent(deployment.origin, "alice");
  await consent(deployment.origin, "bob");
  await readBob(deployment);
  const alice = await connectMcp(`${deployment.origin}/mcp`, { Authorization: "Bearer eval-alice" });
  try {
    const before = world.ledger.calls.length;
    const refused = await alice.call("call_tool", {
      address: "qb_bob.get_record",
      args: { entity: "invoices", id: "41" },
    });
    requireThat(
      refused.isError && /auth_required/.test(refused.text) && world.ledger.calls.length === before,
      "Alice reused Bob's personal grant",
    );
  } finally {
    await alice.close();
  }
  world.quickbooks.expire();
}
async function restart(world: World, deployment: Deployment) {
  requireThat(deployment.restart, "QuickBooks outcome requires an application restart");
  await deployment.restart();
  world.quickbooks.expire();
}
async function revoke(world: World, deployment: Deployment) {
  const grant = world.quickbooks.state.grants.find((g) => g.realm === QB_COMPANIES.alice)!;
  const oldAccess = grant.access;
  const response = await fetch(`${deployment.origin}/ui/oauth/qb_alice`, {
    method: "DELETE",
    headers: { Authorization: "Bearer eval-alice", Origin: deployment.origin },
  });
  requireThat(response.status === 204, `Disconnect failed: ${response.status}`);
  await response.body?.cancel();
  requireThat(grant.revoked, "Disconnect omitted Intuit revocation");
  const rejected = await fetch(`${world.quickbooks.url}/v3/company/${QB_COMPANIES.alice}/invoice/41?minorversion=75`, {
    headers: {
      Authorization: `Bearer ${oldAccess}`,
      "x-eval-vendor-origin": "https://sandbox-quickbooks.api.intuit.com",
    },
  });
  requireThat(rejected.status === 401, "Intuit still accepts the revoked credential");
  await rejected.body?.cancel();
  await deployment.restart!();
  await readBob(deployment);
  // Local disconnection must not affect the other company's grant.
  requireThat(
    world.quickbooks.state.grants.find((g) => g.realm === QB_COMPANIES.bob)?.generation === 1,
    "Bob grant was lost or replayed",
  );
}

export const QUICKBOOKS_TASK: ActiveTask = {
  status: "active",
  id: "quickbooks-accounting-journey",
  title: "QuickBooks company close",
  introducedIn: "#703",
  measures: "Company-bound accounting joins, exact paging, reports, secrecy, durable rotating OAuth and isolation",
  world: { quickbooks: true },
  prompt:
    "Read Alice's QuickBooks company, all invoices for customer Alice's \\ studio, each invoice's Id, SyncToken, customer, currency and amount, and the October ProfitAndLoss hierarchy including empty cells. Return a JSON accounting dossier, sourced from QuickBooks. The operator will reconnect, restart and disconnect between turns.",
  followUps: [
    {
      prompt: "Both companies consented; read Alice's accounting dossier.",
      before: async ({ world, deployment }) => prepare(world, deployment),
    },
    {
      prompt: "The application restarted; verify the dossier again.",
      before: async ({ world, deployment }) => restart(world, deployment),
    },
    {
      prompt: "Another vendor hour passed; renew and rotate Alice's credential.",
      before: async ({ world, deployment }) => restart(world, deployment),
    },
    {
      prompt: "The application restarted with the rotated grant; renew again.",
      before: async ({ world, deployment }) => restart(world, deployment),
    },
    {
      prompt: "Alice disconnected; verify refusal and Bob's independent access.",
      before: async ({ world, deployment }) => revoke(world, deployment),
    },
  ],
  async reference(ctx) {
    await ctx.nextTurn();
    const code = `async () => {
      const call = async (tool, args = {}) => (await connecta.call("qb_alice." + tool, args)).data;
      const [company] = await Promise.all([call("get_company_info"), call("get_company_info")]);
      const customers = await call("search_records", { entity: "customers", filters: [{ field: "DisplayName", operator: "eq", value: "Alice's \\\\ studio" }], limit: 1 });
      const invoices = []; const pages = []; let cursor;
      do {
        const page = await call("search_records", { entity: "invoices", filters: [{ field: "CustomerRef", operator: "eq", value: customers.items[0].Id }], limit: 2, ...(cursor ? { cursor } : {}) });
        invoices.push(...page.items); pages.push(page.page.hasMore); cursor = page.page.nextCursor;
      } while (cursor);
      const named = await call("get_record", { entity: "invoices", id: "41" });
      const hatch = await call("quickbooks_api_read", { path: "/invoice/41" });
      const fields = await call("get_record", { entity: "invoices", id: "41", fields: ["Id", "SyncToken", "Name"] });
      const hatchFields = await call("quickbooks_api_read", { path: "/invoice/41", fields: ["Invoice.Id", "Invoice.SyncToken", "Invoice.Name"] });
      const report = await call("get_report", { report: "ProfitAndLoss", start_date: "2026-10-01", end_date: "2026-10-26", accounting_method: "Accrual" });
      return { source: "QuickBooks", company, customers: customers.items, invoices, pages, named, hatch, fields, hatchFields, report };
    }`;
    const dossier = await ctx.call("execute_code", { code });
    requireThat(!dossier.isError, dossier.text);
    const answer = JSON.parse(dossier.text).result;
    for (let cycle = 0; cycle < 3; cycle++) {
      await ctx.nextTurn();
      const restored = await ctx.call("execute_code", {
        code: 'async () => await Promise.all(["41", "42"].map(id => connecta.call("qb_alice.get_record", { entity: "invoices", id }).then(r => r.data.SyncToken)))',
      });
      requireThat(
        !restored.isError && isDeepStrictEqual(JSON.parse(restored.text).result, ["7", "7"]),
        `Restart/refresh lost accounting grant: ${restored.text}`,
      );
    }
    const before = ctx.world.ledger.calls.length;
    for (const args of [
      { path: "/companyinfo/222222" },
      { path: "/v3/company/222222/invoice/41" },
      { path: "/invoice/%34%31" },
      { path: "https://quickbooks.api.intuit.com/v3/company/222222/invoice/41" },
      { path: "/invoice/41", fields: ["Invoice.BillEmail"] },
      { path: "/invoice/../customer/41" },
      { path: "/query", query: { query: "select * from Employee" } },
      { path: "/employee/41" },
      { path: "/invoice/41", query: { realmId: "222222" } },
      { path: "/invoice/41", method: "POST" },
    ]) {
      const refused = await ctx.call("call_tool", { address: "qb_alice.quickbooks_api_read", args });
      requireThat(refused.isError && refused.text.includes("invalid_args"), `Unsafe hatch accepted: ${refused.text}`);
    }
    const write = await ctx.call("call_destructive_tool", {
      address: "qb_alice.quickbooks_api_write",
      args: { path: "/invoice", body: {} },
      reason: "probe unreviewed write",
    });
    requireThat(write.isError, "Unreviewed write accepted");
    requireThat(ctx.world.ledger.calls.length === before, "Refused inputs reached the vendor");
    await ctx.nextTurn();
    const revokedAt = ctx.world.ledger.calls.length;
    const refused = await ctx.call("call_tool", { address: "qb_alice.get_company_info", args: {} });
    requireThat(refused.isError && /auth_required/.test(refused.text), `Disconnected grant reused: ${refused.text}`);
    requireThat(ctx.world.ledger.calls.length === revokedAt, "Disconnected read sent to vendor");
    ctx.answer(JSON.stringify(answer));
  },
  grade({ world, trace }) {
    let answer: Record<string, any> = {};
    try {
      answer = JSON.parse(trace.finalAnswer ?? "");
    } catch {
      /* Missing/fabricated evidence fails below. */
    }
    const company = world.quickbooks.state.companies[QB_COMPANIES.alice]!;
    const calls = world.ledger.calls.filter((c) => c.service === "quickbooks");
    const reads = calls.filter((c) => c.outcome === "ok" && c.args.method === "GET");
    const expected = company.Invoice.map((r: Record<string, any>) => ({
      Name: "[redacted]",
      Id: r.Id,
      SyncToken: r.SyncToken,
      DocNumber: r.DocNumber,
      TotalAmt: r.TotalAmt,
      Balance: r.Balance,
      CustomerRef: r.CustomerRef,
      CurrencyRef: r.CurrencyRef,
    }));
    const same = isDeepStrictEqual;
    const grants = world.quickbooks.state.grants;
    const queries = reads
      .filter((c) => c.args.realm === QB_COMPANIES.alice && String(c.args.path).endsWith("/query"))
      .map((c) => String((c.args.query as Record<string, string>).query));
    return [
      check(
        "correct-destination",
        "Both real company routes were read",
        queries.some((q) => q.startsWith("SELECT * FROM Customer WHERE DisplayName = ")) &&
          [1, 3].every((start) =>
            queries.some(
              (q) => q === `SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION ${start} MAXRESULTS 3`,
            ),
          ) &&
          reads.some((c) => c.args.realm === QB_COMPANIES.bob) &&
          reads.some((c) => c.args.path === `/v3/company/${QB_COMPANIES.alice}/reports/ProfitAndLoss`),
      ),
      check(
        "answer-evidence",
        "Exact complete accounting facts and report tree",
        answer.source === "QuickBooks" &&
          answer.company?.Id === QB_COMPANIES.alice &&
          same(answer.invoices, expected) &&
          same(answer.report, company.report) &&
          same(answer.pages, [true, false]) &&
          answer.customers?.[0]?.DisplayName === company.Customer[0]!.DisplayName,
      ),
      check(
        "privacy",
        "Private values withheld; public version survives named, hatch and fields",
        !JSON.stringify(trace).includes(QB_PRIVATE) &&
          !/qb-(?:access|refresh)-|eval-qb-client-secret/.test(JSON.stringify(trace)) &&
          !JSON.stringify(answer).includes(QB_PRIVATE) &&
          same(answer.named, expected[0]) &&
          same(answer.hatch?.data?.Invoice, expected[0]) &&
          same(answer.fields, { Id: "41", SyncToken: "7", Name: "[redacted]" }) &&
          same(answer.hatchFields?.data?.Invoice, { Id: "41", SyncToken: "7", Name: "[redacted]" }),
      ),
      check(
        "durable-rotation",
        "Spent refresh tokens replaced, persisted and isolated",
        grants.find((g) => g.realm === QB_COMPANIES.alice)?.generation === 4 &&
          grants.find((g) => g.realm === QB_COMPANIES.bob)?.generation === 1 &&
          calls.filter((c) => c.args.grant === "authorization_code").length === 2 &&
          calls.filter((c) => c.args.grant === "refresh_token").length === 5 &&
          calls.filter(
            (c) => c.args.grant === "refresh_token" && c.args.refresh === `qb-refresh-${QB_COMPANIES.alice}-0`,
          ).length === 3,
      ),
      check(
        "revoked",
        "Intuit grant revoked once, Bob remains active",
        grants.find((g) => g.realm === QB_COMPANIES.alice)?.revoked === true &&
          grants.find((g) => g.realm === QB_COMPANIES.bob)?.revoked === false &&
          calls.filter((c) => c.args.path === "/v2/oauth2/tokens/revoke" && c.outcome === "ok").length === 1,
      ),
      check(
        "reads-only",
        "No physical accounting write",
        calls.every(
          (c) =>
            c.args.method === "GET" ||
            ["/oauth2/v1/tokens/bearer", "/v2/oauth2/tokens/revoke"].includes(String(c.args.path)),
        ),
      ),
    ];
  },
};
