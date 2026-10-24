---
{"name":"drive","instructionsHeading":"Connection instructions"}
---

## Finding files and joining Workspace products

Drive searches file data; operation discovery searches API capabilities.
Use file ids from reads, Drive URLs or the person: an id they give, such as
`pdf1`, works as is. The same id identifies a Google Doc,
Sheet, Slides deck or Form in its product connector. Shared-drive ids identify
membership and the root folder; folder parents determine inherited access.
A missing file and a file the delegated user cannot see fail alike.

Drive query values use single quotes: `name contains 'budget'`,
`mimeType = 'application/pdf'`, `'folder_123' in parents`, or
`modifiedTime > '2026-01-01T00:00:00'`. Trashed files are excluded by default.
`incompleteSearch: true` means Google did not search every corpus; narrow the
query or choose a single shared drive. It is never an exact count.

`maxBytes` is the byte budget and `limit` is rows per page; keep a high limit
for large folders and continue with the same listing arguments. Named `fields`
may narrow and `maxBytes` may change between pages. Hatch paths omit `/drive/v3`.

## Content and file decisions

The content workflow exports Docs as Markdown, Sheets as CSV of the first
sheet only, and Slides as text. Other text files retain their declared charset.
Small binary files can be returned as base64. A drawing, unsupported native
file, folder, shortcut or oversized binary returns an unavailable explanation.
For a shortcut, read its target id instead. Drive exports at most 10 MB.

Content containing sent credentials is withheld as a whole binary value; there
is no partial-content recovery around that boundary. Withheld MIME, shortcut,
folder or parent metadata cannot decide a subsequent read or move. Re-read
through a safe source before trying the workflow again.

## Access and recovery

A file or copy inherits its destination folder's access. Read permission holders
before moving, copying or creating in a shared folder, and read them again after
changing access. Inherited permissions name the parent folder or shared drive
that must be changed instead. An owner cannot be removed or replaced here.

All new grants use `share_file`, which sends no notification email by default.
Confirm intent before granting `anyone` or domain access. Permission creation
through the hatch is refused, including public-link grants; the named workflow
owns grantee validation and notification behavior.

Content updates replace the complete content. A create with an uncertain outcome
needs a search for the intended file before another create. Recoverable trash
can be restored for 30 days. Permanent deletion, ownership transfer, watch
registration, credential minting and generic media transport are outside the
hatch. Use the named content and upload workflows for bounded bytes.
