/**
 * Safety rules and required prerequisites every arm must keep. Each pattern is
 * read against the tool description and all its property text, so a rule may
 * live in either place. `armViolations` also runs these against today's text:
 * a pattern that today's text does not satisfy is a bug in this table.
 *
 * Kept here: refusals and scope limits an agent would otherwise assume away,
 * write semantics, exactly-once and reconciliation rules, value-safety and
 * privacy statements, units, id prerequisites, and required argument shapes
 * the schema cannot state. Not kept: restated schema facts, pitch and synonyms.
 */
export interface ProtectedClause {
  readonly id: string;
  readonly pattern: RegExp;
}

const clause = (id: string, pattern: RegExp): ProtectedClause => ({ id, pattern });

export const PROTECTED: Readonly<Record<string, Readonly<Record<string, readonly ProtectedClause[]>>>> = {
  stripe: {
    get_balance_summary: [clause("minor units", /minor units/i)],
    stripe_api_search: [clause("reads no data", /reads no account data/i)],
    stripe_api_details: [clause("reads no data", /reads no account data/i)],
    stripe_api_read: [
      clause("cursor continuation", /page\.nextCursor/),
      clause("anchors only first", /starting_after or ending_before/),
      clause("no query string", /no query string/i),
    ],
    stripe_api_write: [
      clause("idempotency sent", /POST sends an Idempotency-Key/i),
      clause("delete has no key", /DELETE[^.]*none/i),
      clause("key reuse", /Reuse this key with the exact original arguments/),
      clause("no uploads", /Upload files in the Stripe Dashboard/i),
      clause("no query string", /no query string/i),
    ],
  },
  github: {
    github_api_search: [clause("reads no data", /reads no account data/i)],
    github_api_details: [clause("reads no data", /reads no account data/i)],
    github_api_read: [
      clause("slash encoding", /%2F/),
      clause("owner refs refused", /Owner-prefixed object refs are refused/i),
      clause("head filter", /login:branch/),
      clause("no raw pages or diffs", /raw page numbers, diffs and log downloads are refused/i),
    ],
    github_api_write: [clause("release only", /release/i), clause("merge sibling", /merge_pull_request/)],
    search_scoped: [
      clause("literal terms", /Literal words only; qualifiers and Boolean operators are refused/i),
      clause("within scopes", /configured scopes|within scopes/i),
    ],
    list_scopes: [clause("omit owner", /omit for local grants/i)],
    merge_pull_request: [
      clause("same repository", /same-repository/i),
      clause("once", /\bonce\b/i),
      clause("head sha guard", /head SHA/i),
      clause("workflow scope", /workflow-write/i),
      clause("failed preflight", /failed preflight sends no merge/i),
      clause("reread on conflict", /reread after a conflict/i),
    ],
  },
  cloudflare: {
    list_accounts: [clause("pinned only", /pinned/i)],
    list_zones: [clause("pinned only", /pinned/i)],
    verify_credential: [clause("first after auth failure", /auth_required/)],
    graphql_query: [
      clause("no mutations", /Mutations and subscriptions are refused/i),
      clause("tag filter", /zoneTag/),
    ],
    cloudflare_api_upload: [
      clause("no local files", /never reads local files/i),
      clause("key encoding", /encode a \/ inside an R2 or KV key as %2F/i),
      clause("body exclusivity", /exclusive with base64Body and parts/i),
    ],
    cloudflare_api_search: [clause("reads no data", /reads no account data/i)],
    cloudflare_api_details: [clause("reads no data", /reads no account data/i)],
    cloudflare_api_read: [
      clause("envelope", /retains the Cloudflare envelope/i),
      clause("cursor location", /page\.nextCursor in page\.param within page\.in/),
      clause("string body", /string body/i),
    ],
    cloudflare_api_write: [
      clause("upload sibling", /cloudflare_api_upload/),
      clause("wire formats", /text\/SQL and NDJSON/i),
    ],
  },
  ccb: {
    get_individual: [clause("rate limit", /one call a second/i)],
    get_event_attendance: [clause("drops pastoral text", /leader notes and prayer requests/i)],
    list_individual_notes: [clause("pastoral reduction", /Pastoral content; reduce before returning/i)],
    get_giving_metrics: [
      clause("no per-gift amounts", /No per-gift amounts/i),
      clause("twelve months", /12 months/),
      clause("exactly one id", /Exactly one of individualId or familyId/i),
    ],
    search_records: [clause("details before body", /operation details/i)],
    ccb_api_search: [clause("reads no data", /reads no account data/i)],
    ccb_api_details: [clause("reads no data", /reads no account data/i)],
    ccb_api_read: [clause("no query string", /no query string/i)],
    ccb_api_write: [
      clause("authorized scopes", /authorized configured scopes/i),
      clause("no query string", /no query string/i),
    ],
  },
  quickbooks: {
    create_customer: [
      clause("once", /\bonce\b/i),
      clause("no sensitive fields", /No contact, tax, bank or payment fields/i),
      clause("reconcile", /Reconcile an unknown outcome by exact DisplayName/i),
      clause("request id", /Never reuse for changed content/i),
    ],
    update_customer: [
      clause("caller-observed version", /caller-observed Id and SyncToken/i),
      clause("stale fails", /stale version fails/i),
      clause("omitted unchanged", /Omitted CompanyName is unchanged/i),
      clause("request id", /Never reuse for changed content/i),
    ],
    update_unsent_invoice: [
      clause("caller-observed version", /caller-observed Id and SyncToken/i),
      clause("preflight refusals", /refuses unknown, send-ready, delivered or payment-enabled/i),
      clause("no replay", /never replay/i),
      clause("request id", /Never reuse for changed content/i),
    ],
    create_invoice: [
      clause("real, not draft", /never a draft/i),
      clause("once", /\bonce\b/i),
      clause("checks first", /after checking company, active customer\/currency and Service items/i),
      clause("no send", /no email\/send/i),
      clause("no blind retry", /never blindly create again/i),
      clause("vendor computes totals", /Vendor computes/i),
      clause("two decimals", /never integer cents/i),
      clause("no default rate", /no rate is fetched or defaulted/i),
      clause("request id", /Never reuse for changed content/i),
    ],
    get_company_info: [clause("withheld identifiers", /without contact or tax identifiers/i)],
    search_records: [
      clause("exact names", /exact DisplayName/i),
      clause("no sql", /No raw SQL/i),
      clause("inactive filter", /Inactive master records need an explicit Active filter/i),
    ],
    get_record: [
      clause("not doc number", /never DocNumber/i),
      clause("sync token", /SyncToken/),
      clause("withheld", /Contact details and payment credentials are withheld/i),
    ],
    get_report: [
      clause("empty is not zero", /empty amount strings mean no value, never zero/i),
      clause("no conversion", /no currency conversion/i),
      clause("start_date scope", /start_date/),
    ],
    quickbooks_api_search: [clause("reads no data", /reads no account data/i)],
    quickbooks_api_details: [clause("reads no data", /reads no account data/i)],
    quickbooks_api_read: [clause("raw sql refused", /raw SQL is refused/i)],
  },
  sheets: {
    get_spreadsheet: [clause("no cell values", /never cell values/i), clause("find via drive", /search Drive/i)],
    get_values: [clause("cut marker", /cut with a marker/i), clause("paged by cells", /paged by cell count/i)],
    update_values: [clause("overwrites", /overwriting/i), clause("append sibling", /append_values/)],
    batch_update_values: [clause("overwrites", /overwriting/i), clause("atomic", /All succeed or none do/i)],
    append_values: [clause("no overwrite", /nothing below is overwritten/i)],
    clear_values: [clause("values gone", /values are gone/i), clause("keeps formatting", /keeping formatting/i)],
    create_spreadsheet: [clause("my drive root", /My Drive root/i), clause("not shared", /not shared/i)],
    add_sheet: [clause("title taken fails", /Fails if the title is taken/i)],
    batch_update_spreadsheet: [clause("can destroy data", /can destroy data/i), clause("atomic", /atomically/i)],
    sheets_api_search: [clause("reads no data", /reads no account data/i)],
    sheets_api_details: [clause("reads no data", /reads no account data/i)],
    sheets_api_read: [
      clause("vendor mask", /query\.fields is Google's vendor mask/i),
      clause("no value page token", /no vendor page token/i),
      clause("relative paths", /relative to \/v4/i),
    ],
    sheets_api_write: [
      clause("batch shape", /1–100 requests, exactly one reviewed kind each/),
      clause("refused previews", /Preview comments and external data-source/i),
      clause("append overwrite danger", /OVERWRITE and destroy existing cells/i),
      clause("no idempotency", /No revision guarantee or idempotency key/i),
    ],
  },
};
