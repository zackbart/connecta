import { hatchDiscovery, type ProviderTable } from "./types.js";

const INVOICE_LINE = "one-unit line prices";
const VERSION_PROPS = {
  Id: "Record Id from search_records.",
  SyncToken: "SyncToken from your latest read of this record.",
};

export const QUICKBOOKS: ProviderTable = {
  tools: {
    create_customer: {
      terse:
        "Create a customer once. No contact, tax, bank or payment fields. Reconcile an unknown outcome by exact DisplayName before another intent.",
      disambiguation:
        "Create a customer once; update_customer renames an existing one. No contact, tax, bank or payment fields. Reconcile an unknown outcome by exact DisplayName before another intent.",
      example:
        'Create a customer once. No contact, tax, bank or payment fields. Reconcile an unknown outcome by exact DisplayName before another intent. Example: {"requestId":"customer-1","DisplayName":"Workshop","CompanyName":"Workshop LLC"}.',
    },
    update_customer: {
      terse:
        "Sparsely update a customer's names using caller-observed Id and SyncToken. A stale version fails; no version fetch or overwrite follows. Omitted CompanyName is unchanged.",
      disambiguation:
        "Rename an existing customer using caller-observed Id and SyncToken from a read. A stale version fails; no version fetch or overwrite follows. Omitted CompanyName is unchanged.",
      example:
        'Sparsely update a customer\'s names using caller-observed Id and SyncToken. A stale version fails; no version fetch follows. Omitted CompanyName is unchanged. Example: {"requestId":"rename-1","Id":"51","SyncToken":"0","DisplayName":"Workshop Two"}.',
      properties: { disambiguation: VERSION_PROPS },
    },
    update_unsent_invoice: {
      terse:
        "Change only DocNumber on an unsent US-company USD invoice using caller-observed Id and SyncToken. Preflight refuses unknown, send-ready, delivered or payment-enabled state and stale versions. Reconcile by reading the Id; never replay.",
      disambiguation:
        "Change only DocNumber on an unsent invoice using caller-observed Id and SyncToken from get_record. Preflight refuses unknown, send-ready, delivered or payment-enabled state and stale versions. Reconcile by reading the Id; never replay.",
      example:
        'Change only DocNumber on an unsent US-company USD invoice using caller-observed Id and SyncToken. Preflight refuses unknown, send-ready, delivered or payment-enabled state and stale versions. Reconcile by reading the Id; never replay. Example: {"requestId":"doc-1","Id":"41","SyncToken":"0","docNumber":"INV-7"}.',
      properties: { disambiguation: VERSION_PROPS },
    },
    create_invoice: {
      terse: `Create a real US-company USD invoice, never a draft, once after checking company, active customer/currency and Service items, with ${INVOICE_LINE}. No email/send. Vendor computes taxes/totals. Reconcile unknown outcomes through reads; never blindly create again.`,
      disambiguation: `Create a real US-company USD invoice, never a draft, once after checking company, active customer/currency and Service items through search_records, with ${INVOICE_LINE}. No email/send. Vendor computes taxes/totals. Reconcile unknown outcomes through reads; never blindly create again.`,
      example: `Create a real US-company USD invoice, never a draft, once after checking company, active customer/currency and Service items. No email/send. Vendor computes taxes/totals. Reconcile unknown outcomes through reads; never blindly create again. Example: {"requestId":"inv-1","customerId":"51","currency":"USD","exchangeRate":"1","txnDate":"2026-10-01","dueDate":"2026-10-31","docNumber":"INV-7","lines":[{"itemId":"9","amount":"125.00"}]}.`,
      properties: {
        disambiguation: { lines: "One entry per Service item billed." },
      },
    },
    get_company_info: {
      terse: "Read the company's accounting identity without contact or tax identifiers.",
      disambiguation: "Confirm which company this connection reads, without contact or tax identifiers.",
      example:
        'Read the company\'s accounting identity without contact or tax identifiers. Example: {"fields":["Id"]}.',
    },
    search_records: {
      terse:
        "Search accounting records with structured filters. Customer and vendor names are exact DisplayName matches. No raw SQL. Inactive master records need an explicit Active filter.",
      disambiguation:
        "Find accounting records and their ids; get_record reads one known Id. Customer and vendor names are exact DisplayName matches. No raw SQL. Inactive master records need an explicit Active filter.",
      example:
        'Search accounting records. Customer and vendor names are exact DisplayName matches. No raw SQL. Inactive master records need an explicit Active filter. Example: {"entity":"invoices","filters":[{"field":"CustomerRef","operator":"eq","value":"51"}],"limit":100}.',
      properties: {
        disambiguation: { "filters[].value": "Exact value for eq; a date or amount for ordered comparisons." },
      },
    },
    get_record: {
      terse:
        "Read one accounting record by Id, with its SyncToken version. Contact details and payment credentials are withheld.",
      disambiguation:
        "Read one record by Id, with the SyncToken writes need; DocNumber is a separate label. Contact details and payment credentials are withheld.",
      example:
        'Read one accounting record by Id, with its SyncToken version. Contact details and payment credentials are withheld. Example: {"entity":"invoices","id":"41","fields":["Id","SyncToken"]}.',
    },
    get_report: {
      terse:
        "Read a Profit & Loss, Balance Sheet, Cash Flow or aging report. Preserve nested Rows; empty amount strings mean no value, never zero. P&L and Cash Flow take start_date. Reports retain vendor currency; no currency conversion.",
      disambiguation:
        "Read a financial report rather than summing records. Preserve nested Rows; empty amount strings mean no value, never zero. P&L and Cash Flow take start_date. Reports retain vendor currency; no currency conversion.",
      example:
        'Read a financial report. Preserve nested Rows; empty amount strings mean no value, never zero. P&L and Cash Flow take start_date. Reports retain vendor currency; no currency conversion. Example: {"report":"ProfitAndLoss","start_date":"2026-10-01","end_date":"2026-10-31"}.',
    },
    ...hatchDiscovery(
      "QuickBooks Online",
      '{"query":"invoice"}',
      '{"method":"GET","path":"/invoice/{id}"}',
      "quickbooks",
    ),
    quickbooks_api_read: {
      terse: "Read a reviewed QuickBooks Online API operation; raw SQL is refused.",
      disambiguation:
        "Read a record, company or report field the named reads omit; search_records runs bounded queries, and raw SQL is refused.",
      example: 'Read a reviewed QuickBooks Online API operation; raw SQL is refused. Example: {"path":"/invoice/41"}.',
    },
  },
};
