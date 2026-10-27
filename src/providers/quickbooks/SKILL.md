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


## Named writes and reconciliation

The connector defaults to read-only. Deployment code must set `readOnly: false`
to expose named writes; endpoint and pool read-only policies still apply. The
API hatch remains read-only. `create_customer` accepts DisplayName and optional
CompanyName. `update_customer` requires caller-observed Id and SyncToken and
changes only those naming fields with sparse:true. Omitted CompanyName stays
unchanged. A stale-version conflict never fetches a newer version or overwrites
it. Read and review the current record before proposing a new update.
DisplayName must be unique across customers, vendors and employees.

`create_invoice` creates a real accounting transaction, never a draft, for a
verified US company and a customer using USD. This bounds the no-email claim
to the reviewed US autosend contract and money to two-decimal USD units. First
observe an active customer with its CurrencyRef and active Service item Ids.
Supply currency USD, a positive explicit exchange rate, accounting and
due dates, a reconciliation DocNumber and 1–20 lines. Each line is one service
unit with an explicit positive amount in decimal currency units, supplied as a
string with exactly two fractional digits. No prices, dates or exchange rates
are defaulted or fetched. Preflight reads verify the fixed company Country is US
and recheck customer currency and item activity/type; they are not an atomic snapshot. Vendor validation can still
reject changed references. Taxes and totals are computed by QuickBooks: inspect
the returned currency, exchange rate and totals; line sums are not a promise of
an untaxed total. Locale/company tax requirements may reject this narrow body.
No customer/item creation happens implicitly.

Invoice email status is fixed to NotSet; online, IPN, credit-card, ACH, PayPal
and Affirm payment flags are fixed false. No email field or send operation is
exposed. Company invoice-autosend opt-in does not supply the documented
NeedToSend request state. This prevents this creation request from asking Intuit
to email the invoice, including when the customer has an email on file.
Invoice updates are unavailable: preserving an existing send-ready state has
not been established safe, while resetting it would change payment settings.
Deletes, voids, email delivery, charges, refunds, other accounting writes and
arbitrary mutations are unavailable.

Every write requires a caller-generated `requestId`: 1–50 ASCII letters,
digits, underscores or hyphens, starting with a letter or digit. Keep it stable
for the exact intent and unique across requests/tools for this company. It is
sent in Intuit's requestid query parameter with minorversion 75, rather than an
idempotency header. Intuit documents recognizing the same content and ID and
returning the original response; no retention duration is established. This
never permits automatic replay. A dispatched write is sent once even after
401, timeout, server failure or an invalid success response.

After an unknown customer-create outcome, search exact DisplayName, including
inactive records when needed, and inspect the match. For an invoice, search
DocNumber plus CustomerRef and inspect currency, dates, lines and computed
amounts. DocNumber can repeat, so it alone proves nothing. Reconcile and report
ambiguity before considering another create; never generate a fresh requestId
and blindly repeat a potentially committed intent. Unknown update outcomes
need a read of the known Id and version. A requestId is not a lookup endpoint or
a permanent duplicate-prevention guarantee.
