---
type: added
---

**Google Drive connection.** `@zackbart/connecta/providers/drive` exports
`drive(id, options)` with the same Workspace delegation options, plus
`DRIVE_SCOPES` (exactly `https://www.googleapis.com/auth/drive`) and
`DRIVE_API_BASE_URL`. Seventeen hand-written tools, every one reaching shared
drives as well as My Drive. Reads: `search_files` (Drive query syntax, trash
left out unless asked, `user`/`drive`/`allDrives`/`domain` corpora, Drive's
own `incompleteSearch` surfaced), `list_folder_items`, `get_file`,
`get_file_content` (Docs exported as Markdown, Sheets as CSV of the first
sheet only, Slides as text, text files read by range and cut at `maxChars`
code points, never inside a character, binaries as base64 when the encoded
file fits the result and never past 1 MiB, and anything else — a larger
binary, a drawing, a form, a folder, a shortcut — as `format: "unavailable"`
with a note rather than an empty success; the caps hold on the bytes the
download returns, never on the size metadata reported, so a file that grew,
shrank, or emptied between the two reads is still read right — a download
is read only one byte past its cap and the rest of the stream cancelled
unread, even from a server that ignores the range, and a range answered
`416` with `Content-Range: bytes */0` is a verified empty file — and Drive's
10 MB export limit is named from Google's own reason code),
`list_permissions`, and `list_shared_drives`. Every read is built to stay
under `maxBytes` of JSON, envelope and cursor included: 192 KiB by default,
which a program inside `execute_code` always receives, from 64 KiB to 4 MiB
on request, above the default for a direct `call_tool` only. A final guard
around every tool refuses any result past that bound rather than returning
it; a write it stops has applied, and says to re-read rather than repeat. A listing that would outgrow it stops early with a
cursor that resumes at the first row left out, and fails `conflict` rather
than skip or repeat a row if that Drive page has changed since — the cursor
carries fingerprints of Drive's raw ids for that page, in order, and of the
last one returned. A cursor is never issued that could not be accepted back:
a Drive page token too long to carry fails, saying so.
Every cursor is bound to its tool and the arguments that decide its rows,
and refused elsewhere. Content is cut with a marker naming the bound that
cut it. Names are cut at 2 KiB in listings and content results and 32 KiB in
`get_file`, descriptions at 64 KiB, other strings Drive does not bound at
1 KiB, and owners and parents at ten; identifiers are never cut, and one that
is malformed is left out. Every such field is named in the result's
`truncatedFields`.
Additive writes:
`create_folder` and `restore_file`. Destructive writes: `create_file` (text
or base64 content as one multipart upload, or an empty file; `convertTo`
imports it as a Google Doc, Sheet, or Slides file) and `copy_file`, because
a new file takes its folder's sharing and so discloses its content to
everyone a shared destination reaches. These classify as writes, as do `update_file_content`,
`update_file` (rename, description), `move_file` (a move changes inherited
sharing), `trash_file`, `share_file` (user, group, domain, or anyone with
the link, up to writer or organizer, emailing no one unless
`sendNotificationEmail`), `update_permission`, and `delete_permission`.
A create, copy, or share that may have landed — sent with no answer,
answered with a redirect it never follows, answered 5xx (a rate-limit reason
on a 5xx included), or accepted with a reply that broke — is never
retryable and names the read to check before repeating it, since a repeat
makes a second one. Only a write Google answered 2xx is ever said to have
applied. Writes that set fixed values (`update_file_content`, `update_file`,
`trash_file`, `restore_file`, `update_permission`) are sent as idempotent, so
a 5xx to them stays a retryable outage.
There is no permanent delete,
no empty-trash, no ownership transfer, and no raw hatch. A 404 says the file
may be missing or hidden from this account, because Drive does not say
which. Setup — the Google Drive API and the one scope on the delegation
entry — is documented on `drive()` itself.

Trusted pools permit program writes; read-only pools use `call_destructive_tool`.
The MCP host controls approval.
