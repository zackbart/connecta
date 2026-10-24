---
type: changed
breaking: true
---

Standardize Google Sheets with four indexed API hatches and all nine named
workflows retained. Replace `get_spreadsheet.raw` with `sheets_api_read` full
vendor JSON; add result `fields` to named reads. Terminal cursors are absent.
Replace named-range omission counts, value-cell/per-range cut flags and batch
reply summary/omission counts with standard `truncated` paths. Keep cell content
as requested data, scalar/null value semantics, whole-row paging and named
append's INSERT_ROWS pin. Explicitly admit seven reads (including three read
POSTs) and ten writes, with bounded values and batches; refuse preview comment
and external data-source batch mutations. Use standard kit errors and preserve
ambiguous unknown-id and once-only write outcomes. See the 0.35 provider
migration guide for argument, envelope and path mappings.

Sign named cell-content continuations and bind them to the admitted delegated
caller for mapped subjects; restart existing unsigned `get_values` cursors after upgrading. Preserve
`truncated` on every named read after field selection and preserve value-read
continuation metadata. Keep operation action words and conditional refusal
reasons in the first summary sentence used by discovery.
