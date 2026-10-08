---
{
  "name": "docs",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Google Docs usage

Reads and edits Google Docs as the signed-in person through Workspace delegation; it cannot search or list documents.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose documents

Every call acts as the Workspace account deployment config maps the caller
to, and reaches exactly the documents Drive shares with that person. No
argument names an account. A call with none mapped fails `auth_required`;
only an operator can change the mapping.

## Finding a document

There is no search or list tool. Take the id from a
docs.google.com URL (the part after `/d/`), from the person, or from a
Google Drive connection's file search. A failure on an id may mean it does
not exist or is not shared with this person; Google does not say which.

## Reading

- `get_document` renders every tab as markdown-ish text: headings, lists,
  links, tables as pipe rows, footnotes after the body, images and other
  embeds as bracketed markers. Headers, footers, floating images, and
  comments are not rendered; a tab's `notRendered` names any it holds, and
  `suggestion_marks` there means the text mixes unmarked suggested
  insertions and deletions in (read with `suggestions` to preview). Text past `maxChars` (shared across tabs) ends with a marker;
  pass `tabId` to read one tab.
- Before an index-based edit, read with `withIndexes: true` and target an
  element's `startIndex`/`endIndex`. A long document's rows page with
  `page.nextCursor`; send `maxChars: 0` on later pages, and start over if
  `revisionId` changed between them. Indexes are UTF-16 code units and
  shift after every edit. Keep `revisionId` and pass it as
  `requiredRevisionId`, so an edit against a document someone else has
  changed fails `conflict` with nothing applied; re-read and recompute. Indexes
  from a suggestions preview (`accepted`/`rejected`) are not valid for
  edits.
- `raw: true` returns Google's document resource for the tabs instead of
  the rendering — styles, headers, footers, named ranges, list and segment ids
  that `batch_update_document` requests may need. It is large: pass
  `tabId`, and call it directly rather than inside `execute_code`,
  which carries at most 256 KiB per result.
- The same holds for a `maxChars` above the default: a long rendering
  can pass here and still be refused inside `execute_code`, even when the
  program would only measure it. Read it with a direct `call_tool`, paged
  with `connecta.result`, or read one tab at a time.

## Editing

- `create_document` makes a new document in My Drive's root. Never create
  again after a failure that may have left one behind; the message says
  which. When the document exists but its starting text failed, the message
  names its id: append the text with `append_text` straight away only when
  Google refused it; otherwise read the document first and append only what
  is missing.
- An edit sent with no answer back, answered with a server error, or
  redirected says its outcome is unknown: re-read before repeating it, or
  repeat it with the same `requiredRevisionId`, which Google refuses if the
  first attempt landed. One Google answered 2xx whose reply was unreadable
  says it was applied: do not repeat it.
- `append_text` joins the last paragraph; begin with `\n` for a new one.
- `replace_all_text` changes every match at once; read first and make
  `find` specific.
- `batch_update_document` takes raw Docs API requests (`deleteContentRange`,
  `updateTextStyle`, `insertTable`, `createParagraphBullets`, …) for what
  the named tools cannot do. It is always destructive, and requires the
  `requiredRevisionId` from the read it was planned against: up to 100
  requests, each exactly one generally available kind (the Developer Preview
  comment and suggestion kinds are refused). Several requests in one
  call apply atomically, and each sees the index shifts of those before it;
  order deletions from the end of the document backwards.
<!-- endfragment -->
