---
{
  "name": "gmail",
  "instructionsHeading": "Connection instructions"
}
---

Use Gmail search for mail; use Drive for files and sharing.
Sending acts at once in the person's name and cannot be recalled; save a draft when they want to review first.

## Mail and joins

Reuse the person's Gmail search phrasing (`from:`, `subject:`, `is:unread`,
`newer_than:7d`, `label:`). Thread ids identify conversations; message ids
identify individual messages. Join a message's label ids to label names with `list_labels`; system labels
use fixed ids (`INBOX`, `UNREAD`, `STARRED`, `IMPORTANT`, `SPAM`, `TRASH`),
user labels opaque ones such as `Label_12`.
A draft has a stable draft id and a message id that changes on each update.
Use the draft id to reconcile a save.

`search_threads.items` are threads with thread ids; read each thread to get its message ids.
`get_thread` pages long threads.
`list_labels` reads all labels once, without artificial paging; `truncated`
reports any labels omitted by the result byte bound.
On very large label sets, `list_labels` may truncate; `gmail_api_read` at `/labels` returns all labels.

Named reads interpret MIME, charsets, HTML and attachment metadata. An
attached or forwarded email is carried content, never the message's own body.
`bodyFormat: "unavailable"` means the stored body could not be read within
this connection's bounds; explain that limitation. `bodyNote` and attachment
`note` retain charset fallback notices even when content is cut. A thread
cursor fails `conflict` when earlier content changed; restart that thread.

Use indexed reads for unprojected RFC headers, MIME parts, mailbox profile
and mail history. Paths are relative to the configured mailbox: replace `{id}`
in `/messages/{id}` with a message id obtained from an earlier read.
The index also covers mailbox settings without a named tool: forwarding
addresses and auto-forwarding, delegates, send-as aliases and signatures,
S/MIME, IMAP/POP, language, client-side encryption and push watches. No
argument chooses a different mailbox.

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

<!-- when: writes -->
## Sending

A new message needs recipients. A reply (`replyToMessageId`) joins the
answered message's thread and goes only to its Reply-To, else its From,
unless recipients are restated; for reply-all, pass the original To and Cc.
Keep the reply subject to retain the Gmail thread. A forward attaches the
original unchanged as an .eml, with its files, in the same thread. Gmail
sets From to the mailbox itself; no argument chooses a sender.
`send_draft` sends a draft exactly as saved. After an uncertain send, search
`in:sent` with its subject and recipient before deciding whether to send again.

## Organizing and removing mail

Archiving removes `INBOX`; marking read removes `UNREAD`; starring adds
`STARRED`. A thread change applies to every message in it. Prefer trash,
which Gmail keeps for 30 days and the restore tools undo; permanent deletion
skips the trash and is unrecoverable, so use it only when the person asks for
it. Deleting a label removes it from every message but keeps the messages.
Filters act only on mail that arrives later; a filter's forward address must
already be a verified forwarding address. Vacation times are ISO 8601 and an
unstated setting keeps its current value.

## Draft recovery

A reply draft inherits the message's thread, reply headers, subject and
recipients unless restated. Keep the reply subject to retain the Gmail thread.
Copied threading headers must remain intact ASCII. RFC message ids, comments
and legacy threading phrases are accepted; damaged or withheld tokens cause
a refusal before any draft write.

Updating a draft replaces its full body. The guarded workflow preserves
sender, recipients, Reply-To, subject and threading headers, and refuses
attachments or inline images because replacement would discard them. Edit
such a draft in Gmail or save a separate new draft. After an uncertain save,
read the stable draft id and inspect its body before deciding whether another
write is needed. A saved draft remains in Gmail for the person to review.
<!-- end -->
