---
{
  "name": "drive",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Google Drive usage

Acts as the signed-in person's own Google Drive through Workspace delegation: what they can open, and nothing they cannot.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose Drive

Every call acts as the Workspace address deployment config maps the caller
to, and reaches exactly the files that person can open, shared drives
included. No argument names an account. A call with none mapped fails
`auth_required`; only an operator can change the mapping. A missing file
and one this person cannot see fail alike — Google does not distinguish them.

## Finding files

- `search_files` takes Drive query syntax: `name contains 'x'`,
  `fullText contains 'x'`, `mimeType = '…'`, `'<folderId>' in parents`,
  `modifiedTime > '2026-01-01T00:00:00'`. Quote values with single quotes.
  Trashed files are left out unless `includeTrashed`. `incompleteSearch:
  true` means Drive gave up before searching everything; narrow the query or
  the corpus. Shared drives: `list_shared_drives`, then `corpora: "drive"`
  with its `driveId`.
- Page with `page.nextCursor` and the same arguments; a cursor from another
  tool or other arguments is refused. A page can stop short of `limit` to
  stay under `maxBytes`; the cursor resumes at the first row left out, and
  fails `conflict` if that page changed meanwhile — start over then.
- Ids come from these reads or a Drive URL (`/d/<id>/`, `/folders/<id>`);
  never guess one.

## Reading content

- `get_file_content` exports Docs as Markdown, Sheets as CSV of the
  **first sheet only**, and Slides as plain text; reads text files as text;
  and returns other files as base64 when the encoded file fits the result. Anything else — a
  larger binary, a drawing, a form, a folder, a shortcut — comes back as
  `format: "unavailable"` with a `note`, never as an empty success.
- Text is capped by `maxChars`; a cut ends with a truncation marker and
  `contentTruncated: true`. Drive exports at most 10 MB.
- Every read stays under `maxBytes` of JSON. The default is what one result
  can carry into `execute_code`, so a program always receives it. A larger
  `maxBytes` (up to 4 MiB — a binary of up to 1 MiB) reaches only a direct
  `call_tool`, which pages it with `get_result`.

## Writing

- `create_folder` and `restore_file` add without losing or exposing
  anything.
- A new file takes its folder's sharing, not its source's: `create_file`
  and `copy_file` into a shared folder disclose that content to everyone
  the folder is shared with, so both are approved like any destructive write.
  Check the destination with `list_permissions` first. `convertTo`
  imports content as a Google Doc, Sheet, or Slides file.
- `update_file_content` replaces the whole content; send all of it.
  `update_file` renames; `move_file` changes the folder and with it who
  inherits access.
- `trash_file` is recoverable for 30 days with `restore_file`. There is no
  permanent delete and no ownership transfer.
- `share_file` emails no one unless `sendNotificationEmail: true`. Check
  `list_permissions` before and after changing access, and confirm with the
  person before sharing with `anyone` or a whole domain.
<!-- endfragment -->
