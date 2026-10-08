---
type: added
---

**Google Slides connection.** `@zackbart/connecta/providers/slides` exports
`slides(id, options)` with the same Workspace delegation options as `gmail()`,
plus `SLIDES_SCOPES` and `SLIDES_API_BASE_URL`. It requests exactly
`https://www.googleapis.com/auth/presentations`. Fifteen hand-written
tools, seven of them for comments (below). Of the other eight, four are
reads: `get_presentation` (title, page size, `revisionId`, a
layout preview, and each slide's text in reading order — top to bottom,
then left to right, rotated and nested groups composed — with table cells,
alt text, linked charts' spreadsheet ids, speaker notes, and empty
placeholders' ids for filling a new slide, under a field mask that leaves
styles behind, capped per slide), `get_page` (any slide, layout, master,
notes page, or the notes master by objectId: every element in reading order with its group and
placeholder type, index, and parent — what `placeholderIdMappings` needs —
and text continued across pages), `list_layouts` (masters, each followed by
its layouts), and `get_slide_thumbnail` (the short-lived link and size,
never the image). `create_presentation` and `create_slide` are additive
writes; `replace_all_text` (literal, case-sensitive by default, several
replacements in one atomic batch, optionally at a required revision) and
`batch_update_presentation` (1 to 100 raw Slides requests, each refused
locally unless it is one known Request kind, always at a required
`revisionId`, its replies bounded — every id at every depth kept whole,
large fields named in `cut`, overflow counted, and the write reported as
applied) are annotated as destructive and classified as writes. Every write result is size-checked too: copied
ids and revisions are whole or flagged, never cut, and a result that still
cannot be delivered after Google's 2xx is refused with "applied — do not
repeat it; re-read". A write refused because the deck changed since its
revision is a `conflict`, and a create whose outcome is unknown says what to
look for before creating again.
Every read result is built under the shared Workspace result budget, so it
is deliverable inside a program and directly alike, and nothing it cannot
carry is lost: cut text carries the `get_page` cursor that continues it
character by character, a crowded slide names the cursor for the elements
not shown, the layout preview continues in `list_layouts`, and `raw: true`
pages Slides' own JSON, sending an element too large for one result in
chunks that concatenate and parse. Every cursor is bound to the deck, page,
mode, and the revision it was read at — or, for a viewer Slides gives no
revision, a SHA-256 of the exact content its paging depends on — so a deck that
changed between pages is a `conflict` to restart, never a skipped or
repeated slide. Slides cannot list decks, and the guide says that is
Drive's job. A 404 is reported as unknown-or-not-visible, because a deck is
a Drive file. Setup is documented on `slides()`.

Trusted pools permit program writes; read-only pools use `call_destructive_tool`.
The MCP host controls approval.
