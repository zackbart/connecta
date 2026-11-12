---
{
  "name": "slides",
  "instructionsHeading": "Connection instructions"
}
---

## Find and read

Slides cannot search decks: use Drive, the id in `/presentation/d/<id>/`, or an
id the person gives, which works as is. Finding a deck does not grant access.
Slide `index` is zero-based. Before filling a new slide, resolve placeholders
with `list_layouts` and `get_page`.

Continuation is per content kind: `textCursor` or `elementsCursor` goes to
`get_page` with that slide's id, `notesCursor` with its `notesPageId`,
`layoutsCursor` to `list_layouts`. Cursors bind to the deck's revision, so a
changed deck needs a fresh read. Follow them even when a result has fewer rows
than requested.

`slides_api_read` covers styles, transforms and full structure. It returns
`{status,data}` with the vendor presentation in `data`; a program call nests that
in its own `data`. In operation details, presentations.get names its path
parameter `presentationsId`; pages and batch updates use `presentationId`. Spell
colons literally and encode other reserved characters within one id segment.

`get_slide_thumbnail` returns a link that opens as the connection's Google
account: keep it private. Generic thumbnail and preview operations are refused.

`commentId` names a thread; its posts have their own `postId`. Speaker-note
comments belong to the notes page. A view-only account may be refused; that is not
an empty list.

<!-- when: writes -->
## Edit at the version you read

Pass the `revisionId` you read as the write precondition; each write returns the
next one. It is a precondition, not a replay key. On `conflict`, re-read, rebuild
the requests and send them with the new id. A failure saying the write applied
means Google answered 2xx: re-read, never repeat. `create_slide` adds no text, so
read its placeholder ids first. No Slides tool shares, moves or deletes the file.

The generic batch is `POST /presentations/<id>:batchUpdate` with
`body: {requests, writeControl: {requiredRevisionId}}`, under the same guards.

## Comments save separately

Comments notify people as in the editor. When one edit changes the deck and
comments, send one `batch_update_presentation` under one `requiredRevisionId`;
comment changes are Request kinds. Slides saves the two parts separately, so success
can leave comments unconfirmed. If `commentUpdateState` is not `ALL_SAVED`, or the
result says saves are unconfirmed: read the deck and `list_comments`, report each
part as saved or unconfirmed, keep every created id, and resend neither the batch
nor its comment part. The write hatch reports this state in envelope `warnings`,
even when `fields` narrows.
<!-- end -->
