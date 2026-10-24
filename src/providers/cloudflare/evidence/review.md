# Cloudflare provider kit review

Step 1 retains the existing nine-tool catalog, complete guide, indexed request validation, value-safety verdicts, auth order and account/zone pin enforcement. Both key schemes use the confined Cloudflare v4 connection. No authentication-before-execution proof is declared.

The primary OpenAPI pin and generated compact index remain unchanged. The 3,426 REST operations use canonical vendor path parameters and ref-graph-v1 endpoint digests. Every row references its pinned operation definition.

## Supplemental GraphQL envelope

Cloudflare documents GraphQL Analytics outside its REST OpenAPI document. `graphql.document.json` is a reviewed OpenAPI representation of the JSON request envelope (query, optional variables and operationName) and response envelope (data and optional errors), as the named tool sends and receives them. It describes no dataset, resolver, field, filter, limit or authorization grant. Its separate vendored pin records the exact document bytes and the public [GraphQL Analytics API reference](https://developers.cloudflare.com/analytics/graphql-api/). The checker reads it offline; the manual check owns dataset semantics.

## Pin confinement

All generic calls and uploads pass the same default-deny account/zone admission before dispatch. GraphQL additionally inspects every selected account/zone field and its resolved filters. Ownership GETs use three construction-declared lookup steps; the resource write keeps its single write step. The owner cache stores only verified zone/account ids, never a caller context. Per-call memo and the legacy lookup budgets remain call-scoped.

Ownership proof comes only from `result.account.id`. Ownership replies skip ordinary in-band error conversion: a 200 `success:false` body with a pinned result owner is admitted as in the legacy provider; without one it refuses the pin. Bare account objects, unparseable bodies and chunked oversized 200 bodies refuse the pin for read and write tools before any resource dispatch. Declared oversized bodies keep the legacy ceiling failure.

## Output order

The connection redacts sent secrets before extracting response data or errors. Reviewed value safety unwraps the v4 result before redaction; paging and projection only read that safe representation. Secret-bearing failures use status and numeric facts while withholding vendor text. Multipart fixtures compare ordered part names, MIME types, filenames and bytes, as the legacy golden harness does; runtime-generated boundaries are not serialized into the observations.

## Migration verification

The original out-of-tree legacy/kit comparison covers 1,792 cases: 1,734 exact matches and 58 individually accepted differences. Six further valid-JSON ownership cases match exactly, giving 1,798 cases: 1,740 exact and 58 accepted differences. Physical request sequences match in those cases (methods, URLs, ordered bodies/parts, headers, count and order), and every differing row preserves writeOutcome. The 36 B.3 broken-stream differences comprise 21 successful broken-stream reads that change code from unavailable to connector_call_failed and retryable from true to false, plus 15 write/upload rows that change message bytes only. The other classes are 15 retryable read-421 verdicts, one sent-secret redaction of the Global API Key email, and six B.3 bounded diagnostic display rows. Supplemental reviewer probes also exercise the accepted redaction of a token echoed in verification status, in addition to email redaction and B.3 diagnostics.

The review regression rows separately cover exact SCIM PATCH/PUT media types and ownership preflights with bare account objects, in-band failures with and without pinned owners, and oversized chunked bodies in read/GraphQL calls. These rows compare requests and outcomes with legacy; their scope is separate from the original 1,798-case count. The SCIM operations retain `application/scim+json` with the exact serialized JSON body. Existing tests were extended; the collected-test delta remains −2.

Error-chain walkers guard non-object entries, including placeholders from bounded redaction, so credential probes resolve a failure result. Structured error mapping reads the kit's token-only facts view, whose structural traversal stops at 32 levels. Each nested `error_chain` adds an array and an object level; reviewer probes observed auth codes at chain depth 15 and beyond falling outside that view. Codes beyond the bound do not influence classification. A null chain entry no longer triggers the legacy latent crash; ordinary primitive entries retain their legacy unknown-error wording.

The bounded display rows retain the kit limits: two HTTP 403 responses with a 129-character cf-ray omit that header (128-character maximum), on GET /zones/{zone_id} and GET /accounts/{account_id}/workers/scripts/{script_name}/settings. Four withheld responses from the latter operation, at HTTP 400, 401, 403 and 503, display eight of ten numeric codes (eight-entry display maximum). Only their message bytes differ; code, retryability, writeOutcome and request bytes agree. The orchestrator explicitly accepted this class for step 1 without widening or back-porting the kit's bounds.

All 48 separate construction cases match their legacy results or refusal bytes, including the hosted-MCP migration message. All five option-mode catalog/title/description/guide snapshots match. A loaded Linux host measured legacy/kit construction at 36.3/62.6 ms, catalog rendering at 6.7/2.6 ms and the first read at 100.9/88.8 ms; these single cold observations describe this run, not a performance threshold. The full lazy manifest took 3.76 seconds and was not built during catalog rendering or the first read.

## Decision 0011 step 2 (#703)

The standard hatch retains the full safe vendor envelope. Operation-specific
paths still apply relative to `result`; the envelope itself also passes the
same value-safety engine so a credential echoed beside `result` cannot escape.
Pin filtering applies to `result` for account, zone and membership lists.
`success: false` remains an in-band refusal through the declared fact snapshot,
including on HTTP 200. A dispatched write is never resent.

The OpenAPI pin remains revision
843eae2fbf4fe774ef9c91021dd34017ac9c970a, digest
sha256:128d27e93f42fd16e70c69b09c6deb4c0bbf0539c7b46a3e4cc65dbb6a6e1f81.
Generation now preserves 120-character parameter descriptions and documented
numeric bounds. The response fields already compiled from that pin remain the
pre-dispatch selection contract. Bare, wrapped and array responses derive their
roots from the pin; schemaless/open replies refuse narrowing rather than invent
properties. Text/NDJSON and binary replies retain their reviewed safe formats.
Workflow summaries supplement the original generated action/resource words.

Numbered reads use the kit's Cloudflare adapter. Cursor/after reads use the
pinned query parameter and `result_info.cursor` or `result_info.cursors.after`.
Token metadata is validated before signing; URL-shaped cursors pass embedded-URL
sanitizing. A withheld continuation keeps the safe data with `hasMore: true`
and no cursor. Numeric metadata fails closed. Named lists expose an exact vendor
total only without local pin filtering. R2 headers, default-id substitution,
encoded slash keys, scoped ownership lookups, raw/multipart uploads, SCIM and
text/SQL/NDJSON framing retain the same transport and admission boundary.

Public contract references checked with the unchanged pin:

- <https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/>
- <https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/subresources/keys/methods/list/>
- <https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/>
- <https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/>

404 keeps its established absence meaning. No reviewed conflict is declared;
409 uses the kit's generic failure. The documented 1,200-per-five-minutes window
supports the retained 429 fallback, with Retry-After taking precedence. Error
code vocabulary and numeric facts remain independent of diagnostic redaction.
H5 wording changes are deferred; H9 is measured only, without changing deadlines.

Curation retains nine names. Account and zone lists supply identity joins;
GraphQL retains its query-only AST and pin checks; verification retains user-token,
account-token and Global API Key diagnosis. Uploads retain their distinct byte/
multipart safety boundary. The seven frozen evals exercise the lists and GraphQL;
verification and uploads are workflow/safety choices, not measured eval wins.

Automatic hatch paging is limited to a pinned `result_info` envelope with one
unambiguous continuation parameter. APIs declaring both page and cursor, or
omitting the response envelope contract (for example Cloudforce One's
`pagination.cursor`), retain their raw vendor query protocol. They are not
claimed as signed adapter continuations: guessing a metadata location would
block a valid cursor without supplying a replacement. DNS, account/zone, KV and
R2 reads with the documented envelope remain eligible. This eligibility audit
changes no evaluated task route or result.

Integration with main 09258a7f retains #996's shared ranking and #998's shared
approval/discovery/unreadable-body wording unchanged. The original R2 bucket
query slipped to rank 3 without a method filter; the Cloudflare-local summary
"List R2 buckets for an account" restores rank 1. All twelve regression phrases
(DNS records/list/update/TTL, purge cache URL/purge URL, Workers scripts/deploy,
R2 buckets/objects, KV keys and zones), each with and without a method filter,
rank first: 24/24, no I/O, maximum serialized search answer 1,502 B. Extra rows
remain assertions in the existing case; its timeout accommodates the larger
index/query matrix under load. A broader bare "domains" probe does not return
/zones in the first six: shared literal-path focus favors domain APIs. This is
a disclosed discovery limit, not a reason to fork shared ranking. The named
list_zones tool still describes domains explicitly. Shared write-aware unreadable
body wording is inherited from #998; no independent Cloudflare H5 change is added.

## Response-media hardening (#1000)

The byte-exact 843eae2fbf4fe774ef9c91021dd34017ac9c970a pin
(sha256:128d27e93f42) declares 66 non-JSON success operation/media pairs
across 52 operations. The complete reviewed allowlist is
[lib/response-media.ts](../lib/response-media.ts); reproduce it with
`node scripts/audit-provider-media.mjs cloudflare <exact-pin-document>`.
It includes DNS/plain-text exports, CSV, XML threat feeds, NDJSON analytics,
SSE queue metrics, PDFs, images, KV/R2 bytes, archives and Worker content.
`image/*` retains the pin's image-family wildcard only on that image operation.
The pin's literal `string` labels are malformed media labels for three raw
Worker content operations. These exact operations admit application/javascript,
application/javascript+module and text/javascript, preserving raw scripts.
R2 objects and KV values accept any stored Content-Type as bounded bytes.
Both explicit exceptions retain sent-secret checks before base64 encoding. Existing argument/scope/value-safety refusals still
apply before dispatch, so an allowlisted format never grants an operation.
Ownership lookups remain JSON-only. JSON-only operations no longer treat an
unexpected text/HTML/binary page as success; dispatched writes report unknown
outcomes with check-before-repeat guidance and no resend.

The exact pin declares 16 integer path parameters with minimum 0 plus
exclusiveMinimum true. `lib/path-bounds.ts` records exactly those operation/param
pairs; the provider rejects zero locally before authentication/dispatch. Keeping
the compiled index bytes unchanged preserves existing discovery continuations.
Compound telemetry event segments whose two parameters are not captured separately
are not validated as the literal string undefined; the concrete route remains
callable. Independently captured number params require canonical decimal syntax.
