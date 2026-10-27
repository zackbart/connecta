import { Schema } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import { isMaxChars } from "../../../http/json-schema.js";

export const matches = (pattern: string) =>
  Schema.makeFilter((value: string) => new RegExp(pattern).test(value), { toJsonSchema: () => ({ pattern }) });
const DateOnly = Schema.String.check(matches("^\\d{4}-\\d{2}-\\d{2}$"));
export const REPORT_QUERY = {
  start_date: Schema.optionalKey(DateOnly.annotate({ description: "First date, YYYY-MM-DD; P&L and Cash Flow only." })),
  end_date: Schema.optionalKey(DateOnly.annotate({ description: "Last date or statement date, YYYY-MM-DD." })),
  accounting_method: Schema.optionalKey(
    Schema.Literals(["Cash", "Accrual"]).annotate({ description: "Accounting basis; P&L and Balance Sheet only." }),
  ),
};
export function reportQuery(report: string) {
  if (report === "AgedReceivables" || report === "AgedPayables")
    return {
      report_date: Schema.optionalKey(DateOnly.annotate({ description: "As-of date, YYYY-MM-DD." })),
      aging_method: Schema.optionalKey(
        Schema.Literal("Report_Date").annotate({ description: "Age relative to report_date." }),
      ),
    };
  return {
    ...(["ProfitAndLoss", "CashFlow"].includes(report) ? { start_date: REPORT_QUERY.start_date } : {}),
    end_date: REPORT_QUERY.end_date,
    ...(["ProfitAndLoss", "BalanceSheet"].includes(report)
      ? { accounting_method: REPORT_QUERY.accounting_method }
      : {}),
  };
}
/** Named reports use one end_date; aging translates it to the vendor's snapshot date. */
export function reportParameters(report: string, query: Readonly<Record<string, string>>) {
  if ((report === "AgedReceivables" || report === "AgedPayables") && query["end_date"] !== undefined) {
    const { end_date, ...rest } = query;
    return { ...rest, report_date: end_date, aging_method: "Report_Date" };
  }
  return query;
}
export function reportProblem(report: string, query: Readonly<Record<string, unknown>>): string | undefined {
  const allowed = new Set(["minorversion", ...Object.keys(reportQuery(report))]);
  if (Object.keys(query).some((key) => !allowed.has(key)))
    return "This report does not support a supplied parameter; inspect get_report or quickbooks_api_details.";
  for (const key of ["start_date", "end_date", "report_date"]) {
    const value = query[key];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      return `${key} must be a real YYYY-MM-DD date.`;
  }
  if (query["start_date"] && query["end_date"] && String(query["start_date"]) > String(query["end_date"]))
    return "start_date must not follow end_date.";
  if (query["aging_method"] !== undefined && query["report_date"] === undefined)
    return "aging_method requires report_date.";
  return undefined;
}

const FILTER_FIELDS = [
  "Id",
  "DisplayName",
  "Name",
  "Active",
  "MetaData.LastUpdatedTime",
  "TxnDate",
  "DueDate",
  "DocNumber",
  "CustomerRef",
  "VendorRef",
  "Balance",
] as const;
export const Filters = Schema.Array(
  Schema.Struct({
    field: Schema.Literals(FILTER_FIELDS).annotate({
      description: "Reviewed filter field, subject to the chosen record type.",
    }),
    operator: Schema.Literals(["eq", "gt", "gte", "lt", "lte"]).annotate({
      description: "Equality or an ordered date/amount comparison.",
    }),
    value: Schema.Union([Schema.String.check(isMaxChars(200)), Schema.Boolean, Schema.Number.check(Schema.isFinite())]),
  }),
).check(Schema.isMaxLength(8));
export type SearchFilter = (typeof Filters.Type)[number];
const operations = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
/** One SQL builder. No agent text is ever used as a clause, identifier or paging anchor. */
export function buildSearch(entity: string, filters: readonly SearchFilter[], start: number, size: number): string {
  const master = ["Customer", "Vendor", "Account", "Item"].includes(entity);
  const fields = new Set([
    "Id",
    "MetaData.LastUpdatedTime",
    ...(master
      ? ["Active", entity === "Customer" || entity === "Vendor" ? "DisplayName" : "Name"]
      : [
          "TxnDate",
          ...(entity === "Payment" ? [] : ["DocNumber"]),
          ...(entity === "Invoice" || entity === "Bill" ? ["DueDate", "Balance"] : []),
          ...(entity === "Invoice" || entity === "Payment" ? ["CustomerRef"] : ["VendorRef"]),
        ]),
  ]);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(size) || size < 1 || size > 101)
    throw new ConnectorCallError("invalid_args", "Invalid QuickBooks search page.");
  const clauses = filters.map(({ field, operator, value }) => {
    if (!fields.has(field))
      throw new ConnectorCallError("invalid_args", `${field} is not a reviewed filter for ${entity}.`);
    const range = ["TxnDate", "DueDate", "MetaData.LastUpdatedTime", "Balance"].includes(field);
    if (!range && operator !== "eq") throw new ConnectorCallError("invalid_args", `${field} supports only eq.`);
    if (
      field === "Active"
        ? typeof value !== "boolean"
        : field === "Balance"
          ? typeof value !== "number"
          : typeof value !== "string" ||
            [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new ConnectorCallError("invalid_args", `Invalid value type for ${field}.`);
    if (["Id", "CustomerRef", "VendorRef"].includes(field) && !/^[1-9]\d{0,30}$/.test(String(value)))
      throw new ConnectorCallError("invalid_args", `${field} requires a numeric record id.`);
    if (["TxnDate", "DueDate"].includes(field) && reportProblem("ProfitAndLoss", { end_date: value }))
      throw new ConnectorCallError("invalid_args", `${field} requires a real YYYY-MM-DD date.`);
    if (
      field === "MetaData.LastUpdatedTime" &&
      (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      throw new ConnectorCallError("invalid_args", "LastUpdatedTime requires an ISO timestamp with timezone.");
    const literal =
      typeof value === "string" ? `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'` : String(value);
    return `${field} ${operations[operator]} ${literal}`;
  });
  return `SELECT * FROM ${entity}${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} STARTPOSITION ${start} MAXRESULTS ${size}`;
}
