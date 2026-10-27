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
