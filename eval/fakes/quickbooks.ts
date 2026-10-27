/** Small stateful Intuit stand-in: exact query fixtures, no SQL parser or vendor network. */
import { serveFetch, type Served } from "../support/serve.js";
import type { Ledger } from "./service.js";
import { QB_CLIENT, QB_SECRET, QB_COMPANIES } from "../deploy/quickbooks.js";

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
const quickbooksState = () => ({
  companies: Object.fromEntries(
    Object.entries(QB_COMPANIES).map(([owner, realm]) => [
      realm,
      {
        owner,
        company: { Id: realm, CompanyName: `${owner} books`, EmployerId: QB_PRIVATE },
        Customer: [
          { Id: "9", DisplayName: "Alice's \\ studio", SyncToken: "2", PrimaryEmailAddr: { Address: QB_PRIVATE } },
        ],
        Invoice:
          owner === "alice"
            ? [invoice("41", "9", 125.5), invoice("42", "9", 150), invoice("43", "9", 100)]
            : [invoice("41", "9", 999)],
        report: structuredClone(report),
      },
    ]),
  ),
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
  constructor(private readonly ledger: Ledger) {}
  get url() {
    return this.server!.url;
  }
  async start() {
    this.server = await serveFetch((r) => this.fetch(r));
  }
  async stop() {
    await this.server?.close();
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
        auth !== `Basic ${btoa(`${QB_CLIENT}:${QB_SECRET}`)}` ||
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
      if (auth !== `Basic ${btoa(`${QB_CLIENT}:${QB_SECRET}`)}`) status = 401;
      else if (body.get("grant_type") === "authorization_code") {
        realm = body.get("code") ?? "";
        if (!this.state.companies[realm]) status = 400;
        else
          this.state.grants.push({
            realm,
            access: `qb-access-${realm}-0`,
            refresh: `qb-refresh-${realm}-0`,
            generation: 0,
            expired: false,
            revoked: false,
          });
      } else {
        const grant = this.state.grants.find((g) => g.refresh === body.get("refresh_token") && !g.revoked);
        if (!grant) status = 400;
        else {
          realm = grant.realm;
          grant.generation++;
          grant.access = `qb-access-${realm}-${grant.generation}`;
          // Intuit may return identical refresh bytes for two hourly renewals.
          if (realm !== QB_COMPANIES.alice || grant.generation > 2)
            grant.refresh = `qb-refresh-${realm}-${grant.generation}`;
          grant.expired = false;
        }
      }
      const grant = [...this.state.grants].reverse().find((g) => g.realm === realm);
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
        request.method !== "GET" ||
        request.headers.get("x-eval-vendor-origin") !==
          (realm === QB_COMPANIES.alice
            ? "https://sandbox-quickbooks.api.intuit.com"
            : "https://quickbooks.api.intuit.com")
      )
        status = 400;
      else if (path === `/companyinfo/${realm}`) result = { CompanyInfo: company.company };
      else if (path === "/query") {
        const query = url.searchParams.get("query");
        // A finite set of independently authored fixture requests. Unexpected SQL fails.
        const queries: Record<string, unknown> = {
          "SELECT * FROM Customer WHERE DisplayName = 'Alice\\'s \\\\ studio' STARTPOSITION 1 MAXRESULTS 2": {
            Customer: company.Customer,
          },
          "SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION 1 MAXRESULTS 3": {
            Invoice: company.Invoice.slice(0, 3),
          },
          "SELECT * FROM Invoice WHERE CustomerRef = '9' STARTPOSITION 3 MAXRESULTS 3": {
            Invoice: company.Invoice.slice(2, 5),
          },
        };
        if (!query || !queries[query]) status = 400;
        else result = { QueryResponse: queries[query] };
      } else if (/^\/invoice\/\d+$/.test(path)) {
        const row = company.Invoice.find((r: Row) => r.Id === path.split("/")[2]);
        if (row) result = { Invoice: row };
        else status = 400;
      } else if (path === "/reports/ProfitAndLoss") result = company.report;
      else status = 404;
    }
    // Echo the credential into an otherwise public field: the output boundary
    // must redact sent secrets before named, hatch or fields projections.
    if (result && typeof result === "object") {
      const root = result as Row;
      const withEcho = (row: Row) => ({ ...row, Name: auth?.slice(7) });
      if (root.Invoice) root.Invoice = withEcho(root.Invoice);
      if (root.QueryResponse?.Invoice) root.QueryResponse.Invoice = root.QueryResponse.Invoice.map(withEcho);
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
        query: Object.fromEntries(url.searchParams),
        grant: body.get("grant_type"),
        refresh: body.get("refresh_token"),
      },
      kind: "read" as const,
      outcome: status === 200 ? ("ok" as const) : ("tool_error" as const),
      resultBytes: JSON.stringify(result ?? {}).length,
    };
    this.ledger.calls.push(call);
    return Response.json(result ?? { Fault: { Error: [{ code: "610", Message: QB_PRIVATE }] } }, { status });
  }
}
