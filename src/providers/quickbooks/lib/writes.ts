import { Effect, Schema } from "effect";
import { ConnectorCallError } from "../../../errors.js";
import { Refusal, StatusFailure } from "../../../http/errors.js";
import { Budget } from "../../../http/services.js";
import { write } from "../../../http/tools.js";
import type { Connection } from "../../../http/vendor.js";
import { companyInfo, CustomerNames, customerWrite, invoiceWrite, PublicId, recordReads, SyncToken } from "../api.js";
import { namedRecord, NamedRecordShape, object } from "../safety.js";
import { matches, reportProblem } from "./query.js";

const RequestId = Schema.String.check(matches("^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$")).annotate({
  description:
    "Stable identifier for this exact intent, unique across all requests in this company; at most 50 ASCII letters, digits, underscores or hyphens. Never reuse for changed content.",
});
const DateOnly = Schema.String.check(matches("^\\d{4}-\\d{2}-\\d{2}$"));
// Decimal strings avoid binary arithmetic and caller-side cents conversion. Conversion only encodes a JSON number.
const Amount = Schema.String.check(matches("^(?:0|[1-9]\\d{0,8})\\.\\d{2}$")).annotate({
  description:
    "Positive decimal currency units with exactly two fractional digits, at most 999999999.99; never integer cents. One service unit per line.",
});
const InvoiceInput = Schema.Struct({
  requestId: RequestId,
  customerId: PublicId.annotate({ description: "Caller-observed active Customer Id in this company." }),
  currency: Schema.Literal("USD").annotate({
    description:
      "Caller-observed customer currency, restricted to USD for this initial two-decimal write surface. Vendor computes taxes and totals.",
  }),
  exchangeRate: Schema.String.check(matches("^(?:0|[1-9]\\d{0,5})(?:\\.\\d{1,6})?$")).annotate({
    description:
      "Explicit positive home-currency units per transaction-currency unit, at most six decimal places. Use 1 for home currency; no rate is fetched or defaulted.",
  }),
  txnDate: DateOnly.annotate({ description: "Explicit accounting date, YYYY-MM-DD." }),
  dueDate: DateOnly.annotate({ description: "Explicit due date, YYYY-MM-DD, on or after txnDate." }),
  docNumber: Schema.String.check(matches("^[A-Za-z0-9][A-Za-z0-9_-]{0,20}$")).annotate({
    description:
      "Explicit reconciliation label, at most 21 characters; not AUTO_GENERATE. Labels may repeat, so reconcile customer, currency and amounts too.",
  }),
  lines: Schema.Array(
    Schema.Struct({
      itemId: PublicId.annotate({
        description: "Caller-observed active Service item Id; inventory and other item types are refused.",
      }),
      amount: Amount,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
});
const refuse = (message: string) =>
  Effect.fail(new Refusal({ error: new ConnectorCallError("invalid_args", message) }));
const version = { minorversion: "75" } as const;
const charge = Effect.flatMap(Budget, (budget) => budget.charge).pipe(
  Effect.catch((error) =>
    error instanceof ConnectorCallError ? Effect.fail(new Refusal({ error })) : Effect.die(error),
  ),
);

/** Totals and tax are vendor-computed; the authored references, dates and service prices must agree. */
function matchesInvoice(record: Record<string, unknown>, args: typeof InvoiceInput.Type): boolean {
  const lines = Array.isArray(record["Line"]) ? record["Line"] : [];
  const services = lines.filter((line) => object(line)["DetailType"] === "SalesItemLineDetail");
  const expected = args.lines
    .map((line) => JSON.stringify([line.itemId, Number(line.amount), 1, Number(line.amount)]))
    .sort();
  const actual = services
    .map((line) => {
      const row = object(line),
        detail = object(row["SalesItemLineDetail"]);
      return JSON.stringify([object(detail["ItemRef"])["value"], row["Amount"], detail["Qty"], detail["UnitPrice"]]);
    })
    .sort();
  return (
    object(record["CustomerRef"])["value"] === args.customerId &&
    object(record["CurrencyRef"])["value"] === args.currency &&
    record["DocNumber"] === args.docNumber &&
    record["TxnDate"] === args.txnDate &&
    record["DueDate"] === args.dueDate &&
    (record["ExchangeRate"] === Number(args.exchangeRate) ||
      (record["ExchangeRate"] === undefined && Number(args.exchangeRate) === 1)) &&
    lines.every((line) => ["SalesItemLineDetail", "SubTotalLineDetail"].includes(String(object(line)["DetailType"]))) &&
    JSON.stringify(actual) === JSON.stringify(expected)
  );
}

export function quickbooksWrites(connection: Connection, realmId: string) {
  return [
    write(connection, {
      name: "create_customer",
      description:
        "Create a customer once with a DisplayName and optional CompanyName. No contact, tax, bank or payment fields. Reconcile an unknown outcome by exact DisplayName before another intent.",
      destructive: true,
      idempotent: false,
      input: Schema.Struct({ requestId: RequestId, ...CustomerNames }),
      output: NamedRecordShape,
      run: ({ requestId, ...body }) =>
        connection
          .send(customerWrite, { query: { ...version, requestid: requestId }, payload: body })
          .pipe(Effect.map(({ data }) => namedRecord(object(data)["Customer"]))),
    }),
    write(connection, {
      name: "update_customer",
      description:
        "Sparsely update only DisplayName and optional CompanyName using caller-observed Id and SyncToken. A stale version fails; no version fetch or overwrite follows. Omitted CompanyName is unchanged.",
      destructive: true,
      idempotent: false,
      input: Schema.Struct({ requestId: RequestId, Id: PublicId, SyncToken, ...CustomerNames }),
      output: NamedRecordShape,
      run: ({ requestId, ...body }) =>
        connection
          .send(customerWrite, { query: { ...version, requestid: requestId }, payload: { ...body, sparse: true } })
          .pipe(Effect.map(({ data }) => namedRecord(object(data)["Customer"]))),
    }),
    write(connection, {
      name: "create_invoice",
      destructive: true,
      idempotent: false,
      description:
        "Create a real US-company USD accounting invoice, never a draft, once after checking company, active customer/currency and Service items. Dates, DocNumber, exchange rate and one-unit line prices are explicit. EmailStatus is fixed NotSet and online payment flags are false; no email/send operation. Vendor computes taxes/totals. Reconcile unknown outcomes through reads; never blindly create again.",
      input: InvoiceInput,
      output: NamedRecordShape,
      writeSteps: {
        company: "once",
        customer: "once",
        items: {
          maxItems: 20,
          items: (args) => [...new Set(args.lines.map((line) => line.itemId))],
          request: (item) => ({ method: "GET", path: `/item/${item}`, template: "/item/:id", query: version }),
        },
        write: "once",
      },
      run: (args) =>
        Effect.gen(function* () {
          const problem = reportProblem("ProfitAndLoss", { start_date: args.txnDate, end_date: args.dueDate });
          if (problem)
            return yield* refuse("Invoice dates must be real YYYY-MM-DD dates, with dueDate on or after txnDate.");
          if (
            args.docNumber === "AUTO_GENERATE" ||
            Number(args.exchangeRate) <= 0 ||
            args.lines.some((line) => Number(line.amount) <= 0)
          )
            return yield* refuse("Use an explicit DocNumber and positive exchange rate and line amounts.");
          const company = object(
            object(
              (yield* connection.send(
                companyInfo,
                { params: { id: realmId }, query: version },
                { step: "company", effect: "read" },
              )).data,
            )["CompanyInfo"],
          );
          if (company["Id"] !== realmId || company["Country"] !== "US")
            return yield* refuse(
              "Invoice creation is restricted to US companies, where the reviewed invoice-autosend contract applies.",
            );
          yield* charge;
          const customer = object(
            object(
              (yield* connection.send(
                recordReads["customers"]!,
                { params: { id: args.customerId }, query: version },
                { step: "customer", effect: "read" },
              )).data,
            )["Customer"],
          );
          if (
            customer["Id"] !== args.customerId ||
            customer["Active"] !== true ||
            object(customer["CurrencyRef"])["value"] !== args.currency
          )
            return yield* refuse(
              "The customer must be active and have the supplied currency; reread before creating an invoice.",
            );
          for (const itemId of new Set(args.lines.map((line) => line.itemId))) {
            yield* charge;
            const item = object(
              object(
                (yield* connection.send(
                  recordReads["items"]!,
                  { params: { id: itemId }, query: version },
                  { step: "items", item: itemId, effect: "read" },
                )).data,
              )["Item"],
            );
            if (item["Id"] !== itemId || item["Active"] !== true || item["Type"] !== "Service")
              return yield* refuse(
                "Every invoice item must be an active Service item; reread before creating an invoice.",
              );
          }
          yield* charge;
          const { data, status } = yield* connection.send(invoiceWrite, {
            query: { ...version, requestid: args.requestId },
            payload: {
              CustomerRef: { value: args.customerId },
              CurrencyRef: { value: args.currency },
              ExchangeRate: Number(args.exchangeRate),
              TxnDate: args.txnDate,
              DueDate: args.dueDate,
              DocNumber: args.docNumber,
              Line: args.lines.map((line) => ({
                Amount: Number(line.amount),
                DetailType: "SalesItemLineDetail" as const,
                SalesItemLineDetail: {
                  ItemRef: { value: line.itemId },
                  Qty: 1 as const,
                  UnitPrice: Number(line.amount),
                },
              })),
              EmailStatus: "NotSet",
              AllowIPNPayment: false,
              AllowOnlinePayment: false,
              AllowOnlineCreditCardPayment: false,
              AllowOnlineACHPayment: false,
              AllowOnlinePayPalPayment: false,
              AllowOnlineAffirmPayment: false,
            },
          });
          const invoice = object(object(data)["Invoice"]);
          if (!matchesInvoice(invoice, args))
            return yield* Effect.fail(
              new StatusFailure({
                status,
                headers: new Headers(),
                body: undefined,
                operation: { method: "POST", template: "/invoice" },
              }),
            );
          return namedRecord(invoice);
        }),
    }),
  ];
}
