---
{
  "name": "slides",
  "instructionsHeading": "Connection instructions"
}
---

## Find and read a deck

Slides cannot search or list decks. Find the file through Drive, or take the
presentation id from `/presentation/d/<id>/` in its URL. A presentation is a
Drive file; finding one does not grant permission to open it.

`get_presentation` reads text in page order, with speaker notes, alt text and
placeholder ids. `get_page` opens groups and reads a slide, layout, master or
notes page. A slide's `index` is zero-based. Resolve a layout's placeholders
with `list_layouts` and `get_page` before filling a new slide.
Named-read `fields` narrows data while preserving `truncated` cut disclosures.

Text and notes have independent continuation. Pass an element's `textCursor`
or a slide's `elementsCursor` to `get_page` with that slide's id; pass a
`notesCursor` with its `notesPageId`. A deck's `layoutsCursor` continues in
`list_layouts`. Content cursors bind to the deck's revision and the text they
continue; a changed deck requires a fresh read. Follow continuation even when
a result contains fewer rows than requested.

For styles, transforms, HTML comment content, anchors' ranges or other full
structural JSON, use `slides_api_read`. Operation details use the legacy
`presentationsId` spelling for presentations.get; pages and batch updates use
`presentationId`. These are path parameter names, not query arguments.
Spell colons and unreserved characters literally in hatch paths; encode other
characters within one id segment. Named tools handle their own id encoding.

In code, `const {data: reply} = await connecta.call("decks.slides_api_read",
{path: "/presentations/deck1"});` exposes the vendor presentation as
`reply.data`.
A direct call wraps that same `{status,data}` tool value in Connecta's result
delivery; follow its result handle for large JSON. Content cursors belong to
the named reading tools and are separate from that delivery handle.

`get_slide_thumbnail` returns a link that opens as the delegated person for
about 30 minutes. Keep it private. Generic thumbnail/preview operations are
refused; use the named thumbnail workflow.

## Edit at the version you read

Read before editing and use its `revisionId` as the write precondition.
Revision ids are preconditions, not replay keys. `create_slide` adds an empty
slide; read its placeholder ids before inserting text. `replace_all_text`
replaces literal text. No Slides tool shares, moves or deletes the deck file.

`batch_update_presentation` takes the existing reviewed Request kinds.
The generic batch hatch uses `POST /presentations/deck1:batchUpdate` with
`body: {requests: [{insertText: {objectId: "shape1", text: "Hello"}}],
writeControl: {requiredRevisionId: "revision-from-read"}}`. It retains the
same request-kind and revision guards. No additional preview capabilities are
admitted by indexing the complete Discovery document.

## Comments can save separately

A comment thread's `commentId` identifies the thread; its head post and
replies have their own `postId`. Authors' `user` ids are stable; display names
are labels. Anchors join to page and object ids; speaker-note comments belong
to the notes page. Reading comments requires comment access. A view-only
account may be refused rather than receiving an apparently empty list.

Resolve, reopen or reassign a thread with `update_comment_thread`; edit its
text with `update_comment_post`. Reassignment requires content. Only the
post's author can edit or delete that post. Comments notify people as in the
Slides editor.

Slides saves deck changes and comment changes separately. A successful mixed
batch can save the deck without confirming the comments. When
`commentUpdateState` is not `ALL_SAVED`, or the result says comment saves are
unconfirmed, read the deck and `list_comments`, report each outcome separately,
and avoid replaying the whole batch. Keep every created id for reconciliation.
