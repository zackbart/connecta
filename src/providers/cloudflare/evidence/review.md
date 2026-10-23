# Cloudflare provider kit review

Step 1 retains the existing nine-tool catalog, complete guide, indexed request validation, value-safety verdicts, auth order and account/zone pin enforcement. Both key schemes use the confined Cloudflare v4 connection. No authentication-before-execution proof is declared.

The primary OpenAPI pin and generated compact index remain unchanged. The 3,426 REST operations use canonical vendor path parameters and ref-graph-v1 endpoint digests. Every row references its pinned operation definition.

## Supplemental GraphQL envelope

Cloudflare documents GraphQL Analytics outside its REST OpenAPI document. `graphql.document.json` is a reviewed OpenAPI representation of the JSON request envelope (query, optional variables and operationName) and response envelope (data and optional errors), as the named tool sends and receives them. It describes no dataset, resolver, field, filter, limit or authorization grant. Its separate vendored pin records the exact document bytes and the public [GraphQL Analytics API reference](https://developers.cloudflare.com/analytics/graphql-api/). The checker reads it offline; the manual check owns dataset semantics.

## Pin confinement

All generic calls and uploads pass the same default-deny account/zone admission before dispatch. GraphQL additionally inspects every selected account/zone field and its resolved filters. Ownership GETs use three construction-declared lookup steps; the resource write keeps its single write step. The owner cache stores only verified zone/account ids, never a caller context. Per-call memo and the legacy lookup budgets remain call-scoped.

## Output order

The connection redacts sent secrets before extracting response data or errors. Reviewed value safety unwraps the v4 result before redaction; paging and projection only read that safe representation. Secret-bearing failures use status and numeric facts while withholding vendor text. Multipart fixtures compare ordered part names, MIME types, filenames and bytes, as the legacy golden harness does; runtime-generated boundaries are not serialized into the observations.

## Migration verification

The out-of-tree legacy/kit comparison covers 1,792 cases: 1,734 exact matches and 58 individually accepted differences. Every physical request sequence matches (methods, URLs, ordered bodies/parts, headers, count and order), and every differing row preserves writeOutcome. The accepted classes are 36 B.3 broken-stream diagnostics, 15 retryable read-421 verdicts, one sent-secret redaction of the Global API Key email, and six B.3 bounded diagnostic display rows.

The bounded display rows retain the kit limits: two HTTP 403 responses with a 129-character cf-ray omit that header (128-character maximum), on GET /zones/{zone_id} and GET /accounts/{account_id}/workers/scripts/{script_name}/settings. Four withheld responses from the latter operation, at HTTP 400, 401, 403 and 503, display eight of ten numeric codes (eight-entry display maximum). Only their message bytes differ; code, retryability, writeOutcome and request bytes agree. The orchestrator explicitly accepted this class for step 1 without widening or back-porting the kit's bounds.

All 48 separate construction cases match their legacy results or refusal bytes, including the hosted-MCP migration message. All five option-mode catalog/title/description/guide snapshots match. A loaded Linux host measured legacy/kit construction at 36.3/62.6 ms, catalog rendering at 6.7/2.6 ms and the first read at 100.9/88.8 ms; these single cold observations describe this run, not a performance threshold. The full lazy manifest took 3.76 seconds and was not built during catalog rendering or the first read.
