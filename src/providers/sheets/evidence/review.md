# Sheets step 2 review

The exact archived official Discovery bytes are SHA-256
94799a4eedbb5115c6a656bb96c9d6af73167b9980b91586ce3e45cfd2c630f3,
revision 20261019. The normalized OpenAPI document and compact index are
reproducible offline. Inventory: 17 source methods, 17 indexed, seven explicit
reads and ten writes; no method omitted. Named dispatches are a subset.

Read POST reviews: spreadsheets.getByDataFilter returns matching spreadsheet
metadata/grid data, values.batchGetByDataFilter returns matched cell values,
and developerMetadata.search returns matched metadata. Their documented
contracts describe reads without mutation. They keep source read verdicts;
POST alone grants no credential replay. Scopes remain spreadsheets only.

The Request schema contains 74 kinds. Exactly 64 ordinary spreadsheet kinds
are admitted, with 1–100 requests and one kind per request. Five preview comment
kinds (insertComment, addCommentReply, updateCommentPost, deleteComment,
deleteCommentReply) and five external data-source kinds (addDataSource,
updateDataSource, deleteDataSource, refreshDataSource,
cancelDataSourceRefresh) are refused locally on named and hatch batches.
External data-source configuration via creation payloads is also refused.
Nested vendor request contracts remain recoverable in details; their compact
checker does not replace the independent kind/size guards.

## Value safety and S6

Reviewed every newly reachable response schema. Cells, formulas, notes,
comments' read metadata, developer metadata, data-source read descriptions,
spreadsheet URLs and rich-text links are requested user content. They are not
a configurable personal-data set. No sensitiveFields option is introduced.
The flagged scorecard keyValueData is a chart's cell-data range, not a secret.
The metadata search operation is a safe lookup, not credential discovery.
No response schema declares a vendor-issued access token or temporary media
capability destination. Embedded signed URLs: none found in the vendor's
response descriptions; global signing-name defense covers free text. Ordinary
user-authored links remain available. Sent-secret safety precedes projection,
field selection and truncation on every named and hatch reply.

## Local path policy

Only colons in the range segment under /spreadsheets/<safe-id>/values/ are
normalized. Literal :append/:clear suffixes are preserved. Encoded trailing
actions, encoded unreserved bytes and encoded ids retain the shared refusal.
Resolution and transport use the normalized path through googleHatchBinding;
there is no alternate origin, raw fetch or subject selector.

## Errors and held items

Standard googleErrors retains reviewed reason vocabulary and numeric retry
facts. Unknown ids remain ambiguous and prove no absence. H5 uses standard
incomplete-read wording; H9 is characterized without increasing deadlines.
No revision/idempotency guarantee or 401-before-execution evidence is claimed.
H1 core behavior is already in the baseline; other held items are not Sheets
changes. Batch-wrapper retirement needs eval evidence and an orchestrator
ruling; all nine named tools remain.

Sheets declares no stored vendor-credential response family. Reviewed error
bodies may echo requested user content or request credentials, so the table
retains vendor error details through `vendorErrors`; sent-secret redaction
runs before error mapping. The existing all-encoding 401 golden probes cover
those error echoes. A benign chart-range candidate must not silently remove
all diagnostic prose from metadata errors.

## Local measurements and test accounting

Like-for-like esbuild neutral/minified output with gzip level 9 on Node
22.23.3, comparing main aeae16f7 to this product: standalone Sheets
353,211 → 394,797 bytes gzip (+41,586); the all-six Google bundle
417,992 → 461,131 (+43,139). The standalone increase remains below the
approved 60 KB escalation threshold. Shared Effect code is counted once
in the combined measurement; standalone provider totals are not additive.

H9 characterization on bigserv, Node 22.23.3, source imports through tsx,
no deadline changes: at baseline 008251a8 import/factory were 3,784/51 ms,
first call to first send/total 187/312 ms; warm reads 15–18/24–30 ms.
The product sample was 2,969/94 ms, first send/total 137/235 ms,
warm reads 13–17/24–25 ms, first operation search 80 ms. Heap delta
including construction and three reads was 52.3 → 56.2 MB. These are
single local samples under concurrent host load, not latency guarantees.

Collected tests in the only files whose case counts change (Sheets provider
suites and the catalog-driven failure sweep): 445 before and 445 after,
net zero. Wide-row assertions were folded into the existing row/hatch case;
a safety-review case now checks all generated candidates. New hatch failure
routes share the existing representative named failure cases, while offline
search/details are checked in the inventory. No boundary assertion was removed.

## Forms review follow-up before paid trials

Merged #1011 and #1013. The legacy `get_values` positional cursor now uses the
shared signed codec, with read arguments plus deployment/connection/caller
binding. The existing row asserts caller B cannot use A's cursor, with neither
an API dispatch nor token mint, while A continues; modified MAC/payload and
legacy unsigned cursors also fail before sending. This is content paging, not
a Google vendor page token, and does not add a revision guarantee.

Both named reads validate fields before sending, select projected values, then
restore `truncated`; cell reads additionally retain their content page. All
17 indexed summary first sentences fit within 120 characters. Formatting and
append summaries carry the eval action words, and the conditional batch-kind
refusal is visible in the first sentence. Natural-query rows cover bold cell
formatting, literal row append and spreadsheet creation without adding cases.

Sheets reference task S4 already used the metadata hatch. After merging the
shared follow-up, S7's legacy raw metadata reference was replaced by the
reviewed developer-metadata read POST. This changes reference call shape only:
prompts, world state and outcome graders are unchanged. Fresh protocol hashes
and deterministic selftest results are recorded in the product's pre-eval note.

Follow-up validation: the standards/conventions and Sheets suites pass 78/78,
including both former checker failures. All seven deterministic references
pass across both surfaces and grading modes. The shared envelope control did
not trip, so no shared control fix was applied. Signed-cursor and selected
metadata changes pass deterministic Node and all-provider workerd goldens;
only Sheets fixture bytes differ from main. Case count remains unchanged.

Refreshed Node 22.23.3 esbuild/gzip-9 measurements against main ff3f7c3b:
standalone Sheets 353,251 → 394,761 bytes (+41,510); all six Google providers
418,022 → 461,176 (+43,154). These supersede the earlier bundle sample for
this updated head and remain below the product's +60 KB threshold.

## Round-1 follow-up (#1022)

The batchUpdate summary uses the reviewer's exact action-first sentence.
A product-local discovery category, `spreadsheets ranges headers`, supplies
the nouns needed for “sort range” and “freeze header row”; the compiler's
120-character summary remains intact. It changes no method, path, schema,
execution verdict or archived Discovery bytes. Six more natural queries and
all ten blocked kinds' actual refusal reasons on both batch routes are
asserted inside existing cases. No case is added.

The guide and spreadsheet-id parameter explicitly accept a supplied id such
as `sheets1`. The guide names `get_spreadsheet` and the INSERT_ROWS-pinned
`append_values`. Migration notes disclose the shared builder's omission of
the previous create/add/append `destructiveHint:false` (#1017); host approval
routing is unchanged. Unrelated Drive/Gmail fixture escaping is reverted.

The paid snapshot predates these fixes. The independent review identifies
nine exact-range failures as a frozen-grader defect. Its range-neutral
17/28 → 21/28 recount is diagnostic analysis only in the eval notes and JSON;
the scored 12/28 → 17/28 table, trial grades and frozen grader are unchanged.

The 42-query surface probe loses no previously top-two batchUpdate match;
all five requested queries rank it first. The 541 selected pre-Forms Node
cases pass. Main 84fb4eee (Forms #1014) is subsequently merged without rebasing,
preserving both products' shared-file content and inheriting the shared surface
control fix from that main commit, with no local edit to google-controls.ts.

Against clean main 84fb4eee, matched Node 22.23.3/esbuild 0.28.1/gzip-9
measurements are standalone Sheets 353,251 → 395,008 B (+41,757 B) and all
six Google providers 448,880 → 481,506 B (+32,626 B). Docs stays 370,111 B
and Forms stays 372,171 B. The report-only Sheets baseline is the 394,998 B
snapshot before refreshing the embedded bundle facts; caps and every other
provider's approved entry are unchanged. These supersede the pre-Forms
measurements for the current merged source.
