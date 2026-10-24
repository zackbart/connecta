---
{
  "name": "docs",
  "instructionsHeading": "Connection instructions"
}
---

## Find the document first

Document ids join Docs to Drive: take the part after `/d/` in a document URL,
or find the file by name through a Google Drive connection. An id the person
provides works as is. Docs has no
account-data search or listing; its operation search discovers API methods.
A missing document may be absent or inaccessible to the mapped Workspace user.

## Read before editing

The rendering follows document tabs, including nested tabs. Headers, footers,
floating images and comments are not rendered; `notRendered` names omitted
kinds. Suggested insertions and deletions can appear together without marks.
An accepted or rejected suggestions preview cannot supply edit indexes.
Indexed rows page with `page.nextCursor`; keep the same arguments, starting
with `maxChars: 0` when only indexes are needed.

Use the inline view's UTF-16 start/end indexes and revision to plan edits.
Indexes shift after each edit, including earlier requests in the same atomic
batch. Apply independent deletions from the end backwards. A revision is a
precondition, never an idempotency key. Re-read and recompute after a revision
conflict.

Styles, named ranges, headers and footers live in the complete document
resource. Read it with
`docs_api_read({path:"/documents/doc_123",query:{includeTabsContent:true}})`
when a rendering cannot answer the task. Paths omit `/v1`; the hatch reply is
`{status,data}`, with the vendor document in `data` (a program call's
`delivery.data.data`). A Docs
create payload sets a title only; initial text is a separate edit. Appending
joins the final paragraph, so begin with a newline when a new paragraph is
intended. A broad text replacement can rewrite every tab.
Batch kinds include `updateTextStyle` for formatting, `insertTable`,
`createParagraphBullets`, and `deleteContentRange`.

## Recover a partial create

If creation succeeded but initial text failed, keep the created document id.
Append the missing text directly only when the failure proves Google refused
it. Otherwise read that document and add only what is missing. Creating again
would make another document. If the create reply lost its id, search Drive for
the title before attempting a fresh create.

Preview comment and suggestion mutations are unavailable. Comments belong to
Drive. Copying a template or choosing a destination folder also belongs to
Drive; a Docs create starts in My Drive's root.
