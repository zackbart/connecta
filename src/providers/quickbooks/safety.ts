import { Schema } from "effect";
import type { SafetyOptions } from "../../http/safety.js";
import { ConnectorCallError } from "../../errors.js";
import { withholdEmbeddedUrls } from "../_shared/rest/value-safety.js";
import { QUICKBOOKS_INDEX } from "./api.js";
import type { QuickBooksOptions } from "./index.js";

const scalars = [
  "Id",
  "SyncToken",
  "DisplayName",
  "Name",
  "CompanyName",
  "Active",
  "FullyQualifiedName",
  "AccountType",
  "AccountSubType",
  "Classification",
  "CurrentBalance",
  "CurrentBalanceWithSubAccounts",
  "Type",
  "UnitPrice",
  "PurchaseCost",
  "QtyOnHand",
  "TrackQtyOnHand",
  "TxnDate",
  "DueDate",
  "DocNumber",
  "TotalAmt",
  "Balance",
  "UnappliedAmt",
  "ExchangeRate",
  "HomeTotalAmt",
  "HomeBalance",
  "Amount",
  "LineNum",
  "DetailType",
  "Qty",
  "UnitBasedOn",
  "PercentBased",
  "DiscountPercent",
  "DiscountAmt",
  "TotalTax",
  "TaxInclusiveAmt",
  "PayType",
] as const;
const references = [
  "CurrencyRef",
  "CustomerRef",
  "VendorRef",
  "ParentRef",
  "AccountRef",
  "IncomeAccountRef",
  "ExpenseAccountRef",
  "AssetAccountRef",
  "APAccountRef",
  "ARAccountRef",
  "DepositToAccountRef",
  "ItemRef",
  "ClassRef",
  "DepartmentRef",
  "SalesTermRef",
] as const;
const details = [
  "SalesItemLineDetail",
  "AccountBasedExpenseLineDetail",
  "ItemBasedExpenseLineDetail",
  "DiscountLineDetail",
  "SubTotalLineDetail",
  "GroupLineDetail",
  "TxnTaxDetail",
] as const;
const optional = (names: readonly string[]) =>
  Object.fromEntries(names.map((key) => [key, Schema.optionalKey(Schema.Unknown)]));
export const RecordShape = Schema.Struct({
  ...optional(scalars),
  ...optional(references),
  ...optional(details),
  MetaData: Schema.optionalKey(Schema.Unknown),
  Line: Schema.optionalKey(Schema.Unknown),
  LinkedTxn: Schema.optionalKey(Schema.Unknown),
});
export const CompanyShape = Schema.Struct(
  optional(["Id", "SyncToken", "CompanyName", "LegalName", "Country", "FiscalYearStartMonth", "SupportedLanguages"]),
);
const namedKeys = [
  "Id",
  "SyncToken",
  "DisplayName",
  "Name",
  "CompanyName",
  "Active",
  "AccountType",
  "CurrentBalance",
  "UnitPrice",
  "QtyOnHand",
  "PayType",
  "Type",
  "TxnDate",
  "DueDate",
  "DocNumber",
  "TotalAmt",
  "Balance",
  "UnappliedAmt",
  "CurrencyRef",
  "ExchangeRate",
  "CustomerRef",
  "VendorRef",
  "MetaData",
  "Line",
  "LinkedTxn",
] as const;
export const NamedRecordShape = Schema.Struct(optional(namedKeys));
export const namedRecord = (value: unknown) =>
  Object.fromEntries(
    Object.entries(object(value)).filter(([key]) => namedKeys.includes(key as (typeof namedKeys)[number])),
  );
export const ReportShape = Schema.Struct({
  Header: Schema.optionalKey(Schema.Unknown),
  Columns: Schema.optionalKey(Schema.Unknown),
  Rows: Schema.optionalKey(Schema.Unknown),
});
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const cleanText = (text: string) => withholdEmbeddedUrls(text).replace(/https?:\/\/[^\s<>"']+/gi, "[redacted]");
const scalar = (value: unknown) =>
  typeof value === "string"
    ? cleanText(value)
    : (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean"
      ? value
      : undefined;
function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = object(value);
  return Object.fromEntries(
    keys.flatMap((key) =>
      source[key] === undefined || scalar(source[key]) === undefined ? [] : [[key, scalar(source[key])]],
    ),
  );
}
/** Closed accounting projection: unknown fields never become a way around privacy. SyncToken is a version, not a credential. */
function safeRecord(value: unknown): Record<string, unknown> {
  const source = object(value),
    out = pick(source, scalars);
  for (const key of references) if (source[key]) out[key] = pick(source[key], ["value", "name", "type"]);
  if (source["MetaData"]) out["MetaData"] = pick(source["MetaData"], ["CreateTime", "LastUpdatedTime"]);
  for (const key of details) if (source[key]) out[key] = safeRecord(source[key]);
  if (Array.isArray(source["Line"])) out["Line"] = source["Line"].map(safeRecord);
  if (Array.isArray(source["LinkedTxn"]))
    out["LinkedTxn"] = source["LinkedTxn"].map((row) => pick(row, ["TxnId", "TxnType", "TxnLineId"]));
  return out;
}
const REPORT_KEYS = new Set([
  "Header",
  "Columns",
  "Column",
  "Rows",
  "Row",
  "Summary",
  "ColData",
  "ColTitle",
  "ColType",
  "MetaData",
  "Name",
  "Value",
  "Option",
  "Time",
  "ReportName",
  "DateMacro",
  "ReportBasis",
  "StartPeriod",
  "EndPeriod",
  "SummarizeColumnsBy",
  "Currency",
  "value",
  "id",
  "type",
  "group",
]);
const ENTITIES = ["Customer", "Vendor", "Account", "Item", "Invoice", "Bill", "Payment", "BillPayment"];
const COMPANY_KEYS = [
  "Id",
  "SyncToken",
  "CompanyName",
  "LegalName",
  "Country",
  "FiscalYearStartMonth",
  "SupportedLanguages",
];
// Report trees retain vendor hierarchy, column metadata and empty strings. No index has a fixed metric meaning.
function reportTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reportTree);
  if (typeof value !== "object" || value === null) return scalar(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => REPORT_KEYS.has(key))
      .map(([key, entry]) => [key, reportTree(entry)]),
  );
}
type Kept = "whole" | "trimmed" | "dropped";
/** What `safeRecord` does to a path within a record: returns it whole, trims it to picked fields, or drops it. */
function recordPath(path: readonly string[]): Kept {
  const [head, ...rest] = path;
  if (head === undefined) return "trimmed";
  if ((scalars as readonly string[]).includes(head)) return rest.length ? "dropped" : "whole";
  if ((details as readonly string[]).includes(head) || head === "Line") return recordPath(rest);
  const picked =
    head === "MetaData"
      ? ["CreateTime", "LastUpdatedTime"]
      : head === "LinkedTxn"
        ? ["TxnId", "TxnType", "TxnLineId"]
        : (references as readonly string[]).includes(head)
          ? ["value", "name", "type"]
          : undefined;
  if (!picked) return "dropped";
  if (rest.length === 0) return "trimmed";
  return rest.length === 1 && picked.includes(rest[0]!) ? "whole" : "dropped";
}
/** The closed projection as a discovery hint: a path it always drops is withheld. */
function quickbooksWithholds(template: string) {
  return (path: readonly string[]) => {
    const names = path.map((segment) => segment.replace(/\[\]$/, ""));
    if (template.startsWith("/reports/")) return !names.every((name) => REPORT_KEYS.has(name));
    if (template.startsWith("/companyinfo/"))
      return (
        names[0] !== "CompanyInfo" || names.length > 2 || (names.length === 2 && !COMPANY_KEYS.includes(names[1]!))
      );
    const [root, ...rest] = template === "/query" && names[0] === "QueryResponse" ? names.slice(1) : names;
    if (template === "/query" && names[0] !== "QueryResponse") return true;
    if (root === undefined) return false;
    return !ENTITIES.includes(root) || recordPath(rest) === "dropped";
  };
}

export function quickbooksSafety(options: Readonly<QuickBooksOptions>): SafetyOptions {
  return {
    reviewed: {
      resolve: (method, path) => {
        if (/[%;\\?#]/.test(path) || path.split("/").some((part) => part === "." || part === ".."))
          throw new ConnectorCallError("invalid_args", "Use a canonical reviewed QuickBooks path.");
        const { op } = QUICKBOOKS_INDEX.resolve(method, path);
        if (op.path === "/companyinfo/{id}" && path !== `/companyinfo/${options.realmId}`)
          throw new ConnectorCallError("invalid_args", "The company must match the configured realmId.");
        return { method: op.method, template: op.path };
      },
      withholdsErrors: () => true,
      withholds: (operation) => quickbooksWithholds(operation.template),
      redact: (body, operation) => {
        const root = object(body);
        if (operation.template.startsWith("/reports/")) return reportTree(root);
        if (operation.template.startsWith("/companyinfo/"))
          return {
            CompanyInfo: pick(root["CompanyInfo"], COMPANY_KEYS),
          };
        if (operation.template === "/query") {
          const query = object(root["QueryResponse"]);
          return {
            QueryResponse: Object.fromEntries(
              Object.entries(query)
                .filter(([key]) => ENTITIES.includes(key) && Array.isArray(query[key]))
                .map(([key, rows]) => [key, (rows as unknown[]).map(safeRecord)]),
            ),
          };
        }
        return Object.fromEntries(
          Object.entries(root)
            .filter(([key]) => ENTITIES.includes(key))
            .map(([key, record]) => [key, safeRecord(record)]),
        );
      },
    },
    sensitiveFields: { names: [], choice: "drop" },
  };
}
