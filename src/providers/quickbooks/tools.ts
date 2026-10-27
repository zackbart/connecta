import { quickbooksWrites } from "./lib/writes.js";
import { Effect, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal } from "../../http/errors.js";
import { get as getTool, list } from "../../http/tools.js";
import type { Connection } from "../../http/vendor.js";
import type { QuickBooksOptions } from "./index.js";
import { companyInfo, ENTITIES, queryRecords, REPORTS, recordReads, reportReads } from "./api.js";
import { CompanyShape, namedRecord, NamedRecordShape, object, ReportShape } from "./safety.js";
import { buildSearch, Filters, matches, reportParameters, reportProblem, REPORT_QUERY } from "./lib/query.js";

const Entity = Schema.Literals([
  "customers",
  "vendors",
  "accounts",
  "items",
  "invoices",
  "bills",
  "payments",
  "bill_payments",
]);
const Id = Schema.String.check(matches("^[1-9]\\d{0,30}$"));
const query = { minorversion: "75" } as const;
const checked = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) =>
      new Refusal({
        error:
          error instanceof ConnectorCallError
            ? error
            : new ConnectorCallError("invalid_args", "Invalid QuickBooks arguments."),
      }),
  });
export function quickbooksTools({
  connection,
  pageSize,
  options,
}: {
  connection: Connection;
  pageSize: number;
  options: Readonly<QuickBooksOptions>;
}): ApiTool[] {
  return [
    ...quickbooksWrites(connection, options.realmId),
    getTool(connection, {
      name: "get_company_info",
      description: "Read the configured company's accounting identity without contact or tax identifiers.",
      input: Schema.Struct({}),
      output: CompanyShape,
      fields: true,
      run: () =>
        connection
          .send(companyInfo, { params: { id: options.realmId }, query })
          .pipe(Effect.map(({ data }) => object(object(data)["CompanyInfo"]))),
    }),
    list(connection, {
      name: "search_records",
      description:
        "Search reviewed accounting records using bounded structured filters. Customer/vendor names are exact DisplayName matches; record ids and references join invoices, bills and accounting payments. No raw SQL. Inactive master records need an explicit Active filter.",
      filters: {
        entity: Entity.annotate({
          description: "Accounting record family; payments are accounting records, not the Payments API.",
        }),
        filters: Schema.optionalKey(
          Filters.annotate({
            description:
              "At most 8 AND filters. Master records: Id, Active, LastUpdatedTime and DisplayName (customers/vendors) or Name (accounts/items). Transactions: Id, LastUpdatedTime, TxnDate and CustomerRef or VendorRef. Invoices/bills/bill payments also DocNumber; invoices/bills also DueDate and Balance.",
          }),
        ),
      },
      row: NamedRecordShape,
      limit: {
        default: pageSize,
        max: 100,
        description: "Rows per page, default 25, at most 100. A bounded extra row detects continuation.",
      },
      cursor: "bound",
      cursorScope: { realmId: options.realmId, environment: options.environment },
      page: (args, cursor) =>
        Effect.gen(function* () {
          const entity = ENTITIES[args.entity];
          const start = cursor === undefined ? 1 : Number(cursor);
          const sql = yield* checked(() => buildSearch(entity, args.filters ?? [], start, args.limit + 1));
          const { data } = yield* connection.send(
            queryRecords,
            { query: { ...query, query: sql } },
            { flags: { [entity]: true } },
          );
          const rows = object(object(data)["QueryResponse"])[entity];
          const all = Array.isArray(rows) ? rows : [];
          const more = all.length > args.limit;
          return {
            rows: all.slice(0, args.limit).map(namedRecord),
            page: { hasMore: more, nextCursor: more ? String(start + args.limit) : null },
          };
        }),
    }),
    getTool(connection, {
      name: "get_record",
      description:
        "Read one reviewed accounting record by Id. SyncToken is its public version identifier; DocNumber is a separate human label. Contact details and payment credentials are withheld.",
      input: Schema.Struct({
        entity: Entity,
        id: Id.annotate({ description: "Record Id from search_records, never DocNumber." }),
      }),
      output: NamedRecordShape,
      fields: true,
      run: (args) =>
        connection
          .sendPath({
            method: "GET",
            path: `/${ENTITIES[args.entity].toLowerCase()}/${args.id}`,
            template: recordReads[args.entity]!.path,
            query: [["minorversion", "75"]],
          })
          .pipe(Effect.map(({ data }) => namedRecord(object(data)[ENTITIES[args.entity]]))),
    }),
    getTool(connection, {
      name: "get_report",
      description:
        "Read Profit & Loss, Balance Sheet, Cash Flow or AR/AP aging summary. Preserve Header, Columns and nested Rows; empty amount strings mean no value, never zero. P&L/CashFlow support start_date; P&L/BalanceSheet support accounting_method. All accept end_date (aging as-of date). Reports retain vendor currency; no currency conversion.",
      input: Schema.Struct({ report: Schema.Literals(REPORTS), ...REPORT_QUERY }),
      output: ReportShape,
      fields: true,
      run: (args) =>
        Effect.gen(function* () {
          const { report, ...raw } = args;
          const parameters = reportParameters(
            report,
            Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)),
          );
          yield* checked(() => {
            const problem = reportProblem(report, parameters);
            if (problem) throw new ConnectorCallError("invalid_args", problem);
          });
          const { data } = yield* connection.sendPath({
            method: "GET",
            path: `/reports/${report}`,
            template: reportReads[report]!.path,
            query: Object.entries({ ...parameters, minorversion: "75" }),
          });
          return object(data);
        }),
    }),
  ];
}
