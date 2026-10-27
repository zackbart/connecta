import { Effect, Schema } from "effect";
import type { ApiOAuthConfig } from "../../connectors/api-connector.js";
import { StatusFailure, type VendorErrors } from "../../http/errors.js";
import type { HatchBinding } from "../../http/hatch.js";
import { get, post, Summary, vendor, type Connection, type ConnectOptions } from "../../http/vendor.js";
import { vendorIndex } from "../../http/vendor-index.js";
import type { QuickBooksOptions } from "./index.js";
import { RecordShape, CompanyShape, ReportShape, object } from "./safety.js";
import { matches, reportProblem, reportQuery } from "./lib/query.js";

export const ENTITIES = {
  customers: "Customer",
  vendors: "Vendor",
  accounts: "Account",
  items: "Item",
  invoices: "Invoice",
  bills: "Bill",
  payments: "Payment",
  bill_payments: "BillPayment",
} as const;
export const REPORTS = ["ProfitAndLoss", "BalanceSheet", "CashFlow", "AgedReceivables", "AgedPayables"] as const;
const version = { minorversion: Schema.optionalKey(Schema.Literal("75")) };
const id = { id: Schema.String.check(matches("^[1-9]\\d{0,30}$")) };
export const companyInfo = get("companyInfo", "/companyinfo/:id", {
  params: id,
  query: version,
  success: Schema.Struct({ CompanyInfo: CompanyShape }),
}).annotate(Summary, "Get the configured company identity");
export const queryRecords = get("queryRecords", "/query", {
  query: { ...version, query: Schema.String },
  success: Schema.Struct({ QueryResponse: Schema.Unknown }),
}).annotate(Summary, "Structured accounting searches through search_records only; raw SQL refused");
export const recordReads = Object.fromEntries(
  Object.entries(ENTITIES).map(([key, entity]) => [
    key,
    get(`get${entity}`, `/${entity.toLowerCase()}/:id`, {
      params: id,
      query: version,
      success: Schema.Struct({ [entity]: RecordShape }),
    }).annotate(Summary, `Read one ${entity} accounting record`),
  ]),
);
export const reportReads = Object.fromEntries(
  REPORTS.map((name) => [
    name,
    get(`report${name}`, `/reports/${name}`, {
      query: { ...version, ...reportQuery(name) },
      success: ReportShape,
    }).annotate(Summary, `Read the ${name} financial report`),
  ]),
);
// Closed named-write bodies. POSTs are indexed for safety, but refused by the hatch.
export const PublicId = Schema.String.check(matches("^[1-9]\\d{0,30}$"));
export const SyncToken = Schema.String.check(matches("^(?:0|[1-9]\\d{0,30})$"));
const Name = Schema.String.check(matches("^\\S(?:[^\\r\\n]{0,498}\\S)?$"));
export const CustomerNames = { DisplayName: Name, CompanyName: Schema.optionalKey(Name) };
export const customerWrite = post("writeCustomer", "/customer", {
  query: { minorversion: Schema.Literal("75"), requestid: Schema.String },
  payload: Schema.Struct({
    ...CustomerNames,
    Id: Schema.optionalKey(PublicId),
    SyncToken: Schema.optionalKey(SyncToken),
    sparse: Schema.optionalKey(Schema.Literal(true)),
  }),
  success: Schema.Struct({ Customer: RecordShape }),
}).annotate(Summary, "Create a customer or sparsely update naming fields through named tools only");
export const invoiceWrite = post("createInvoice", "/invoice", {
  query: { minorversion: Schema.Literal("75"), requestid: Schema.String },
  payload: Schema.Struct({
    CustomerRef: Schema.Struct({ value: PublicId }),
    CurrencyRef: Schema.Struct({ value: Schema.String }),
    ExchangeRate: Schema.Number,
    TxnDate: Schema.String,
    DueDate: Schema.String,
    DocNumber: Schema.String,
    Line: Schema.Array(
      Schema.Struct({
        Amount: Schema.Number,
        DetailType: Schema.Literal("SalesItemLineDetail"),
        SalesItemLineDetail: Schema.Struct({
          ItemRef: Schema.Struct({ value: PublicId }),
          Qty: Schema.Literal(1),
          UnitPrice: Schema.Number,
        }),
      }),
    ),
    EmailStatus: Schema.Literal("NotSet"),
    AllowIPNPayment: Schema.Literal(false),
    AllowOnlinePayment: Schema.Literal(false),
    AllowOnlineCreditCardPayment: Schema.Literal(false),
    AllowOnlineACHPayment: Schema.Literal(false),
    AllowOnlinePayPalPayment: Schema.Literal(false),
    AllowOnlineAffirmPayment: Schema.Literal(false),
  }),
  success: Schema.Struct({ Invoice: RecordShape }),
}).annotate(Summary, "Create a real unsent service invoice through create_invoice only");
export const QuickBooksApi = vendor(
  "QuickBooks Online",
  companyInfo,
  queryRecords,
  customerWrite,
  invoiceWrite,
  ...Object.values(recordReads),
  ...Object.values(reportReads),
);
export const QUICKBOOKS_INDEX = vendorIndex(QuickBooksApi, {
  prefix: "quickbooks",
  title: "QuickBooks Online",
  revision: "v3-minor75",
});
export const QUICKBOOKS_VERDICTS = {
  "GET /companyinfo/{id}": "read",
  "GET /query": "refuse",
  "POST /customer": "refuse",
  "POST /invoice": "refuse",
  ...Object.fromEntries(
    Object.values(ENTITIES).map((entity) => [`GET /${entity.toLowerCase()}/{id}`, "read" as const]),
  ),
  ...Object.fromEntries(REPORTS.map((name) => [`GET /reports/${name}`, "read" as const])),
} as const;
export const QUICKBOOKS_NAMED = {
  "GET /companyinfo/{id}": "get_company_info",
  "GET /query": "search_records",
  ...Object.fromEntries(Object.values(ENTITIES).map((entity) => [`GET /${entity.toLowerCase()}/{id}`, "get_record"])),
  ...Object.fromEntries(REPORTS.map((name) => [`GET /reports/${name}`, "get_report"])),
};
export const apiOrigin = (options: Readonly<QuickBooksOptions>) =>
  options.environment === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
export function oauth(options: Readonly<QuickBooksOptions>): ApiOAuthConfig {
  return {
    authorizationEndpoint: "https://appcenter.intuit.com/connect/oauth2",
    tokenEndpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revocationEndpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    revocationRequestFormat: "json",
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    scope: "com.intuit.quickbooks.accounting",
    pkce: false,
    expectedCallbackParameters: { realmId: options.realmId },
    apiOrigins: [apiOrigin(options)],
  };
}

export function quickbooksBinding({
  connection,
  options,
}: {
  connection: Connection;
  options: Readonly<QuickBooksOptions>;
}): HatchBinding {
  return {
    review:
      "Fixed company/environment, indexed GETs only, minorversion 75; query SQL is reserved for the named structured builder.",
    cursorScope: { realmId: options.realmId, environment: options.environment },
    refuse: (call) => {
      // The indexed refusal owns /query, including its discovery/details reason.
      if (call.op.path === "/query") return undefined;
      if (call.op.path === "/companyinfo/{id}" && call.path !== `/companyinfo/${options.realmId}`)
        return "Company info must name this connector's configured realmId.";
      if (!/^\/(?:[a-z]+\/[1-9]\d{0,30}|reports\/[A-Za-z]+)$/.test(call.path))
        return "Use a canonical reviewed QuickBooks path.";
      if (call.op.path.startsWith("/reports/")) return reportProblem(call.path.split("/").at(-1)!, call.query);
      if (Object.keys(call.query).some((key) => key !== "minorversion"))
        return "This record read accepts no extra query parameters.";
      return undefined;
    },
    send: (call, settings) =>
      connection.sendPath(
        {
          method: "GET",
          path: call.path,
          template: call.op.path,
          query: Object.entries({ ...call.query, minorversion: "75" }).map(([key, value]): [string, string] => [
            key,
            String(value),
          ]),
        },
        settings,
      ),
  };
}

export const errors: VendorErrors = {
  provider: "QuickBooks Online",
  meanings: {
    unknownId: "connector_call_failed",
    provesAbsence: false,
    conflicts: ["Intuit fault 5010 for a stale SyncToken", "Intuit fault 6240 for a duplicate DisplayName"],
  },
  facts: (body) => {
    const rows = object(object(body)["Fault"])["Error"];
    const code = Array.isArray(rows) ? object(rows[0])["code"] : undefined;
    return { faultCode: typeof code === "string" && ["610", "5010", "6240"].includes(code) ? code : "" };
  },
  factVocabulary: { faultCode: ["610", "5010", "6240"] },
  detail: ({ status }) => `QuickBooks Online returned HTTP ${status}.`,
  unreadable: "QuickBooks Online returned a successful response that is not JSON.",
  numericFacts: {
    retryAfterMs: { header: "retry-after", format: "retry-after", review: "Standard HTTP Retry-After delay." },
  },
  statuses: {
    200: () => ({
      code: "connector_call_failed",
      retryable: false,
      words: (detail) => `${detail} The accounting response was incomplete or invalid.`,
    }),
    400: ({ facts }) => ({
      code:
        facts["faultCode"] === "610"
          ? "connector_call_failed"
          : ["5010", "6240"].includes(String(facts["faultCode"]))
            ? "conflict"
            : "invalid_args",
      words: (detail) =>
        facts["faultCode"] === "5010"
          ? `${detail} The observed SyncToken is stale; reread and review the change.`
          : facts["faultCode"] === "6240"
            ? `${detail} The DisplayName is already in use by a customer, vendor or employee.`
            : detail,
      retryable: false,
    }),
    401: () => ({ code: "auth_required" }),
    403: () => ({ code: "provider_permission_denied", retryable: false }),
    404: () => ({ code: "connector_call_failed", retryable: false }),
    429: ({ retryAfterMs }) => ({
      code: "rate_limited",
      retryAfterMs: Math.max(60_000, retryAfterMs ?? 0),
      words: (detail) => `${detail} Intuit documents a wait of at least 60 seconds after throttling.`,
    }),
  },
};

/** Missing data is a failure, never a fabricated record/report/search or confirmed write. */
const container = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const cells = (value: unknown): boolean =>
  Array.isArray(value) && value.every((cell) => container(cell) && typeof cell["value"] === "string");
function reportRows(value: unknown, depth = 0): boolean {
  if (!container(value) || depth > 32) return false;
  if (value["Row"] === undefined) return Object.keys(value).length === 0;
  return (
    Array.isArray(value["Row"]) &&
    value["Row"].every((row: unknown) => {
      if (!container(row)) return false;
      if (!["Header", "Summary", "ColData", "Rows"].some((key) => row[key] !== undefined)) return false;
      for (const key of ["Header", "Summary"]) {
        if (row[key] !== undefined && (!container(row[key]) || !cells(row[key]["ColData"]))) return false;
      }
      return (
        (row["ColData"] === undefined || cells(row["ColData"])) &&
        (row["Rows"] === undefined || reportRows(row["Rows"], depth + 1))
      );
    })
  );
}
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) => {
  const root = object(body);
  const path = answer.operation.template;
  let valid: boolean;
  if (answer.operation.method === "POST") {
    const key = path === "/customer" ? "Customer" : path === "/invoice" ? "Invoice" : undefined;
    const record = key === undefined ? {} : object(root[key]);
    const numericId = (value: unknown) => typeof value === "string" && /^[1-9]\d{0,30}$/.test(value);
    const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
    valid =
      key !== undefined &&
      numericId(record["Id"]) &&
      typeof record["SyncToken"] === "string" &&
      /^(?:0|[1-9]\d{0,30})$/.test(record["SyncToken"]) &&
      (key === "Customer"
        ? typeof record["DisplayName"] === "string" && record["DisplayName"].trim() !== ""
        : (record["EmailStatus"] === undefined || record["EmailStatus"] === "NotSet") &&
          [
            "AllowIPNPayment",
            "AllowOnlinePayment",
            "AllowOnlineCreditCardPayment",
            "AllowOnlineACHPayment",
            "AllowOnlinePayPalPayment",
            "AllowOnlineAffirmPayment",
          ].every((key) => record[key] === undefined || record[key] === false) &&
          amount(record["TotalAmt"]) &&
          ["Balance", "HomeTotalAmt", "HomeBalance"].every((key) => record[key] === undefined || amount(record[key])) &&
          (record["ExchangeRate"] === undefined ||
            (typeof record["ExchangeRate"] === "number" &&
              Number.isFinite(record["ExchangeRate"]) &&
              record["ExchangeRate"] > 0)) &&
          typeof record["DocNumber"] === "string" &&
          record["DocNumber"].trim() !== "" &&
          numericId(object(record["CustomerRef"])["value"]) &&
          typeof object(record["CurrencyRef"])["value"] === "string" &&
          /^[A-Z]{3}$/.test(String(object(record["CurrencyRef"])["value"])) &&
          Array.isArray(record["Line"]) &&
          record["Line"].length > 0 &&
          record["Line"].every((line: unknown) => container(line) && amount(line["Amount"])) &&
          record["Line"].some(
            (line: unknown) =>
              object(line)["DetailType"] === "SalesItemLineDetail" &&
              numericId(object(object(object(line)["SalesItemLineDetail"])["ItemRef"])["value"]),
          ));
  } else if (path === "/query") {
    const rows = root["QueryResponse"];
    valid =
      container(rows) &&
      Object.entries(rows).every(
        ([key, value]) =>
          (["startPosition", "maxResults", "totalCount"].includes(key) &&
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= (key === "startPosition" ? 1 : 0)) ||
          (answer.operation.flags?.[key] === true &&
            Array.isArray(value) &&
            (rows["totalCount"] === undefined ||
              (typeof rows["totalCount"] === "number" && rows["totalCount"] >= value.length)) &&
            (value.length > 0 ||
              ((rows["totalCount"] === undefined || rows["totalCount"] === 0) &&
                (rows["maxResults"] === undefined || rows["maxResults"] === 0))) &&
            value.every((row) => typeof object(row)["Id"] === "string" && object(row)["Id"] !== "")),
      ) &&
      (Object.keys(rows).some((key) => answer.operation.flags?.[key] === true) ||
        ((rows["totalCount"] === undefined || rows["totalCount"] === 0) &&
          (rows["maxResults"] === undefined || rows["maxResults"] === 0)));
  } else if (path.startsWith("/reports/")) {
    const columns = object(root["Columns"])["Column"];
    valid =
      typeof object(root["Header"])["ReportName"] === "string" &&
      Array.isArray(columns) &&
      columns.every((column: unknown) => container(column)) &&
      reportRows(root["Rows"]);
  } else {
    const key = path.startsWith("/companyinfo/")
      ? "CompanyInfo"
      : Object.values(ENTITIES).find((entity) => path.startsWith(`/${entity.toLowerCase()}/`));
    valid = key !== undefined && typeof object(root[key])["Id"] === "string";
  }
  return valid && root["Fault"] === undefined
    ? Effect.succeed(body)
    : Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body, operation: answer.operation }),
      );
};
