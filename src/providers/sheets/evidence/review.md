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
