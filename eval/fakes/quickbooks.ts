/** Small stateful Intuit stand-in: exact query fixtures, no SQL parser or vendor network. */
import { serveFetch, type Served } from "../support/serve.js";
import type { Ledger } from "./service.js";
import { randomBytes } from "node:crypto";
import { QB_CLIENT, QB_SECRET, QB_COMPANIES, QB_HOSTS } from "../deploy/quickbooks.js";
import { routeFakeVendor } from "./transport.js";

type Row = Record<string, any>;
export const QB_PRIVATE = "private-bank-card-tax-contact";
const invoice = (Id: string, customer: string, TotalAmt: number): Row => ({
  Id,
  SyncToken: "7",
  DocNumber: `INV-${Id}`,
  TotalAmt,
  Balance: TotalAmt,
  CustomerRef: { value: customer },
  CurrencyRef: { value: "USD" },
  BillEmail: { Address: QB_PRIVATE },
  TaxIdentifier: QB_PRIVATE,
  PrivateNote: QB_PRIVATE,
  InvoiceLink: `https://example.test/pay?token=${QB_PRIVATE}`,
  CreditCardPayment: { CreditChargeResponse: { CCTransId: QB_PRIVATE } },
});
const report = {
  Header: { ReportName: "ProfitAndLoss", Currency: "USD", ReportBasis: "Accrual" },
  Columns: {
    Column: [
      { ColTitle: "Account", ColType: "Account" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        group: "Income",
        Header: { ColData: [{ value: "Income" }, { value: "" }] },
        Rows: { Row: [{ ColData: [{ value: "Consulting", id: "6" }, { value: "375.50" }] }] },
        Summary: { ColData: [{ value: "Total Income" }, { value: "375.50" }] },
      },
    ],
  },
};
export const quickbooksState = () => ({
  /** Per-world OAuth client and token suffix: concurrent worlds never share a credential. */
  clientId: `${QB_CLIENT}-${randomBytes(6).toString("hex")}`,
  tag: randomBytes(6).toString("hex"),
  companies: Object.fromEntries(
    Object.entries(QB_COMPANIES).map(([owner, realm]) => [
      realm,
      {
        owner,
        company: { Id: realm, Country: "US", CompanyName: `${owner} books`, EmployerId: QB_PRIVATE },
        // Vendor fixture settings, not provider-computed totals. Stored contact + company autosend opt-in
        // deliberately make omission of the request-level no-send controls observable.
        autoSend: true,
        taxBasisPoints: 825,
        Item: [
          { Id: "7", Active: true, Type: "Service", Name: "Consulting" },
          { Id: "8", Active: true, Type: "Inventory", Name: "Stock" },
          { Id: "10", Active: false, Type: "Service", Name: "Retired" },
        ] as Row[],
        Customer: [
          {
            Id: "9",
            Active: true,
            CurrencyRef: { value: "USD" },
            DisplayName: "Alice's \\ studio",
            SyncToken: "2",
            PrimaryEmailAddr: { Address: QB_PRIVATE },
          },
          { Id: "10", Active: false, CurrencyRef: { value: "USD" }, DisplayName: "Inactive" },
          { Id: "11", Active: true, CurrencyRef: { value: "EUR" }, DisplayName: "Euro" },
        ] as Row[],
        Invoice:
          owner === "alice"
            ? [invoice("41", "9", 125.5), invoice("42", "9", 150), invoice("43", "9", 100)]
            : [invoice("41", "9", 999)],
        report: structuredClone(report),
      },
    ]),
  ),
  failures: {} as Record<string, "401" | "transport" | "500" | "malformed" | "contradictory" | "invalid-rate">,
  hour: 0,
  grants: [] as Array<{
    realm: string;
    access: string;
    refresh: string;
    generation: number;
    expired: boolean;
    revoked: boolean;
  }>,
});
export class FakeQuickBooks {
  readonly state = quickbooksState();
  private server?: Served;
  private release: (() => void) | undefined;
  /** Every token this world issued, so spent and revoked ones still reach its 401s. */
  private readonly issued = new Set<string>();
  constructor(private readonly ledger: Ledger) {}
  get url() {
    return this.server!.url;
  }
  get clientId() {
    return this.state.clientId;
  }
  async start() {
    this.server = await serveFetch((r) => this.fetch(r));
    this.release = routeFakeVendor({
      hosts: QB_HOSTS,
      owns: (credential) => credential === this.clientId || this.issued.has(credential),
      target: this.url,
      stampVendorOrigin: true,
    });
  }
  async stop() {
    this.release?.();
    this.release = undefined;
    await this.server?.close();
  }
  private token(kind: "access" | "refresh", realm: string, generation: number, suffix = "") {
    const value = `qb-${kind}-${realm}-${generation}${suffix}.${this.state.tag}`;
    this.issued.add(value);
    return value;
  }
  expire() {
    this.state.hour++;
    for (const grant of this.state.grants) grant.expired = true;
  }
  private async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawBody = request.method === "POST" ? await request.text() : "";
    const body = new URLSearchParams(rawBody);
    const auth = request.headers.get("authorization");
    let payload: Row | undefined;
    let failure: string | undefined;
    let committed = false;
    let tokenGrant: (typeof this.state.grants)[number] | undefined;
    let result: unknown;
    let status = 200;
    let realm = "";
    if (url.pathname.startsWith("/.well-known/openid")) {
      result = {
        issuer: "https://oauth.platform.intuit.com/op/v1",
        authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2",
        token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
        response_types_supported: ["code"],
        scopes_supported: ["com.intuit.quickbooks.accounting"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        revocation_endpoint_auth_methods_supported: ["client_secret_basic"],
      };
    } else if (url.pathname === "/v2/oauth2/tokens/revoke") {
      let json: Row = {};
      try {
        json = JSON.parse(rawBody);
      } catch {
        /* A form request must fail. */
      }
      const grant = this.state.grants.find((g) => g.refresh === json?.token);
      if (
        auth !== `Basic ${btoa(`${this.clientId}:${QB_SECRET}`)}` ||
        !grant ||
        request.headers.get("accept") !== "application/json" ||
        request.headers.get("content-type") !== "application/json" ||
        Object.keys(json).length !== 1 ||
        !Object.hasOwn(json, "token")
      )
        status = 400;
      else {
        grant.revoked = true;
        realm = grant.realm;
      }
      result = {};
    } else if (url.pathname === "/oauth2/v1/tokens/bearer") {
      if (auth !== `Basic ${btoa(`${this.clientId}:${QB_SECRET}`)}`) status = 401;
      else if (body.get("grant_type") === "authorization_code") {
        realm = body.get("code") ?? "";
        if (!this.state.companies[realm]) status = 400;
        else {
          const suffix = this.state.grants.some((g) => g.realm === realm) ? `-${this.state.grants.length}` : "";
          this.state.grants.push({
            realm,
            access: this.token("access", realm, 0, suffix),
            refresh: this.token("refresh", realm, 0, suffix),
            generation: 0,
            expired: false,
            revoked: false,
          });
          tokenGrant = this.state.grants.at(-1);
        }
      } else {
        const grant = this.state.grants.find((g) => g.refresh === body.get("refresh_token") && !g.revoked);
        if (!grant) status = 400;
        else {
          tokenGrant = grant;
          realm = grant.realm;
          grant.generation++;
          grant.access = this.token("access", realm, grant.generation);
          // Intuit may return identical refresh bytes for two hourly renewals.
          if (realm !== QB_COMPANIES.alice || grant.generation > 2)
            grant.refresh = this.token("refresh", realm, grant.generation);
          grant.expired = false;
        }
      }
      const grant = tokenGrant;
      result =
        status === 200 && grant
          ? { access_token: grant.access, refresh_token: grant.refresh, expires_in: 3600, token_type: "bearer" }
          : { error: "invalid_grant" };
    } else {
      const match = /^\/v3\/company\/(\d+)(\/.*)$/.exec(url.pathname);
      realm = match?.[1] ?? "";
      const path = match?.[2] ?? "";
      const grant = this.state.grants.find(
        (g) => auth === `Bearer ${g.access}` && g.realm === realm && !g.expired && !g.revoked,
      );
      const company = this.state.companies[realm];
      if (!grant || !company) status = 401;
      else if (
        url.searchParams.get("minorversion") !== "75" ||
        !["GET", "POST"].includes(request.method) ||
        request.headers.get("x-eval-vendor-origin") !==
          (realm === QB_COMPANIES.alice
            ? "https://sandbox-quickbooks.api.intuit.com"
            : "https://quickbooks.api.intuit.com")
      )
        status = 400;
      else if (request.method === "POST") {
        try {
          payload = JSON.parse(rawBody);
        } catch {
          status = 400;
        }
        const requestId = url.searchParams.get("requestid") ?? "";
        failure = this.state.failures[requestId];
        delete this.state.failures[requestId];
        if (failure === "401") status = 401;
        else if (!requestId || !payload || !["/customer", "/invoice"].includes(path)) status = 400;
        else if (path === "/customer") {
          const current = company.Customer.find((r: Row) => r.Id === payload!.Id);
          if (payload.Id && (!current || current.SyncToken !== payload.SyncToken)) {
            status = 400;
            result = { Fault: { Error: [{ code: "5010", Message: QB_PRIVATE, Detail: auth }] } };
          } else if (payload.Id && payload.sparse !== true) status = 400;
          else {
            const row = current ?? {
              Id: String(51 + company.Customer.length - 3),
              SyncToken: "0",
              Active: true,
              CurrencyRef: { value: "USD" },
              PrimaryEmailAddr: { Address: QB_PRIVATE },
            };
            row.DisplayName = payload.DisplayName;
            if (payload.CompanyName !== undefined) row.CompanyName = payload.CompanyName;
            if (current) row.SyncToken = String(Number(row.SyncToken) + 1);
            else company.Customer.push(row);
            result = { Customer: row };
            committed = true;
          }
        } else {
          const customer = company.Customer.find((r: Row) => r.Id === payload!.CustomerRef?.value);
          const cents = (value: number) => Math.round(value * 100);
          const subtotal = payload.Line.reduce((sum: number, line: Row) => sum + cents(line.Amount), 0);
          const tax = Math.round((subtotal * company.taxBasisPoints) / 10000);
          const row = {
            ...invoice(String(61 + company.Invoice.length - 3), customer!.Id, (subtotal + tax) / 100),
            ...payload,
            SyncToken: "0",
            // Vendor may reorder services and append a computed subtotal; intent comparison is not positional.
            Line: [...payload.Line]
              .reverse()
              .concat([{ Amount: subtotal / 100, DetailType: "SubTotalLineDetail", SubTotalLineDetail: {} }]),
            TxnTaxDetail: { TotalTax: tax / 100 },
            sent:
              company.autoSend &&
              !!customer!.PrimaryEmailAddr &&
              (payload.EmailStatus === "NeedToSend" ||
                payload.AllowOnlineCreditCardPayment !== false ||
                payload.AllowOnlineACHPayment !== false),
          };
          company.Invoice.push(row);
          result = { Invoice: row };
          committed = true;
        }
        if (failure === "500") {
          status = 500;
          result = { Fault: { Error: [{ code: "private", Message: QB_PRIVATE, Detail: auth }] } };
        }
        if (failure === "malformed") result = { private: QB_PRIVATE, credential: auth };
        // Corrupt only the POST reply. The actual committed invoice remains readable.
        if (failure === "contradictory")
          result = {
            Invoice: {
              ...(result as Row).Invoice,
              CustomerRef: { value: "999" },
              CurrencyRef: { value: "EUR" },
              DocNumber: "OTHER-INTENT",
            },
          };
        if (failure === "invalid-rate")
          result = { Invoice: { ...(result as Row).Invoice, ExchangeRate: "not-a-number" } };
      } else if (path === `/companyinfo/${realm}`) result = { CompanyInfo: company.company };
      else if (path === "/query") {
        const query = url.searchParams.get("query");
        // A finite set of independently authored fixture requests. Unexpected SQL fails.
        const queries: Record<string, unknown> = {
          "SELECT * FROM Customer WHERE DisplayName = 'Alice\\'s \\\\ studio' STARTPOSITION 1 MAXRESULTS 2": {
            Customer: company.Customer.slice(0, 1),
          },
          "SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION 1 MAXRESULTS 3": {
            Invoice: company.Invoice.slice(0, 3),
          },
          "SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION 3 MAXRESULTS 3": {
            Invoice: company.Invoice.slice(2, 5),
          },
        };
        for (const name of ["Workshop", "Workshop A", "Workshop B", "Transport", "Malformed"]) {
          queries[`SELECT * FROM Customer WHERE DisplayName = '${name}' STARTPOSITION 1 MAXRESULTS 26`] = {
            Customer: company.Customer.filter((r: Row) => r.DisplayName === name),
          };
        }
        for (const label of ["SERVICES-OK", "SERVICES-RECOVER", "SERVICES-CONTRADICT", "SERVICES-RATE"]) {
          queries[`SELECT * FROM Invoice WHERE DocNumber = '${label}' STARTPOSITION 1 MAXRESULTS 26`] = {
            Invoice: company.Invoice.filter((r: Row) => r.DocNumber === label),
          };
        }
        if (!query || !queries[query]) status = 400;
        else result = { QueryResponse: queries[query] };
      } else if (/^\/(invoice|customer|item)\/\d+$/.test(path)) {
        const entity = { invoice: "Invoice", customer: "Customer", item: "Item" }[path.split("/")[1]!]!;
        const row = company[entity as "Invoice" | "Customer" | "Item"].find((r: Row) => r.Id === path.split("/")[2]);
        if (row) result = { [entity]: row };
        else status = 400;
      } else if (path === "/reports/ProfitAndLoss") result = company.report;
      else status = 404;
    }
    // Echo the credential into an otherwise public field: the output boundary
    // must redact sent secrets before named, hatch or fields projections.
    if (result && typeof result === "object") {
      const root = result as Row;
      const withEcho = (row: Row) => ({ ...row, Name: auth?.slice(7) });
      for (const entity of ["Invoice", "Customer", "Item"]) if (root[entity]) root[entity] = withEcho(root[entity]);
      for (const entity of ["Invoice", "Customer"])
        if (root.QueryResponse?.[entity]) root.QueryResponse[entity] = root.QueryResponse[entity].map(withEcho);
    }
    const call = {
      seq: this.ledger.next(),
      at: Date.now(),
      service: "quickbooks",
      tool: url.pathname,
      args: {
        method: request.method,
        path: url.pathname,
        realm,
        authGrant: this.state.grants.findIndex((g) => auth === `Bearer ${g.access}`),
        query: Object.fromEntries(url.searchParams),
        ...(payload ? { body: payload, committed } : {}),
        ...(failure ? { failure } : {}),
        status,
        grant: body.get("grant_type"),
        refresh: body.get("refresh_token"),
      },
      kind:
        request.method === "POST" && url.pathname.startsWith("/v3/company/") ? ("write" as const) : ("read" as const),
      outcome: status === 200 ? ("ok" as const) : ("tool_error" as const),
      resultBytes: JSON.stringify(result ?? {}).length,
    };
    this.ledger.calls.push(call);
    if (failure === "transport")
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"private":"'));
            setTimeout(() => controller.error(new Error(QB_PRIVATE)), 20);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    return Response.json(result ?? { Fault: { Error: [{ code: "610", Message: QB_PRIVATE }] } }, { status });
  }
}
