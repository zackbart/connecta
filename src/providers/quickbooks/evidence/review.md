# QuickBooks Online provider — contributor review

Reviewed 2026-10-26. This is a hand-authored, restricted Accounting API v3
adapter. No verified official REST OpenAPI was found; none is invented here.
The drift checker intentionally reports `operation-unrecorded` for the typed
operations. Manual checks record the review date, not a digest of our own
declarations as evidence of a vendor contract.

## Upstream data model and licensing

The official [Intuit Java SDK](https://github.com/intuit/QuickBooks-V3-Java-SDK/tree/18ceebf026f65d98870276f67e1d11803bcacd81/ipp-v3-java-data/src/main/xsd)
at commit `18ceebf026f65d98870276f67e1d11803bcacd81` supplies `Finance.xsd`,
`IntuitBaseTypes.xsd`, `IntuitNamesTypes.xsd`, `Report.xsd` and
`IntuitRestServiceDef.xsd`. These describe data and service envelopes, not an
HTTP method/path/query contract. Consulted for entity identity, references,
SyncToken and the nested report model. They are not retained or compiled.
No SDK source, generated SDK code or XSD bytes are redistributed.

[LICENSE.txt](https://github.com/intuit/QuickBooks-V3-Java-SDK/blob/18ceebf026f65d98870276f67e1d11803bcacd81/LICENSE.txt)
is Apache-2.0 and includes `Copyright 2016 Intuit, Inc.`. This attribution and
the immutable links record provenance; no third-party archive is bundled.
The XSD's desktop-only fields and broad entity set do not establish Online
availability. We retain only explicitly reviewed accounting response fields.

## REST and OAuth sources

- [Intuit discovery](https://developer.intuit.com/.well-known/openid_configuration)
  confirms authorization at `https://appcenter.intuit.com/connect/oauth2` and
  token exchange at `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`.
- [OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
  documents access tokens lasting one hour. The existing OAuth engine uses
  returned `expires_in`, seals tokens and coordinates refresh/rotation; this
  provider adds no grant metadata or assumed expiry response fields. Intuit's
  documented confidential-client flow uses Basic auth; PKCE is not advertised
  by the discovery document, so this adapter disables it.
- The official [OAuth JavaScript client](https://github.com/intuit/oauth-jsclient/blob/master/src/OAuthClient.js)
  confirms the discovery revocation URL and Basic-authenticated JSON POST
  containing `token`. Disconnect uses that fixed endpoint with the latest
  refresh token after local grant removal, through the shared bounded
  revocation flow; it never follows redirects or retries.
- Intuit may return unchanged refresh-token bytes across hourly access-token
  refreshes; see the official [SDK authorization guide](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/docs/_sources/authorization.rst.txt).
  Always persist the latest returned tokens. A successfully committed refresh
  permits a subsequent coordinated generation, while outstanding or ambiguous
  attempts stay blocked. No provider-specific expiry fields are assumed.
- [Official refresh-policy announcement](https://medium.com/intuitdev/important-changes-to-refresh-token-policy-8443779d40db)
  (2025-11-12) caps refresh authorization at five years while retaining the
  rolling 100-day usage requirement. Rotation does not restart the absolute
  window. Reauthorization remains necessary; no invented hard-expiry field is
  read or persisted by this adapter.
- [Official minor-version announcement](https://medium.com/intuitdev/changes-to-our-accounting-api-that-may-impact-your-application-c330bd1a06f5)
  says versions 1–74 are ignored from 2025-08-01. This adapter explicitly uses
  the verified supported floor 75; it does not claim 75 is the latest version.
  Intuit's current [official complete documentation feed](https://static.developer.intuit.com/v2/llms-full.txt)
  lists 75 as the newest published minor version in its minor-version table,
  and repeats the ignored-below-75 policy. The feed was inspected without
  retaining its approximately 29 MB contents in this repository.
- [Official report-migration announcement](https://medium.com/intuitdev/upcoming-changes-to-reports-apis-5083ec9aadce)
  requires modernized responses after 2026-08-31. Retain hierarchy, metadata,
  blank values, changed row ordering and section types; do not assume a metric
  occupies a fixed column. The five exposed report names are in its supported
  list. No temporary `testing_migration` parameter is sent.
- [Official Postman workspace](https://www.postman.com/intuit-developer/intuit-developer-quickbooks-online-accounting-api/overview)
  confirms the broad `com.intuit.quickbooks.accounting` scope, OAuth and
  reviewed Accounting entities/reports. It is not a licensed REST OpenAPI pin.
- [Query language](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries)
  and [BillPayment reference](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/billpayment)
  establish SQL-like query paging and read paths. Named SQL uses a closed entity,
  field and operator set, backslash/apostrophe escaping and builder-owned
  STARTPOSITION/MAXRESULTS. Raw query access is refused by the hatch.

Some developer-reference pages deliver a JavaScript-only shell to unauthenticated
fetches. Report parameter support remains deliberately narrow; vendor snapshots
and published-edge acceptance journeys must validate actual request semantics.
No claim of complete REST schema or automatic vendor-drift coverage is made.
The official PHP SDK's
[ReportService](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/ReportService/ReportService.php)
also identifies `report_date`, `aging_method`, `start_date`, `end_date` and
`accounting_method` as report parameters. Named aging end_date maps to the
snapshot report_date with aging_method Report_Date. No verified currency
override is exposed; returned Header.Currency is preserved. This restriction
avoids silently sending an undocumented currency parameter that Intuit may
ignore. P&L and Balance Sheet support basis; Cash Flow retains vendor basis.
The current feed also corroborates one-hour access, rolling 100-day refresh
and absolute five-year validity. No SDK files are redistributed.
Its [call-limit contract](https://developer.intuit.com/quickbooks-online/docs/learn/limits-and-throttles)
documents 500 requests/minute/company, 10 requests/second/company/app and a
60-second wait after 429. The error adapter honors at least that delay, or a
longer returned Retry-After. Deployments may supply a local admission policy;
it cannot model other apps' or runtimes' spending.

## Value and URL safety

`safety.ts` uses closed accounting projections before either named tools or
hatches can observe results. SyncToken is a public concurrency version and is
explicitly preserved. Unknown response fields, credentials, private notes,
contact emails/phones/addresses, person-name components, tax identifiers,
bank/card details and private-link fields are omitted. Minimal DisplayName,
company names and reference names remain for identity resolution. Financial
account Id references are not bank routing/account numbers. URL text in allowed
labels is withheld, including embedded signed destinations. Errors withhold
vendor prose entirely. Fields selection only narrows this already-safe result;
no option widens it. Report cells preserve strings and empty values, with the
same URL boundary. No binary content is supported.

## Bounded write follow-on (#1079)

Reviewed 2026-10-27 against the current official public documentation feed
(split by Source in memory; no archive retained) and Intuit's official SDK.
The named surface adds customer creation, sparse naming updates and invoice
creation. No auth, storage or runtime dependencies change. POST contracts are
indexed for value safety and discovery refusal, never a write hatch.

- [Basic fields / request ID](https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-field-definitions#request-id)
  establishes a query parameter named requestid, uniqueness across requests for
  one realm, maximum 50 characters outside batch, and recognition of repeated
  content plus ID with the original response. It establishes no retention
  duration. The narrower ASCII syntax is local policy. The kit's header-key
  facility is deliberately unused; requestId is a required named argument,
  and no duplicate-safe replay advice is inferred from it.
- [Accounting API update operations](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api)
  and the [official PHP synchronous-call guide](https://developer.intuit.com/app/developer/qbo/docs/develop/sdks-and-samples-collections/php/synchronous-calls)
  establish that sparse:true changes supplied fields and preserves omitted
  fields. The pinned Java IntuitEntity schema above establishes Id/SyncToken
  concurrency. [Common errors](https://developer.intuit.com/app/developer/qbo/docs/develop/troubleshooting/handling-common-errors)
  identifies stale version 5010 and duplicate name 6240, including DisplayName
  uniqueness across Customer/Vendor/Employee. Only those facts and existing 610
  are allowlisted; wording never includes vendor prose. No version is fetched
  or substituted on an update failure.
- The official PHP SDK at
  [8bf471f08c39dffc4851f4d0714d43366a1ae857](https://github.com/intuit/QuickBooks-V3-PHP-SDK/tree/8bf471f08c39dffc4851f4d0714d43366a1ae857/src/_Samples)
  supplies CustomerCreate.php and CustomerSparseUpdate.php for the naming
  fields and sparse update. InvoiceCreate.php corroborates SalesItemLineDetail
  with ItemRef, Amount and CustomerRef. SDK examples are field evidence, not
  proof of no-email behavior; broad contact fields in examples are excluded.
  No SDK bytes are copied, compiled or redistributed.
- [Invoice workflow](https://developer.intuit.com/app/developer/qbo/docs/workflows/create-an-invoice)
  and [REST features](https://developer.intuit.com/app/developer/qbo/docs/learn/rest-api-features)
  establish POST /v3/company/{realmId}/invoice and its line/reference body.
  [Multicurrency](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-multiple-currencies)
  defines CurrencyRef, home-units-per-foreign-unit ExchangeRate and computed
  totals. The workflow explicitly describes vendor-computed sales tax. The
  pinned Java Transaction/SalesTransaction/Invoice and ItemLineDetail schemas
  corroborate dates, DocNumber (21-character QBO limit and AUTO_GENERATE
  sentinel), references, price/quantity and payment flags. The caller supplies
  dates/rate/number/prices; no mutable defaults are silently substituted.
  Preflight reads verify US company identity, active USD customer and active Service items,
  without implying an atomic snapshot or a tax-free total. Two-decimal amount
  strings and six-decimal rate precision are conservative local bounds;
  conversion encodes JSON numbers without multiplication, addition or cents
  conversion. Unsupported company/locale tax requirements fail at Intuit.

### Invoice email safety and deferred updates

The authoritative [basic invoicing implementation, Configure invoice autosend](https://developer.intuit.com/app/developer/qbo/docs/develop/basic-implementations/basic-invoicing-implementation#configure-invoice-autosend)
was present in the current official feed. The official
[August 2026 release note](https://developer.intuit.com/app/developer/qbo/docs/release-notes/general-release-notes)
links that documentation addition. This is vendor documentation, not the
community anecdotes or SDK field examples previously available.

It documents US imported-invoice autosend requiring Payments activation, a
customer email, company opt-in under Sales / Automatically send imported
invoices, and online credit-card or ACH acceptance. Its Accounting API
instructions additionally require EmailStatus NeedToSend with BillEmail.
Creation first reads the fixed CompanyInfo and requires Country US; it also
requires a USD customer and caller-specified USD to bound decimal precision.
Other companies/currencies fail before POST. Our inference from those
documented required conditions: an explicit NotSet
creation request, with payment flags disabled, does not request this autosend
behavior even when company opt-in and a stored customer email exist. The fixed
body sets NotSet and IPN/online/card/ACH/PayPal/Affirm flags false, omits email
fields, uses only the accounting scope and never invokes /send. Current official
[Sales Order invoice responses](https://developer.intuit.com/app/developer/qbo/docs/workflows/manage-sales-orders/use-cases)
also corroborate the PayPal/Affirm flags. The pinned official PHP SDK's
[IPPInvoice model](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/8bf471f08c39dffc4851f4d0714d43366a1ae857/src/Data/IPPInvoice.php)
defines both as writable boolean properties; these fields are not inferred
solely from a sample response. None of these values is caller configurable. This is a real accounting invoice, never a draft. Contradictory returned email/payment states fail as unknown outcomes instead
of confirming an unsent creation. No claim is made about unrelated automations
operated by other integrations.

Invoice updates are deliberately deferred. The public REST/GraphQL comparison
shows a sparse DueDate update, but it does not establish suppression of email
when an existing invoice retains NeedToSend and enabled payment settings.
Disabling those values would alter more than the intended date/number fields.
Unblock update_invoice with authoritative update-specific no-email evidence
that preserves existing payment/delivery settings, or an explicitly approved
broader update contract. No update or arbitrary mutation hatch is exposed.

### Invoice update investigation (#1087)

Rechecked 2026-10-27 after inspecting merged
[#1086](https://github.com/zackbart/connecta/pull/1086), its provider contracts,
failure probes and stateful write journey. The current
[official documentation feed](https://static.developer.intuit.com/v2/llms-full.txt)
was fetched and split by its Source headings in memory; no feed or SDK bytes
are retained. The developer pages sometimes return only a JavaScript shell.
The feed supplies the implementation, sparse-update, request-ID, error and
release-note text; the public Invoice reference supplies the entity-specific
business rules and update sections. Community answers are not contract evidence.

The reviewed contracts establish distinct guarantees:

| Authoritative source                                                                                                                                                                                                                            | Established behavior                                                                                                                                                                                                                                                                         | Remaining gap                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Invoice reference: Business Rules, Sparse update an invoice, Full update an invoice, Send an invoice](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice)                                                 | Sparse updates retain omitted fields. Full updates clear omitted writable fields. The US autosend business rule depends on online payments, company opt-in, customer email and invoice credit-card/ACH acceptance. The separate send operation updates EmailStatus and delivery information. | A separate send endpoint does not establish that updates cannot trigger autosend. No reviewed update-specific suppression control or no-email guarantee covers existing send-ready invoices. |
| [Basic invoicing: Configure invoice autosend](https://developer.intuit.com/app/developer/qbo/docs/develop/basic-implementations/basic-invoicing-implementation#configure-invoice-autosend)                                                      | The imported-invoice workflow describes company and payment prerequisites, plus EmailStatus NeedToSend and BillEmail in the Accounting API payload.                                                                                                                                          | It does not state whether an update evaluates retained values, newly supplied values, a status transition or a background import event.                                                      |
| [Accounting API: Making sparse updates](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api)                                                                                                            | sparse:true changes the supplied writable fields without clearing omitted attributes.                                                                                                                                                                                                        | Field preservation does not establish absence of delivery side effects.                                                                                                                      |
| [Invoice SyncToken](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice) and [5010: Stale Object Error](https://developer.intuit.com/app/developer/qbo/docs/develop/troubleshooting/handling-common-errors) | Updates use the record's concurrency version; an older version fails.                                                                                                                                                                                                                        | Version checking does not suppress email. Fetching and substituting a newer version would admit an intent against state the caller never observed.                                           |
| [Basic fields: Request ID](https://developer.intuit.com/app/developer/qbo/docs/learn/learn-basic-field-definitions#request-id)                                                                                                                  | requestid is company-wide, at most 50 characters outside batch, and recognizes repeated identical content and ID.                                                                                                                                                                            | It does not suppress delivery on the first execution or establish a retention period. It does not relax Connecta's one-attempt rule.                                                         |
| [August 2026 documentation update](https://developer.intuit.com/app/developer/qbo/docs/release-notes/general-release-notes)                                                                                                                     | The release note announces the US imported-invoice autosend documentation.                                                                                                                                                                                                                   | It adds no update-specific no-email contract. SDK fields and sample sparse DueDate updates add none either.                                                                                  |

Intuit also documents a separate delivery path:
[automatic invoice reminders](https://quickbooks.intuit.com/learn-support/en-us/help-article/invoicing/send-invoice-reminders-automatically-manually/L84cQjpxo_US_en_US)
are scheduled relative to DueDate for unpaid invoices already emailed to the
customer. This is a product behavior contract, not an API update-suppression
contract. Our inference is that changing DueDate can affect future reminder
eligibility even when EmailStatus and payment settings remain unchanged;
absence of a synchronous send request does not establish absence of later
delivery. A no-email contract must distinguish immediate autosend from these
scheduled reminders.

**Decision: invoice updates remain unavailable; #1087 stays open.** For example,
an existing invoice may retain NeedToSend, BillEmail and enabled card/ACH
acceptance while its company has autosend enabled. A sparse DueDate or
DocNumber request preserves those prerequisites. The sources above do not
establish that this request cannot cause delivery. Setting NotSet or disabling
payments changes the invoice beyond the requested edit. Checking a response
after dispatch cannot undo delivery. The creation-only fixed body and its
fake-vendor evidence in #1086 do not establish update behavior. No live account,
sandbox accounting mutation or real invoice was used to resolve the gap.

### Proposed restricted update surface (not implemented)

The concrete candidate for independent contract review is
`update_unsent_invoice`, restricted to a verified US company and an existing
USD invoice whose EmailStatus is explicitly NotSet and whose IPN, online,
card, ACH, PayPal and Affirm flags are all explicitly false. Missing or unknown
values fail closed; neither omission nor the absence of DeliveryInfo proves
that an invoice is unsent. NeedToSend, EmailSent and any enabled payment option
are refused without a POST. No invoice is reset to qualify. This restriction
would remove the documented autosend prerequisites while preserving the
accepted invoice's existing settings; applying those prerequisites to updates
remains an inference requiring explicit review or update-specific Intuit
confirmation. It is not a shipped safety guarantee or authorization to add a
tool. A general update preserving send-ready state still requires an
authoritative no-delivery contract or documented suppression mechanism.
NotSet is a writable status, not established proof that no earlier delivery
occurred; the candidate also needs authoritative clarification of delivery
history and reminder eligibility. Public responses can omit payment flags,
so requiring explicit false values may reject otherwise eligible invoices.
The candidate's practical availability is not established.

The proposed implementation and acceptance boundary is:

- Accept only caller-observed Id and SyncToken, a stable requestId, and at
  least one of DueDate or DocNumber. Reuse the existing date, document-number,
  request-ID and public-identity bounds; reject AUTO_GENERATE, unknown fields
  and an invalid date relative to the observed TxnDate. No lines, customer,
  amounts, currency, exchange rate, delivery or payment fields are editable.
- Read the fixed company and the raw invoice for safety validation, charging
  every auxiliary request to the same call-admission budget. Require matching
  Id and the caller's exact SyncToken. These reads validate eligibility, never
  supply a replacement version. A changed version refuses the intent; a race
  after the check must produce the vendor's stale conflict, with no refresh,
  overwrite or second POST.
- Send only Id, the caller's SyncToken, sparse:true and the requested fields
  to the fixed company invoice endpoint, with minorversion 75 and requestid.
  Omit existing payment/delivery fields so they remain unchanged. Never invoke
  send, batch, void, delete or an arbitrary write hatch. Require explicit
  readOnly:false and retain endpoint/pool policy and the read-only hatch.
- Validate returned identity, version, edited values and preserved accounting
  and delivery/payment state before acknowledging success. An uncertain or
  contradictory reply, including a committed write answered 401, transport
  failure, HTTP 500 or malformed success, remains nonretryable and unknown.
  Reconcile by reading the known invoice Id; no automatic POST replay, fresh
  requestId or fetch-and-overwrite recovery follows.
- Extend the existing Node SQLite/QuickJS and native Workers/D1 journeys only
  when the contract is accepted. Grade independent invoice state, exact sparse
  intent and physical sends: one winner and one stale conflict in a race;
  unchanged lines, amounts, customer and payment/delivery settings; zero POSTs
  for send-ready/unknown-state invoices and policy refusals; one POST for each
  committed-but-failed intent followed by read reconciliation. Include a
  company with autosend enabled and stored customer contact. Check named,
  hatch and fields projections, emitted results, activity and error secrecy.
  Controls must reject duplicate sends, a substituted SyncToken, changed
  omitted fields, fabricated state and private payload leakage.

These journeys would defend an accepted contract, not discover or prove
Intuit's undocumented email behavior. The existing write journey's stale
customer race and creation recovery remain evidence for those shipped tools
only. This investigation adds no simulated invoice-update implementation or
passing update evidence. The unrelated patch release need not wait for #1087.
