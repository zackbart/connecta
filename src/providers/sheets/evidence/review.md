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
