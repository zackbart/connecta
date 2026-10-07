---
type: added
---

**Google Docs connection.** `@zackbart/connecta/providers/docs` exports
`docs(id, options)` with the same Workspace options as `gmail()`, plus
`DOCS_SCOPES` (exactly `documents`) and `DOCS_API_BASE_URL`
([#681](https://github.com/zackbart/connecta/issues/681)). Six hand-written
tools: `get_document` (every tab, or one, rendered as markdown-ish text —
headings, lists, links, tables as pipe rows, footnotes, and every inline chip
by what it shows, a dropdown's selected value included — capped by
`maxChars` with an explicit marker, with `title`, `revisionId`, on
`withIndexes` the UTF-16 start and end index of every paragraph, table, and
table of contents, paged by cursor in 64 KiB pages so a default read always
fits the 256 KiB `execute_code` bridge, and a per-tab `notRendered` naming headers, footers,
floating images, unmarked suggestions, or unknown elements the text leaves
out; `raw: true` returns Google's resource instead, up to 4 MB),
`create_document` (title and an optional body; a body that fails after the
document exists names its id instead of inviting a duplicate), `append_text`
and `insert_text` (additive), `replace_all_text` (string or RE2, by tab,
reporting the count), and `batch_update_document`, a raw
`documents.batchUpdate` passthrough that is always destructive, takes 1–100
requests of known generally available kinds (contents unvalidated), returns
Google's replies within the shared result budget (projected to ids and
counts, then cut to a counted prefix, still saying the batch applied), and
requires `requiredRevisionId`. Every other edit takes it optionally, and a
write naming one is revision-guarded, so a stale revision fails `conflict`
on Google's own reason code. Failures are classified by how far the request
got, from the shared client's outcome facts: a 4xx refusal passes through
as mapped and applied nothing; an edit sent with no answer back, answered
with a 5xx (whatever reason it carries), or redirected says its outcome is
unknown, non-retryably, because no Docs write is safe to send twice; only a
2xx whose reply broke off, overflowed, or would not parse says the edit was
applied; and a create that may have left a document behind never invites a
second one. Ids Google sends back are copied only if a tool could take them
as input again, and otherwise dropped whole and named in `dropped`; titles
are clamped; and every result passes one final size check, which a read
answers with its way out and a write with a small acknowledgment that it
applied. There is no search or
list tool: finding a document is Drive's job, and `documents` cannot list. A
404 stays `connector_call_failed`, because Google answers it for an id that
is unknown and for one not shared with the caller alike. Setup, including
the Admin console scope, is documented on `docs()`; drift is checked against
the Docs Discovery document.
