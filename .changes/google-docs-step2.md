---
type: changed
breaking: true
---

Standardize Google Docs with four indexed `docs_api_*` hatches over all three pinned API methods, retaining all six named tools and their write annotations. Hatch batch writes require a revision, 1–100 requests and exactly one supported GA kind each; preview comment and suggestion kinds remain refused. Generic create sets only a title; the named create retains separate create/initial-text steps and partial-create recovery.

Remove `get_document.raw`; use `docs_api_read` with `/documents/{id}` and `query.includeTabsContent:true`, reading the vendor document from the hatch value's `data`. Add `get_document.fields`. Replace unsigned `e:` cursors with signed content/revision-bound cursors; start without a cursor and keep read arguments fixed. Terminal pages omit `nextCursor` instead of returning null. Replace `tabs[].textTruncated` and `repliesTruncated` with top-level `truncated` paths; remove `replyCount` and use `replies.length`. Ambiguous document 404s report `connector_call_failed`, while standard read 5xx failures report `unavailable`. Temporary image `contentUri` access capabilities are permanently withheld; ordinary authored links remain. See the Google Docs section in the 0.35 provider migration guide for concrete calls.
