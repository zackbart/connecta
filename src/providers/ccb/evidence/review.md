# CCB v2 surface review

Contributor evidence for decision 0011 step 2, reviewed 2026-10-24.

## Source and coverage

The exact public bytes are `openapi.document.json`, downloaded from
https://docs.pushpay.io/chms-v2/openapi/chms-api-specs.json?download=1.
The bare URL answered 403 on this host; the official download query returned
504,399 bytes. SHA-256:
`2f532bfdcd2c4d40add8373218d3ea371c215ad7d754cfa72fb241fc7c45348d`.
This is API v2, revision `sha256:2f532bfdcd2c`, with 394 vendor operations
(185 GET, 96 POST, 65 PUT, 48 DELETE) and 304 component schemas.
Nine explicitly deprecated operations are excluded by the existing compiler:
GET/POST `/processes/{process_id}/queues`, GET `/queues/{queue_id}/managers`,
DELETE `/queues_individuals/{queueIndividualId}`, POST
`/queues_individuals/{queueIndividualId}/done`, POST
`/queues_individuals/notifications`, POST `/scheduling/search_individuals`,
GET `/search/criteria/{domain}` and POST `/search/results`.

The shipped index contains **385 operations**, each with a literal reviewed
verdict: 197 reads (182 resource GETs and 15 advanced-search result POSTs),
174 destructive actions and 14 refusals. No future operation becomes a read
by method inference. OAuth exchange and password reset remain outside the
agent surface. Multipart and form request bodies are unsupported. Thirteen
wildcard-labelled modeled JSON writes are explicitly admitted in `api.ts` as
`application/json`: twelve object bodies and one array body. They include form
responses, membership SMS and bulk removal, privacy settings/defaults,
messages/comments, scheduling notifications, individual/family assignments,
and saved-search creation/update. Their modeled request validation, configured
write-scope boundary, single send and response privacy still apply. The verdict
counts remain 197 reads, 174 destructive actions and 14 refusals; the three
additional bodies already had destructive verdicts.
Optional wildcard GET bodies can be omitted; their body filters cannot be
misrepresented as query parameters. The JSON Accept header, fixed environment
origin and JSON-only response parser remain enforced.

The compiler's opt-in `additionalResponseMediaTypes: ["*/*"]` includes modeled
JSON keys that CCB labels with a wildcard. It changes metadata only. All
modeled response properties are retained independently of request-depth
shrinking. 325 operations declare response roots (3,667 operation/root pairs).
The remaining 60 have empty, scalar, explicitly open or absent response
contracts; `fields` cannot be validated on those hatches. Saved-search open
objects are a material gap. The CCB-only `emptyObjectsOpen` compiler option
preserves the pin's implicitly
open empty `properties` objects, including filters on all 15 search domains
and the mass-edit-sacraments action. Filter names and values are vendor-defined
and unmodeled; accepting them makes no claim of criteria discovery or nested
filter validation. The removed deprecated criteria endpoint is not restored.
Other providers keep the default closed-object guard and unchanged indexes.
Request depth is 3; details mark deeper branches
as truncated rather than claiming exhaustive nested validation.

All operation summaries are nonempty. Parameter descriptions are reviewed
vendor text, with explicit page/id/name fallbacks and a humanized contract
label for missing descriptions. Authored synonyms augment the vendor's CRUD
words. Read/write hatch notes carry resource and edit vocabulary for catalog searches.
Regression assertions require natural profile-update, person-create,
pastoral-note and campus queries to find the intended operation at rank 1/2. The campus directory carries
CCB-local church/campus resource synonyms so the shared conversational ranking
keeps the directory ahead of campus subresources for “church campuses.”

The former 41-operation drift inventory described named calls, not the API.
It now records all 385 index operations. Recording the verified public pin
also accepts nine contract changes in old rows: groups get, individual
assignments, category list/category schedules, and assignment/category/
organizer/schedule/scheduling-individual advanced searches. Their contracts
now come from the captured bytes rather than the old handwritten assumptions.

## Paging and named projections

CCB's `PerPage` parameter declares 25/50/75/100, default 25. Named lists use
that exact enum as `limit` and signed, connection/owner/argument-bound
continuations; `defaultPerPage` remains a deployment override within the enum.
Provider continuation payloads also bind effective size and index revision.
An invalid size is refused before authentication or dispatch with a complete
sentence naming all allowed sizes. A changed filter, size or tampered token
cannot dispatch a continuation.

87 indexed reads opt into CCB's numeric page adapter. An explicit empty
`X-Next-Page` ends paging; otherwise `X-Total-Pages` controls continuation,
then full/short-page fallback. Requested/current pages must agree; malformed,
nonadvancing and empty continuing pages fail closed. Adapter decisions run on
safe rows before `fields`. Arrays and merge-history `items` are understood;
unknown object replies use explicit safe paging headers, otherwise omit page
metadata. The schedules-totals aggregate is not cursor paged. `search_records`
wraps its projected counts in one terminal item. The merged #991 opt-in standard-list extension (ab707ee4) exposes
`page.total` only when the existing `X-Total` header supplies an exact safe
integer. No count is derived from page size or observed rows.

The writable catalog is 27 to 20: fifteen existing workflow reads, a named
advanced-search read and four standard hatches. The nine removed wrappers
had zero uses in the frozen BEFORE traces, including caught/refused direct
and guest calls. Retention of unobserved event/notes/metrics reads is justified
by their occurrence identities, sensitive projections and business bounds,
not claimed as an eval win. `search_records` covers all fifteen domains but
now returns compact common record summaries and aggregate counts; the indexed
read hatch returns domain-specific fields. The migration guide owns every
removed name, argument, projection and unsupported legacy filter.

## Privacy and explicit meanings

Keep the existing configurable sensitive-name drop at every depth, before
named projection, fields, paging and write replies. `sensitiveFields: return`
permits that set only. The value-safety table reviews all 11 detector
candidates and 35 additional file-bearing operations: 2 refuse, 36 redact,
8 safe. Every modeled FileSerializer/SearchFileDetail/EventFile/
ServicePlanItemFile destination path is withheld, including nested events,
service plans and messages. Permanent fields also withhold access/refresh
tokens, `calendar_ical` and `payment_url`. Musical song keys and time signatures
are explicitly safe. Generic signing-name detection remains active; ordinary
public form URLs, social links, labels and user text are not blanket removed.
The authenticated safety harness verifies table completeness, nested path
resolution, streams, program/direct calls and read-only endpoints. It uses
chunked JSON because CCB does not admit NDJSON.

Configured read-only OAuth scopes omit the write hatch, discovery write-tool
pointers and all write dispatch. The separate generic `writeEnabled` hook is
opt-in; other providers keep the existing output. Endpoint `readOnly` remains
an independent enforcement boundary. Writes keep their reviewed write classification and are sent once. The host
may ask the user to confirm.
No CCB auth-before-execution exception is claimed.

Declare 404 as `not_found` proving absence: this provider already documents
permission gaps as 403. No public 409 contract proves conflict, so remove the
old ungrounded conflict branch and use the kit fallback. Keep 401 grant
recovery, the CCB-specific 403 permission explanation, 412 argument meaning,
and declared Retry-After/reset/body numeric facts for 429. All diagnostics
are complete sentences. Keep acknowledged empty 204 JSON success. No named
write or former in-band failure hook was removed.

## Held items and remaining limits

H14 is folded: indexed canonical paths reject full URLs, percent encodings,
semicolons, backslashes, embedded query/fragments, OAuth and traversal forms
before dispatch. No claim about live server normalization is needed.
H5 opts into the merged incomplete-body cause plumbing and distinguishes a
broken read from complete non-JSON; write uncertainty stays with the shared
settlement. H9 is measured separately as characterization only, with no SLA,
deadline or lazy-client policy change. H1-H4, H6-H8 and H10-H13 remain in their
owning core/other-provider work.

The public API's legacy v1 XML routes, transactions and per-gift amounts are
out of scope. No real church API, OAuth credential or mutation was used in
verification. The default per-endpoint 60/minute rolling budget preserves
existing admission and cannot model CCB's no-burst exceptions or coordinate
other runtimes; the guide keeps their spacing rules.
