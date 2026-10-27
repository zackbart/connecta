/** Actual named writes, graded independently on vendor state and physical dispatches. */
import { isDeepStrictEqual as same } from "node:util";
import { QB_COMPANIES } from "../deploy/quickbooks.js";
import { QB_PRIVATE, quickbooksState } from "../fakes/quickbooks.js";
import { connectMcp } from "../support/mcp.js";
import { check } from "./baseline.js";
import { deliveredValues } from "./correctness.js";
import { consent, readBob } from "./quickbooks.js";
import type { ActiveTask } from "./types.js";

const invoiceArgs = (requestId: string, docNumber = "SERVICES-OK") => ({
  requestId,
  docNumber,
  customerId: "9",
  currency: "USD",
  exchangeRate: "1",
  txnDate: "2026-10-27",
  dueDate: "2026-11-27",
  lines: [
    { itemId: "7", amount: "19.99" },
    { itemId: "7", amount: "0.10" },
  ],
});
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

export const QUICKBOOKS_WRITE_TASK: ActiveTask = {
  status: "active",
  id: "quickbooks-write-journey",
  title: "QuickBooks names and unsent service invoices",
  introducedIn: "#703",
  measures: "Committed names, caller-observed CAS conflict, unsent invoices, no replay and read reconciliation",
  world: { quickbooks: true },
  deployment: { quickbooksWrites: true },
  prompt:
    "Create Workshop / Workshop LLC, race two sparse naming updates with its observed SyncToken, then create unsent USD service invoices. Reconcile failed write responses through actual reads. Never resend an ambiguous intent.",
  followUps: [
    {
      prompt: "The operator connected both companies.",
      before: async ({ world, deployment }) => {
        await consent(deployment.origin, "alice");
        await consent(deployment.origin, "bob");
        await readBob(deployment);
        await consent(deployment.origin, "alice", false, "qb_budget_1");
        await consent(deployment.origin, "alice", false, "qb_budget_4");
        // The writable connector is still restricted by its read-only pool.
        const session = await connectMcp(`${deployment.origin}/mcp/readonly`, { Authorization: "Bearer eval-alice" });
        try {
          const before = world.ledger.calls.length;
          for (const [tool, args] of [
            [
              "call_destructive_tool",
              { address: "qb_alice.create_customer", args: { requestId: "pool-refused", DisplayName: "Forbidden" } },
            ],
            [
              "execute_code",
              {
                code: 'async () => connecta.call("qb_alice.create_customer", { requestId: "pool-program-refused", DisplayName: "Forbidden" })',
              },
            ],
          ] as const) {
            const reply = await session.call(tool, args);
            assert(reply.isError && /read_only_endpoint/.test(reply.text), `Pool policy: ${reply.text}`);
          }
          assert(world.ledger.calls.length === before, "Read-only pool called Intuit");
        } finally {
          await session.close();
        }
      },
    },
    {
      prompt: "The operator made the endpoint read-only.",
      before: async ({ deployment }) => {
        assert(deployment.restart, "Requires application reconstruction");
        await deployment.restart!(true);
        await readBob(deployment);
      },
    },
  ],
  async reference(ctx) {
    await ctx.nextTurn();
    const write = (tool: string, args: Record<string, unknown>) =>
      ctx.call("call_destructive_tool", { address: `qb_alice.${tool}`, args });
    const read = async (tool: string, args: Record<string, unknown>) => {
      const reply = await ctx.call("call_tool", { address: `qb_alice.${tool}`, args });
      assert(!reply.isError, reply.text);
      return JSON.parse(reply.text);
    };
    const data = (reply: any) => reply.data ?? reply;
    const answer: Record<string, any> = { source: "QuickBooks" };
    // Default and explicit readOnly, arbitrary writes, unreviewed hatch, malformed arguments.
    const before = ctx.world.ledger.calls.length;
    for (const address of [
      "qb_readonly_0.create_customer",
      "qb_readonly_1.create_customer",
      "qb_alice.quickbooks_api_write",
      "qb_alice.update_invoice",
    ]) {
      const reply = await ctx.call("call_destructive_tool", {
        address,
        args: { requestId: "forbidden", DisplayName: "Forbidden", path: "/invoice", body: {} },
      });
      assert(reply.isError, `Unexpected write: ${address}`);
    }
    for (const args of [
      { requestId: "bad", DisplayName: "Workshop", PrimaryEmailAddr: { Address: "contact@example.test" } },
      { requestId: "bad id", DisplayName: "Workshop" },
    ])
      assert((await write("create_customer", args)).isError, "Malformed customer accepted");
    for (const args of [
      { ...invoiceArgs("bad-date"), txnDate: "2026-02-30" },
      { ...invoiceArgs("bad-amount"), lines: [{ itemId: "7", amount: "0.00" }] },
      { ...invoiceArgs("bad-email"), EmailStatus: "NeedToSend" },
    ])
      assert((await write("create_invoice", args)).isError, "Malformed invoice accepted");
    assert(ctx.world.ledger.calls.length === before, "Malformed/refused intent reached Intuit");

    const created = await write("create_customer", {
      requestId: "customer-create",
      DisplayName: "Workshop",
      CompanyName: "Workshop LLC",
    });
    assert(!created.isError, created.text);
    // The caller actually reads its version, then starts both competing updates concurrently.
    answer.customerBefore = data(await read("get_record", { entity: "customers", id: "51" }));
    const race = await ctx.call("execute_code", {
      code: `async () => {
      const observed = (await connecta.call("qb_alice.get_record", { entity: "customers", id: "51" })).data;
      return await Promise.all(["A", "B"].map(async suffix => {
        try { return { suffix, value: (await connecta.call("qb_alice.update_customer", { requestId: "customer-race-" + suffix, Id: observed.Id, SyncToken: observed.SyncToken, DisplayName: "Workshop " + suffix })).data }; }
        catch (error) { return { suffix, error: { code: error.code, message: error.message, retryable: error.retryable } }; }
      }));
    }`,
    });
    assert(!race.isError, race.text);
    answer.race = JSON.parse(race.text).result;
    answer.customer = data(await read("get_record", { entity: "customers", id: "51" }));
    answer.customerHatch = data(await read("quickbooks_api_read", { path: "/customer/51" }));
    answer.customerFields = data(
      await read("get_record", { entity: "customers", id: "51", fields: ["Id", "SyncToken", "Name"] }),
    );
    answer.customerSearch = data(
      await read("search_records", {
        entity: "customers",
        filters: [{ field: "DisplayName", operator: "eq", value: answer.customer.DisplayName }],
      }),
    );

    // Preflight failures exercise actual published reads but must never reach POST.
    const company = ctx.world.quickbooks.state.companies[QB_COMPANIES.alice]!;
    for (const country of ["CA", "US"]) {
      const oldId = company.company.Id;
      company.company.Country = country;
      if (country === "US") company.company.Id = QB_COMPANIES.bob;
      assert((await write("create_invoice", invoiceArgs("bad-company"))).isError, "Wrong company accepted");
      company.company.Id = oldId;
    }
    for (const customerId of ["10", "11"])
      assert(
        (await write("create_invoice", { ...invoiceArgs("bad-customer"), customerId })).isError,
        "Customer preflight bypassed",
      );
    for (const itemId of ["8", "10"])
      assert(
        (await write("create_invoice", { ...invoiceArgs("bad-item"), lines: [{ itemId, amount: "19.99" }] })).isError,
        "Service preflight bypassed",
      );

    const goodInvoice = await write("create_invoice", invoiceArgs("invoice-create"));
    assert(!goodInvoice.isError, goodInvoice.text);
    answer.invoice = data(JSON.parse(goodInvoice.text));
    // Four bounded failures; committed failures are reconciled, never resent.
    ctx.world.quickbooks.state.failures = {
      "customer-401": "401",
      "customer-transport": "transport",
      "customer-malformed": "malformed",
      "invoice-recover": "500",
      "invoice-contradictory": "contradictory",
      "invoice-invalid-rate": "invalid-rate",
    };
    answer.failures = [];
    for (const [requestId, DisplayName] of [
      ["customer-401", "Unauthorized"],
      ["customer-transport", "Transport"],
      ["customer-malformed", "Malformed"],
    ]) {
      const reply = await write("create_customer", { requestId, DisplayName });
      assert(reply.isError && /unknown/.test(reply.text), `Failure not ambiguous: ${reply.text}`);
      answer.failures.push(JSON.parse(reply.text));
      if (requestId !== "customer-401")
        await read("search_records", {
          entity: "customers",
          filters: [{ field: "DisplayName", operator: "eq", value: DisplayName }],
        });
    }
    const failedInvoice = await write("create_invoice", invoiceArgs("invoice-recover", "SERVICES-RECOVER"));
    assert(failedInvoice.isError && /unknown/.test(failedInvoice.text), `Lost invoice reply: ${failedInvoice.text}`);
    answer.failures.push(JSON.parse(failedInvoice.text));
    answer.recovered = data(
      await read("search_records", {
        entity: "invoices",
        filters: [{ field: "DocNumber", operator: "eq", value: "SERVICES-RECOVER" }],
      }),
    );
    answer.invoiceHatch = data(await read("quickbooks_api_read", { path: "/invoice/62" }));
    answer.invoiceFields = data(
      await read("quickbooks_api_read", {
        path: "/invoice/62",
        fields: ["Invoice.Id", "Invoice.SyncToken", "Invoice.Name", "Invoice.TotalAmt"],
      }),
    );
    answer.contradictions = [];
    for (const [requestId, label] of [
      ["invoice-contradictory", "SERVICES-CONTRADICT"],
      ["invoice-invalid-rate", "SERVICES-RATE"],
    ]) {
      const failed = await write("create_invoice", invoiceArgs(requestId!, label));
      assert(failed.isError && /unknown/.test(failed.text), `Contradictory success accepted: ${failed.text}`);
      answer.failures.push(JSON.parse(failed.text));
      answer.contradictions.push(
        data(
          await read("search_records", {
            entity: "invoices",
            filters: [{ field: "DocNumber", operator: "eq", value: label }],
          }),
        ),
      );
    }
    const budgetStart = ctx.world.ledger.calls.length;
    const limited = await ctx.call("call_destructive_tool", {
      address: "qb_budget_1.create_invoice",
      args: invoiceArgs("invoice-budget-refused", "SERVICES-BUDGET"),
    });
    assert(limited.isError && /rate_limited/.test(limited.text), `Budget bypassed: ${limited.text}`);
    assert(
      same(
        ctx.world.ledger.calls.slice(budgetStart).map((c) => [c.args.method, c.args.path]),
        [["GET", `/v3/company/${QB_COMPANIES.alice}/companyinfo/${QB_COMPANIES.alice}`]],
      ),
      "Exhausted invoice budget dispatched beyond first company read",
    );
    const enough = await ctx.call("call_destructive_tool", {
      address: "qb_budget_4.create_invoice",
      args: invoiceArgs("invoice-budget", "SERVICES-BUDGET"),
    });
    assert(!enough.isError, `Sufficient budget failed: ${enough.text}`);
    answer.budgetInvoice = data(JSON.parse(enough.text));
    // Published Bob endpoint has its own personal credential and company.
    await ctx.nextTurn();
    const refusedAt = ctx.world.ledger.calls.length;
    for (const tool of ["create_customer", "update_customer", "create_invoice"]) {
      const reply = await write(tool, { requestId: "endpoint-refused" });
      assert(reply.isError && /read_only_endpoint/.test(reply.text), `Endpoint policy: ${reply.text}`);
    }
    assert(ctx.world.ledger.calls.length === refusedAt, "Read-only endpoint called Intuit");
    ctx.answer(JSON.stringify(answer));
  },
  grade({ world, trace }) {
    let answer: Record<string, any> = {};
    try {
      answer = JSON.parse(trace.finalAnswer ?? "");
    } catch {
      /* No answer fails below. */
    }
    const company = world.quickbooks.state.companies[QB_COMPANIES.alice]!;
    const bob = world.quickbooks.state.companies[QB_COMPANIES.bob]!;
    const seed = quickbooksState().companies;
    const calls = world.ledger.calls.filter((c) => c.service === "quickbooks");
    const writes = calls.filter((c) => c.kind === "write");
    const customer = company.Customer.find((r) => r.Id === "51");
    const labels = ["SERVICES-OK", "SERVICES-RECOVER", "SERVICES-CONTRADICT", "SERVICES-RATE", "SERVICES-BUDGET"];
    const invoices = company.Invoice.filter((r) => labels.includes(r.DocNumber));
    const ids = [
      "customer-create",
      "customer-race-A",
      "customer-race-B",
      "invoice-create",
      "customer-401",
      "customer-transport",
      "customer-malformed",
      "invoice-recover",
      "invoice-contradictory",
      "invoice-invalid-rate",
      "invoice-budget",
    ];
    const invoiceIntents = [
      "invoice-create",
      "invoice-recover",
      "invoice-contradictory",
      "invoice-invalid-rate",
      "invoice-budget",
    ];
    const sent = (id: string) => writes.find((c) => (c.args.query as Record<string, string>).requestid === id);
    const winners = (answer.race ?? []).filter((r: any) => r.value);
    const losers = (answer.race ?? []).filter((r: any) => r.error);
    const projection = (row: Record<string, any> | undefined) =>
      row &&
      Object.fromEntries(
        Object.entries(row)
          .filter(([key]) => !["PrimaryEmailAddr"].includes(key))
          .concat([["Name", "[redacted]"]]),
      );
    const traceText = JSON.stringify(trace);
    const delivered = deliveredValues(trace);
    return [
      check(
        "delivered-data",
        "Observed customer version and every committed invoice were delivered over MCP",
        customer !== undefined &&
          delivered.some(
            (row) => row?.Id === customer.Id && row.SyncToken === "1" && row.DisplayName === customer.DisplayName,
          ) &&
          invoices.length === 5 &&
          invoices.every((invoice) =>
            delivered.some(
              (row) =>
                row?.Id === invoice.Id &&
                row.SyncToken === invoice.SyncToken &&
                row.DocNumber === invoice.DocNumber &&
                row.CustomerRef?.value === invoice.CustomerRef.value &&
                row.CurrencyRef?.value === invoice.CurrencyRef.value &&
                row.TxnDate === invoice.TxnDate &&
                row.DueDate === invoice.DueDate &&
                row.TotalAmt === invoice.TotalAmt,
            ),
          ),
      ),
      check(
        "physical-intents",
        "Exactly one physical POST per intent, exact realm and requestid",
        writes.length === ids.length &&
          ids.every(
            (id) => writes.filter((c) => (c.args.query as Record<string, string>).requestid === id).length === 1,
          ) &&
          writes.every(
            (c) =>
              c.args.realm === QB_COMPANIES.alice &&
              c.args.method === "POST" &&
              c.args.path ===
                `/v3/company/${QB_COMPANIES.alice}/${(c.args.query as any).requestid.startsWith("invoice-") ? "invoice" : "customer"}` &&
              same(Object.keys(c.args.query as object).sort(), ["minorversion", "requestid"]) &&
              (c.args.query as any).minorversion === "75",
          ),
      ),
      check(
        "customer-state",
        "Exact committed names and preserved omitted company; one CAS winner",
        same(company.Customer.slice(0, 3), seed[QB_COMPANIES.alice]!.Customer) &&
          same(company.Invoice.slice(0, 3), seed[QB_COMPANIES.alice]!.Invoice) &&
          same(company.company, seed[QB_COMPANIES.alice]!.company) &&
          same(company.Customer.slice(3), [
            {
              ...seed[QB_COMPANIES.alice]!.Customer[0],
              Id: "51",
              SyncToken: "1",
              DisplayName: customer?.DisplayName,
              CompanyName: "Workshop LLC",
            },
            { ...seed[QB_COMPANIES.alice]!.Customer[0], Id: "52", SyncToken: "0", DisplayName: "Transport" },
            { ...seed[QB_COMPANIES.alice]!.Customer[0], Id: "53", SyncToken: "0", DisplayName: "Malformed" },
          ]) &&
          customer?.SyncToken === "1" &&
          ["Workshop A", "Workshop B"].includes(customer.DisplayName) &&
          customer.CompanyName === "Workshop LLC" &&
          same(answer.customer, projection(customer)) &&
          same(answer.customerBefore, {
            Id: "51",
            SyncToken: "0",
            Active: true,
            CurrencyRef: { value: "USD" },
            DisplayName: "Workshop",
            CompanyName: "Workshop LLC",
            Name: "[redacted]",
          }) &&
          same(sent("customer-create")?.args.body, { DisplayName: "Workshop", CompanyName: "Workshop LLC" }) &&
          ["A", "B"].every((suffix) =>
            same(sent(`customer-race-${suffix}`)?.args.body, {
              Id: "51",
              SyncToken: "0",
              sparse: true,
              DisplayName: `Workshop ${suffix}`,
            }),
          ) &&
          writes.filter((c) => c.args.status === 400).length === 1 &&
          winners.length === 1 &&
          losers.length === 1 &&
          winners[0].value.SyncToken === "1" &&
          customer.DisplayName === `Workshop ${winners[0].suffix}` &&
          /conflict|SyncToken is stale/.test(JSON.stringify(losers[0])),
      ),
      check(
        "invoice-state",
        "Real unsent invoices, vendor tax/rounding, no duplicate after failed/contradictory responses",
        invoices.length === 5 &&
          company.Invoice.length === 8 &&
          same(
            invoices,
            invoiceIntents.map((id, index) => ({
              ...seed[QB_COMPANIES.alice]!.Invoice[0],
              ...(sent(id)?.args.body as object),
              Id: String(61 + index),
              SyncToken: "0",
              TotalAmt: 21.75,
              Balance: 21.75,
              TxnTaxDetail: { TotalTax: 1.66 },
              sent: false,
              Line: [
                ...[0.1, 19.99].map((Amount) => ({
                  Amount,
                  DetailType: "SalesItemLineDetail",
                  SalesItemLineDetail: { ItemRef: { value: "7" }, Qty: 1, UnitPrice: Amount },
                })),
                { Amount: 20.09, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} },
              ],
            })),
          ) &&
          answer.invoice?.TotalAmt === 21.75 &&
          answer.recovered?.items?.length === 1 &&
          answer.recovered.items[0].Id === "62" &&
          answer.recovered.items[0].TotalAmt === 21.75 &&
          calls.some(
            (c) =>
              c.args.method === "GET" &&
              (c.args.query as any).query ===
                "SELECT * FROM Invoice WHERE DocNumber = 'SERVICES-RECOVER' STARTPOSITION 1 MAXRESULTS 26",
          ),
      ),
      check(
        "invoice-body",
        "Exact dates, units, decimal amounts and immutable no-send controls",
        invoiceIntents.every((id, index) =>
          same(sent(id)?.args.body, {
            CustomerRef: { value: "9" },
            CurrencyRef: { value: "USD" },
            ExchangeRate: 1,
            TxnDate: "2026-10-27",
            DueDate: "2026-11-27",
            DocNumber: labels[index],
            Line: [19.99, 0.1].map((Amount) => ({
              Amount,
              DetailType: "SalesItemLineDetail",
              SalesItemLineDetail: { ItemRef: { value: "7" }, Qty: 1, UnitPrice: Amount },
            })),
            EmailStatus: "NotSet",
            AllowIPNPayment: false,
            AllowOnlinePayment: false,
            AllowOnlineCreditCardPayment: false,
            AllowOnlineACHPayment: false,
            AllowOnlinePayPalPayment: false,
            AllowOnlineAffirmPayment: false,
          }),
        ) && calls.every((c) => !String(c.args.path).includes("/send")),
      ),
      check(
        "unknown-no-replay",
        "401, broken transport, 5xx and malformed success are nonretryable and reconciled",
        [
          "customer-401",
          "customer-transport",
          "customer-malformed",
          "invoice-recover",
          "invoice-contradictory",
          "invoice-invalid-rate",
        ].every((id) => sent(id)?.args.failure) &&
          sent("customer-401")?.args.committed === false &&
          [
            "customer-transport",
            "customer-malformed",
            "invoice-recover",
            "invoice-contradictory",
            "invoice-invalid-rate",
          ].every((id) => sent(id)?.args.committed === true) &&
          answer.failures?.length === 6 &&
          answer.failures.every(
            (r: any) => /unknown/.test(JSON.stringify(r)) && /"retryable":false/.test(JSON.stringify(r)),
          ) &&
          [
            ["customer-401", "Unauthorized"],
            ["customer-transport", "Transport"],
            ["customer-malformed", "Malformed"],
          ].every(([id, DisplayName]) => same(sent(id!)?.args.body, { DisplayName })) &&
          ["Transport", "Malformed"].every(
            (name) =>
              company.Customer.filter((r) => r.DisplayName === name).length === 1 &&
              calls.some(
                (c) =>
                  (c.args.query as any).query ===
                  `SELECT * FROM Customer WHERE DisplayName = '${name}' STARTPOSITION 1 MAXRESULTS 26`,
              ),
          ),
      ),
      check(
        "budget",
        "One concurrency slot charges every sequential request; exhausted budget stops before POST",
        same(
          calls
            .filter((c) => c.args.authGrant === 2 && String(c.args.path).startsWith("/v3/"))
            .map((c) => [c.args.method, c.args.path]),
          [["GET", `/v3/company/${QB_COMPANIES.alice}/companyinfo/${QB_COMPANIES.alice}`]],
        ) &&
          same(
            calls
              .filter((c) => c.args.authGrant === 3 && String(c.args.path).startsWith("/v3/"))
              .map((c) => [c.args.method, String(c.args.path).split("/").slice(4).join("/")]),
            [
              ["GET", `companyinfo/${QB_COMPANIES.alice}`],
              ["GET", "customer/9"],
              ["GET", "item/7"],
              ["POST", "invoice"],
            ],
          ) &&
          trace.toolUses.some(
            (u) =>
              u.input.address === "qb_budget_1.create_invoice" && u.isError && /rate_limited/.test(u.resultText ?? ""),
          ) &&
          answer.budgetInvoice?.Id === "65" &&
          answer.budgetInvoice?.TotalAmt === 21.75,
      ),
      check(
        "contradictions",
        "Committed contradictory 200 replies are unknown; reads recover the original intent without another invoice",
        answer.contradictions?.length === 2 &&
          answer.contradictions.every(
            (r: any, index: number) =>
              r.items?.length === 1 &&
              r.items[0].Id === String(63 + index) &&
              r.items[0].CustomerRef.value === "9" &&
              r.items[0].CurrencyRef.value === "USD" &&
              r.items[0].DocNumber === labels[index + 2] &&
              r.items[0].ExchangeRate === 1 &&
              r.items[0].TotalAmt === 21.75,
          ),
      ),
      check(
        "refusal",
        "Read-only, arbitrary writes, malformed and preflight inputs cannot POST",
        trace.toolUses.filter((u) => u.isError).length >= 20 &&
          [
            "qb_readonly_0.create_customer",
            "qb_readonly_1.create_customer",
            "qb_alice.quickbooks_api_write",
            "qb_alice.update_invoice",
          ].every((address) => trace.toolUses.some((u) => u.input.address === address && u.isError)) &&
          trace.toolUses.filter((u) => /read_only_endpoint/.test(u.resultText ?? "")).length >= 5 &&
          calls.filter((c) => c.args.method === "GET" && String(c.args.path).endsWith("/item/7")).length === 5,
      ),
      check(
        "privacy",
        "Private vendor values/errors and credentials withheld on all paths; versions public",
        !traceText.includes(QB_PRIVATE) &&
          !/qb-(?:access|refresh)-|eval-qb-client-secret/.test(traceText) &&
          same(answer.customerHatch?.Customer, projection(customer)) &&
          same(answer.customerFields, { Id: "51", SyncToken: "1", Name: "[redacted]" }) &&
          same(answer.customerSearch?.items, [projection(customer)]) &&
          answer.invoiceHatch?.Invoice?.TxnTaxDetail?.TotalTax === 1.66 &&
          same(answer.invoiceFields?.Invoice, { Id: "62", SyncToken: "0", Name: "[redacted]", TotalAmt: 21.75 }),
      ),
      check(
        "company-isolation",
        "Only Alice mutated, Bob's independent company and personal grant survive",
        same(bob, seed[QB_COMPANIES.bob]) &&
          calls.some((c) => c.args.realm === QB_COMPANIES.bob && c.args.method === "GET") &&
          world.quickbooks.state.grants.length === 4 &&
          world.quickbooks.state.grants.every((g) => !g.revoked),
      ),
    ];
  },
};
