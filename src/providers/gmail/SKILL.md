---
{
  "name": "gmail",
  "instructionsHeading": "Connection instructions"
}
---

Use Gmail search for mail; use Drive for files and sharing.
Gmail is a documented exception to the four-hatch default: there is no write hatch; drafts go only through `create_draft` and `update_draft`, and sending is never available.

## Mail and joins

Reuse the person's Gmail search phrasing (`from:`, `subject:`, `is:unread`,
`newer_than:7d`, `label:`). Thread ids identify conversations; message ids
identify individual messages. Join a message's label ids to label names.
A draft has a stable draft id and a message id that changes on each update.
Use the draft id to reconcile a save.

Named reads interpret MIME, charsets, HTML and attachment metadata. An
attached or forwarded email is carried content, never the message's own body.
`bodyFormat: "unavailable"` means the stored body could not be read within
this connection's bounds; explain that limitation. `bodyNote` and attachment
`note` retain charset fallback notices even when content is cut. A thread
cursor fails `conflict` when earlier content changed; restart that thread.

Use indexed reads for unprojected RFC headers, MIME parts, mailbox profile
and mail history. Paths are relative to the configured mailbox: `/messages/message1`.
The index also shows refused operations and named alternatives. A discovered
operation is executable only when its verdict says read. Delegation never
lets arguments choose a different mailbox.

## Attachment identity and bytes

Resolve an attachment through its message and immutable part id, including
an empty root part id. Gmail may rotate download ids between reads; prefer
the part id and read the listing again after an unknown-id refusal.
Only carried parts can be read by the named attachment workflow.

Text and forwarded mail render readable content in their declared charset.
Binary content uses `{ format: "base64", content }`; pass it unchanged to
Drive's `create_file` as `contentBase64`, with the returned filename and MIME
type. That file creation is a separate write. Downloads and inline data are
limited to one MiB and validated against original decoded sizes. Raising
result budgets never bypasses that cap. `format: "unavailable"` supplies a
reason and no content. Large direct reads can use the documented byte budget;
keep program results small and reduce text before returning it.

## Draft recovery

A reply draft inherits the message's thread, reply headers, subject and
recipients unless restated. Keep the reply subject to retain the Gmail thread.
Copied threading headers must be intact ASCII Message-ID tokens; damaged or
withheld tokens cause a refusal before any draft write.

Updating a draft replaces its full body. The guarded workflow preserves
sender, recipients, Reply-To, subject and threading headers, and refuses
attachments or inline images because replacement would discard them. Edit
such a draft in Gmail or save a separate new draft. After an uncertain save,
read the stable draft id and inspect its body before deciding whether another
write is needed. A saved draft remains in Gmail for the person to review.
