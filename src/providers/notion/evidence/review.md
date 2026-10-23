# Notion API review

The runtime operation index and Notion-Version remain pinned to 2026-03-11
(the index revision is 2026-10-09). Its request details retain depth four,
160-character descriptions and the existing enum limit. Named tools retain
`integration_*`, `raw`, vendor paging and property projections in step 1.
The hatch keeps index lookup, permissive scalar validation and `select`.

The reviewed value-safety table refuses the three OAuth token operations.
The file-upload send URL requires the integration token and is not a guest
capability; it remains visible. Custom-agent connections name server hosts,
not credentials. Error text for these credential-related operations stays
withheld, including retries and non-id-shaped commit metadata.

Embedded-URL review: global. Notion file URLs occur as fields and inside page
Markdown, rich-text content and asynchronous results. `sanitizeLinks` applies
the existing strict host/bucket/proxy policy to successes and error details.
Write admission refuses previously withheld file destinations before dispatch.
Rich-text lanes join plain text and authored content separately through the
current call's request-secret service before projections and raw branches.

The error table preserves Notion's status meanings: 403 is a capability or
sharing refusal, 404 does not prove absence, and a read's 409 retains its
historical retry diagnostic. Commit and retry-guidance presence is structural
metadata; classification receives booleans rather than vendor prose. The
shared core alone decides a dispatched write's outcome and retryability.

Notion's published OpenAPI document is mutable. A live check during this
migration reports standing contract changes for data-source retrieval,
data-source query and search. Their existing endpoint digests and the runtime
index pin remain unchanged; this migration does not accept those changes.
