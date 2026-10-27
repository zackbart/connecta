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
  if (path === "/query") {
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
  return valid
    ? Effect.succeed(body)
    : Effect.fail(
        new StatusFailure({ status: answer.status, headers: answer.headers, body, operation: answer.operation }),
      );
};
