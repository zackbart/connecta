---
{
  "name": "slides",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Google Slides usage

Acts as the signed-in person in Google Slides through Workspace delegation: read, create, and edit the decks they can open.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose decks

Every call acts as the Workspace account deployment config maps the caller
to, and reaches exactly the decks that person can open. No argument names an
account. A call with none mapped fails `auth_required`; only an operator can
change the mapping. A deck the person cannot see and one that does not exist
fail alike — Google does not say which.

## Finding a deck

Slides cannot list or search decks; that is Google Drive's job. Take the id
from a Drive search or from a URL (`/presentation/d/<id>/`).

## Reading

- `get_presentation` returns each slide's text in reading order (top to
  bottom, then left to right), speaker notes, and alt text for images,
  videos, and charts. Empty placeholders are listed with their id and type;
  lines and other empty shapes are counted in `omittedElements`. `index`
  is 0-based, the numbering `create_slide` takes.
- Nothing is cut without a way back. Text past `maxCharsPerSlide`, or past
  what one result can carry (about 192 KB), ends with a marker, and its
  element's `textCursor` (the slide's `notesCursor` for notes) is a
  `get_page` cursor that continues from the cut. A slide too crowded to
  list whole gives `elementsNotShown` and an `elementsCursor`.
- `get_page` reads any page by objectId — a slide, a layout (its
  placeholders' types and indexes, for `placeholderIdMappings`), a master,
  a notes page (`notesPageId`), or the notes master (`notesMasterId`) —
  listing every element, groups opened,
  and continuing long text across pages from `page.nextCursor`.
- `list_layouts` lists masters and their layouts; `get_presentation`
  previews them, and `layoutsCursor` continues where the preview stops.
- `raw: true` returns Slides' own JSON: `get_presentation` a page of
  slides, `get_page` the page and its top-level elements. One too large
  for a result is named (`rawNotShown`) or sent in `rawJson` chunks;
  join the chunks' `json` in order and parse.
- Every cursor is bound to the deck and the revision it was read at. A
  `conflict` on a cursor means the deck changed: start again without one.
  A page may hold fewer rows than `limit`; follow `page.nextCursor`.
- `get_slide_thumbnail` returns a link, never the image. The link opens as
  this person for about 30 minutes; do not share it.

## Writing

- `create_presentation` and `create_slide` are additive. A new slide is
  empty: fill it with `batch_update_presentation` (`insertText` into its
  placeholders, after reading their ids with `get_presentation`).
- `replace_all_text` changes every literal match, case-sensitive unless
  `matchCase: false`. Pass `requiredRevisionId` to refuse a deck that
  changed since you read it.
- `batch_update_presentation` takes Slides' own Request objects and always
  requires the `revisionId` from the read the requests were built on. All
  requests apply or none do, except comment changes (below). Each write
  returns the new `revisionId` for the next one. A `conflict` means the
  deck changed since that read: re-read it, rebuild the requests, and send
  them with the new `revisionId`. Its replies keep every id at every depth
  whole, in every reply; text is cut first, and a large reply's other fields
  are named in `cut`. Ids too many for this tool's 192 KiB budget are all
  returned anyway, without text; past 256 KiB, more than a program can
  receive, call the tool directly and page with `connecta.result`. A batch
  whose ids pass even that returns its comment state and `repliesNotShown`;
  read what it made with `list_comments`, `get_presentation`, or
  `get_page`, and do not send it again.
- An id or revision too long to copy into a result is left out and flagged
  (`revisionIdNotShown`), never cut. A failure that says the write
  applied means Google answered 2xx: do not repeat it; re-read instead.
- Nothing here shares, moves, or deletes a deck.

## Comments

- `list_comments` lists the deck's threads, or one page's with
  `pageObjectId` (a speaker-notes comment is on the notes page). Each has
  its `commentId`, `status` (OPEN or RESOLVED), where it is anchored
  (`pageObjectIds`, `objectIds`), the `quote` it was made on, its
  `headPost`, and `replies`. A post's `author.user` (`users/…`) is
  the stable id; `displayName` is only a name. Slides gives no `user`
  for an anonymous or imported post. Text too long for one result continues
  on the next page: a row with `continued` picks up its thread where the
  last stopped, and `repliesOffset` counts the replies before it. Its
  cursor is bound to the threads and their anchors as well as the revision,
  so a comment added or moved between pages is a `conflict` too. Reading
  comments needs comment access; a view-only account is refused.
- The projection leaves out each post's HTML (`contentHtml`), whether it
  came from a copied deck, and the text and cell ranges an anchor covers.
  `raw: true` returns each thread as Slides sends it, with
  `commentAnchors` added (its anchors, each with its `pageObjectId`),
  in `rawJson` chunks when one is too large.
- `create_comment` and `create_comment_reply` are additive and return
  every new id whole. `update_comment_thread` resolves, reopens, or
  reassigns a thread (one at a time; a reassignment needs `content`),
  replacing its status or assignee, and is destructive,
  like `update_comment_post`, `delete_comment`, and
  `delete_comment_reply`; Slides allows the last three only to the
  post's author. Comments notify people the way the Slides editor does.
- Slides saves comment changes apart from the rest of a write. When it does
  not confirm they saved, the result carries `commentUpdateState` — for
  example `ALL_FAILED_UNKNOWN_REASON` — and the write's other changes may
  still have applied. Do not repeat it: re-read with `list_comments`, then
  decide.
<!-- endfragment -->
