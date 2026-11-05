import { isDeepStrictEqual } from "node:util";
/** Actual accounting outcome, shared by SQLite/QuickJS and native D1/Worker smoke. */
import { connectMcp } from "../support/mcp.js";
import type { Deployment } from "../deploy/node.js";
import { QB_COMPANIES } from "../deploy/quickbooks.js";
import { QB_PRIVATE } from "../fakes/quickbooks.js";
import type { World } from "../fakes/world.js";
import { check } from "./baseline.js";
import { deliveredValues } from "./correctness.js";
import type { ActiveTask, ReferenceContext } from "./types.js";

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** The operator follows real consent/callback routes; never calls connector auth hooks. */
export async function consent(origin: string, owner: "alice" | "bob", wrong = false, id = `qb_${owner}`) {
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

export async function readBob(deployment: Deployment) {
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
    const refused = await alice.call("execute_code", {
      code: 'async () => (await connecta.call("qb_bob.get_record", { entity: "invoices", id: "41" })).data',
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

/** Every prompt step by routes an agent would choose: the proof the task is passable as written. */
export async function followDossier(ctx: ReferenceContext) {
  const read = () => ctx.call("call_tool", { address: "qb_alice.get_company_info", args: {} });
  await ctx.nextTurn();
  const dossier = await ctx.call("execute_code", {
    code: `async () => {
      const call = async (tool, args = {}) => (await connecta.call("qb_alice." + tool, args)).data;
      const company = await call("get_company_info");
      const customers = await call("search_records", { entity: "customers", filters: [{ field: "DisplayName", operator: "eq", value: "Alice's \\\\ studio" }], limit: 10 });
      const customer = customers.items[0];
      const invoices = []; let cursor;
      do {
        const page = await call("search_records", { entity: "invoices", filters: [{ field: "CustomerRef", operator: "eq", value: customer.Id }], limit: 100, ...(cursor ? { cursor } : {}) });
        invoices.push(...page.items.map(i => ({ invoice: i.Id, version: i.SyncToken, customer: customer.DisplayName, currency: i.CurrencyRef.value, amount: i.TotalAmt })));
        cursor = page.page.nextCursor;
      } while (cursor);
      const profitAndLoss = await call("get_report", { report: "ProfitAndLoss", start_date: "2026-10-01", end_date: "2026-10-31" });
      return { source: "QuickBooks", company: company.CompanyName, customer: customer.DisplayName, invoices, profitAndLoss };
    }`,
  });
  requireThat(!dossier.isError, dossier.text);
  const answer = JSON.parse(dossier.text).result;
  for (let cycle = 0; cycle < 3; cycle++) {
    await ctx.nextTurn();
    requireThat(!(await read()).isError, "A renewal read failed");
  }
  await ctx.nextTurn();
  requireThat((await read()).isError, "A disconnected read succeeded");
  ctx.answer(
    "Her reads are refused now. The dossier from before she disconnected:\n```json\n" +
      JSON.stringify(answer, null, 2) +
      "\n```",
  );
}

const publicInvoices = (company: Record<string, any>) =>
  company.Invoice.map((r: Record<string, any>) => ({
    Name: "[redacted]",
    Id: r.Id,
    SyncToken: r.SyncToken,
    DocNumber: r.DocNumber,
    TotalAmt: r.TotalAmt,
    Balance: r.Balance,
    CustomerRef: r.CustomerRef,
    CurrencyRef: r.CurrencyRef,
  }));

/** Every leaf of a JSON value, so reduced or renamed output still counts. */
function leaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === "object") return Object.values(value).flatMap(leaves);
  return [value];
}

const sameFact = (leaf: unknown, fact: string | number) =>
  leaf === fact || (typeof leaf === "string" && leaf !== "" && Number(leaf) === Number(fact));

/** One record carries all of these facts together, however an agent named its fields. */
function carriesFacts(value: unknown, facts: (string | number)[]): boolean {
  const values = leaves(value);
  return facts.every((fact) => values.some((leaf) => sameFact(leaf, fact)));
}

/** All JSON objects in an agent's value, nearest the leaves included. */
function objectsIn(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (value && typeof value === "object")
    return [value as Record<string, unknown>, ...Object.values(value).flatMap(objectsIn)];
  return [];
}

/** A whole-message or fenced JSON answer, or the JSON that follows prose. */
export function jsonAnswer(text: string): Record<string, any> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const start = text.indexOf("{");
  for (const candidate of [text, fenced, start >= 0 ? text.slice(start, text.lastIndexOf("}") + 1) : undefined]) {
    try {
      const parsed = candidate === undefined ? undefined : JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* Try the next rendering. */
    }
  }
  return undefined;
}

/** The P&L labels and amounts, with the empty cell the prompt asks to keep. */
const REPORT_FACTS = ["Income", "Consulting", "375.50", "Total Income"];
const invoiceFacts = (invoice: Record<string, any>) => [
  invoice.Id,
  invoice.SyncToken,
  invoice.TotalAmt,
  invoice.CurrencyRef.value,
];

export const QUICKBOOKS_TASK: ActiveTask = {
  status: "active",
  id: "quickbooks-accounting-journey",
  title: "QuickBooks company close",
  introducedIn: "#703",
  measures: "Company-bound accounting joins, exact paging, reports, secrecy, durable rotating OAuth and isolation",
  world: { quickbooks: true },
  prompt:
    "QuickBooks is not connected yet; wait until told the operator has connected it. Then read Alice's QuickBooks company, all invoices for customer Alice's \\ studio, each invoice's Id, SyncToken, customer, currency and amount, and the October ProfitAndLoss hierarchy including empty cells. Return a JSON accounting dossier, sourced from QuickBooks. The operator will reconnect, restart and disconnect between turns.",
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
      prompt: "Another vendor hour passed; read Alice's company again so her credential renews and rotates.",
      before: async ({ world, deployment }) => restart(world, deployment),
    },
    {
      prompt: "The application restarted with the rotated grant; read Alice's company again so it renews.",
      before: async ({ world, deployment }) => restart(world, deployment),
    },
    {
      prompt:
        "Alice disconnected; confirm her reads are now refused, then finish by returning the complete JSON dossier you verified before she disconnected.",
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
    // Provider behaviour an agent has no reason to probe; the outcome gate holds it here.
    const seeded = ctx.world.quickbooks.state.companies[QB_COMPANIES.alice]!;
    const projected = publicInvoices(seeded)[0];
    requireThat(isDeepStrictEqual(answer.pages, [true, false]), "Lookahead paging did not end exactly");
    requireThat(
      isDeepStrictEqual(answer.invoices, publicInvoices(seeded)) && isDeepStrictEqual(answer.report, seeded.report),
      "Named reads lost invoice facts or the report tree",
    );
    requireThat(
      isDeepStrictEqual(answer.named, projected) &&
        isDeepStrictEqual(answer.hatch?.data?.Invoice, projected) &&
        isDeepStrictEqual(answer.fields, { Id: "41", SyncToken: "7", Name: "[redacted]" }) &&
        isDeepStrictEqual(answer.hatchFields?.data?.Invoice, { Id: "41", SyncToken: "7", Name: "[redacted]" }),
      "The public version did not survive named, hatch and fields projections",
    );
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
    const answer = jsonAnswer(trace.finalAnswer ?? "") ?? {};
    const answered = objectsIn(answer);
    const company = world.quickbooks.state.companies[QB_COMPANIES.alice]!;
    const calls = world.ledger.calls.filter((c) => c.service === "quickbooks");
    const reads = calls.filter((c) => c.outcome === "ok" && c.args.method === "GET");
    const expected = company.Invoice;
    const delivered = deliveredValues(trace);
    const deliveredObjects = delivered.filter((value) => value && typeof value === "object");
    const customerName = company.Customer[0]!.DisplayName as string;
    const grants = world.quickbooks.state.grants;
    const queries = reads
      .filter((c) => c.args.realm === QB_COMPANIES.alice && String(c.args.path).endsWith("/query"))
      .map((c) => String((c.args.query as Record<string, string>).query));
    return [
      check(
        "delivered-data",
        "Complete invoice facts and report hierarchy were delivered over MCP",
        // A program may reduce a row to the requested fields, so facts count, not its shape.
        expected.every((invoice: Record<string, any>) =>
          deliveredObjects.some(
            (row) =>
              Object.values(row as object).includes(invoice.Id) &&
              carriesFacts(row, invoiceFacts(invoice)) &&
              leaves(row).some((leaf) => leaf === invoice.CustomerRef.value || leaf === customerName),
          ),
        ) && REPORT_FACTS.every((fact) => delivered.includes(fact)),
      ),
      check(
        "correct-destination",
        "Both real company routes were read",
        queries.some((q) => q.startsWith("SELECT * FROM Customer")) &&
          queries.some((q) => q.startsWith("SELECT * FROM Invoice")) &&
          reads.some((c) => c.args.realm === QB_COMPANIES.bob) &&
          reads.some((c) => c.args.path === `/v3/company/${QB_COMPANIES.alice}/reports/ProfitAndLoss`),
      ),
      check(
        "answer-evidence",
        "Complete company, customer, invoice and report-hierarchy facts in a JSON dossier",
        /QuickBooks/i.test(trace.finalAnswer ?? "") &&
          leaves(answer).some((leaf) => leaf === QB_COMPANIES.alice || leaf === company.company.CompanyName) &&
          leaves(answer).includes(customerName) &&
          expected.every((invoice: Record<string, any>) =>
            answered.some((row) => Object.values(row).includes(invoice.Id) && carriesFacts(row, invoiceFacts(invoice))),
          ) &&
          REPORT_FACTS.every((fact) => leaves(answer).includes(fact)) &&
          leaves(answer).some((leaf) => leaf === "" || leaf === null),
      ),
      check(
        "privacy",
        "Private values and credentials reach neither the conversation nor the answer",
        !JSON.stringify(trace).includes(QB_PRIVATE) &&
          !/qb-(?:access|refresh)-|eval-qb-client-secret/.test(JSON.stringify(trace)) &&
          !JSON.stringify(answer).includes(QB_PRIVATE),
      ),
      check(
        "durable-rotation",
        "Spent refresh tokens replaced, persisted and isolated",
        grants.find((g) => g.realm === QB_COMPANIES.alice)?.generation === 4 &&
          grants.find((g) => g.realm === QB_COMPANIES.bob)?.generation === 1 &&
          calls.filter((c) => c.args.grant === "authorization_code").length === 2 &&
          calls.filter((c) => c.args.grant === "refresh_token").length === 5 &&
          calls.filter(
            (c) =>
              c.args.grant === "refresh_token" &&
              // Drop the per-world tag; saved results from before it carry none.
              String(c.args.refresh).replace(/\.[0-9a-f]{12}$/, "") === `qb-refresh-${QB_COMPANIES.alice}-0`,
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
