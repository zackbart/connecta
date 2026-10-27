---
{"name":"quickbooks","instructionsHeading":"Company instructions"}
---

## Accounting identity and joins

An Id identifies a record inside this company and record family. DocNumber is
a human label, may repeat, and is not an Id. SyncToken is the public record
version used for concurrency control, not an OAuth credential. References carry
the target Id in value; invoice CustomerRef joins Customer, bill VendorRef
joins Vendor, and payment Line.LinkedTxn joins invoices or bills.

Accounting Payment and BillPayment records describe received and paid money;
reading them does not execute a payment. Desktop, Payments, Payroll, attachments,
and unreviewed accounting entities are outside this connection.

## Money, time and reports

Amounts use decimal currency units, never integer cents. Preserve CurrencyRef
and ExchangeRate when combining transactions; never sum unlike currencies.
TxnDate is the company's accounting date, not a UTC instant. MetaData timestamps
carry their own offset. Customer and vendor searches omit inactive records
unless the Active filter explicitly selects them.

Reports are trees with Header, Columns, nested Rows and section summaries.
Read column types and metadata together with row values; column order and
section labels can change. Empty amount strings mean no value, not zero.
Do not flatten away section identity or add totals to their component rows.
Check the returned period, basis, currency and NoReportData option before
comparing reports. Aging is an as-of snapshot, rather than a transaction range.

Return aggregates and the few identifying records the task needs; avoid
copying full customer or vendor directories into the conversation.
