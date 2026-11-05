---
{"name":"quickbooks","instructionsHeading":"Company instructions"}
---

## Identity and joins

`Id` identifies a record within this company and record family. `DocNumber` is a
label that can repeat; never use it as an Id. `SyncToken` is the public record
version, not a credential. References carry the target Id in `value`: invoice
`CustomerRef`, bill `VendorRef`, payment `Line.LinkedTxn`.

Payment and BillPayment are accounting records; reading one executes nothing.
Desktop, Payments, Payroll and attachments are outside this connection.

## Money, time and reports

Amounts are decimal currency units, not cents. Never sum unlike currencies;
preserve `CurrencyRef` and `ExchangeRate`. `TxnDate` is an accounting date, not
a UTC instant; `MetaData` timestamps carry their own offset. Customer and vendor
searches omit inactive records unless `Active` selects them.

Reports are trees. Read column metadata with row values, because order and
labels can change. Empty amounts mean no value, not zero. Do not flatten sections
or add totals to their component rows. Before comparing reports, check period,
basis, currency and `NoReportData`. Aging is an as-of snapshot, not a transaction
range.

Return aggregates and the few records the task needs, not full customer or
vendor directories.

<!-- when: writes -->
## Writes

Deletes, voids, email delivery, charges, refunds and other accounting writes are
unavailable. `DisplayName` must be unique across customers, vendors and employees.

**requestId.** Keep it stable for one exact intent and unique across requests
and tools for this company. It never permits replay, and it is neither a lookup
nor a lasting duplicate guarantee. Never generate a fresh one to repeat an intent
that may have committed.

**create_invoice** creates a real transaction, never a draft, and creates no
customer or item implicitly. First observe an active customer with its
`CurrencyRef` and active Service item Ids. Nothing is defaulted, and amounts are
strings with exactly two decimals. QuickBooks computes taxes and totals, so inspect
the returned currency, rate and totals; line sums do not promise an untaxed total.
Company tax rules may still reject it. Preflight reads are not an atomic snapshot,
and each spends call-admission budget. Contradictory returned values mean an
unknown outcome.

**Email.** No email or send operation exists; creation fixes `NotSet` and false
payment flags, so it does not ask Intuit to email the invoice.
`update_unsent_invoice` changes only `DocNumber` and refuses missing, send-ready
or delivered state. `NotSet` cannot prove no earlier delivery occurred.

**Stale versions.** A conflict never fetches or overwrites a newer version. Read
and review the record before proposing another update.

**Unknown outcome: reconcile, never resend.**

- Customer: search the exact `DisplayName`, including inactive records.
- Invoice: search `DocNumber` plus `CustomerRef`, then inspect currency, dates,
  lines and amounts. `DocNumber` alone proves nothing.
- Update: read the known Id and its version.

Report any ambiguity before considering another create.
<!-- end -->
