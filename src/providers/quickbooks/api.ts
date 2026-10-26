import { Effect, Schema } from "effect";
import type { ApiOAuthConfig } from "../../connectors/api-connector.js";
import { StatusFailure, type VendorErrors } from "../../http/errors.js";
import type { HatchBinding } from "../../http/hatch.js";
import { get, Summary, vendor, type Connection, type ConnectOptions } from "../../http/vendor.js";
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
export const QuickBooksApi = vendor(
  "QuickBooks Online",
  companyInfo,
  queryRecords,
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
      if (call.op.path === "/query") return "Raw SQL is refused; use search_records with structured filters.";
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
  meanings: { unknownId: "connector_call_failed", provesAbsence: false, conflicts: [] },
  facts: (body) => {
    const rows = object(object(body)["Fault"])["Error"];
    return { faultCode: Array.isArray(rows) && object(rows[0])["code"] === "610" ? "610" : "" };
  },
  factVocabulary: { faultCode: ["610"] },
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
      code: facts["faultCode"] === "610" ? "connector_call_failed" : "invalid_args",
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

/** Missing data is a failed read, never a fabricated empty record/report/search. */
export const result: NonNullable<ConnectOptions["result"]> = (body, answer) => {
  const root = object(body);
  const path = answer.operation.template;
  let valid: boolean;
  if (path === "/query") {
    const rows = root["QueryResponse"];
    valid =
      rows !== null &&
      typeof rows === "object" &&
      !Array.isArray(rows) &&
      Object.entries(object(rows)).every(
        ([key, value]) =>
          ["startPosition", "maxResults", "totalCount"].includes(key) ||
          (answer.operation.flags?.[key] === true &&
            Array.isArray(value) &&
            value.every((row) => typeof object(row)["Id"] === "string")),
      );
  } else if (path.startsWith("/reports/")) {
    valid =
      typeof object(root["Header"])["ReportName"] === "string" &&
      Array.isArray(object(root["Columns"])["Column"]) &&
      root["Rows"] !== undefined;
  } else {
    const key = path.startsWith("/companyinfo/")
      ? "CompanyInfo"
      : Object.values(ENTITIES).find((entity) => path.startsWith(`/${entity.toLowerCase()}/`));
    valid = key !== undefined && typeof object(root[key])["Id"] === "string";
  }
  return valid
    ? Effect.succeed(body)
    : Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body, operation: answer.operation }),
      );
};
