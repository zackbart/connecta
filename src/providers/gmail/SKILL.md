---
{
  "name": "gmail",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Gmail usage (draft-only)

Acts as the signed-in person's own Gmail through Workspace delegation: read mail and write drafts, never send.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose mailbox

Every call reads and writes the mailbox deployment config maps the caller
to. No argument names a mailbox. A call with none mapped fails
`auth_required`; only an operator can change the mapping.

## Reading

- `search_threads` takes Gmail search syntax; reuse the person's own
  phrasing (`from:`, `subject:`, `newer_than:7d`, `is:unread`,
  `label:`). Page with `page.nextCursor` and the same query.
- `get_thread` returns messages oldest first with bodies capped by
  `maxBodyChars`; a cut body ends with a truncation marker. A long thread
  pages: follow `page.nextCursor` until `hasMore` is false, with the same
  arguments. `conflict` means the thread changed under the cursor; read it
  again from the start. Reduce inside
  `execute_code` before returning a long thread.
- Every result stays under 192 KiB; `list_labels` pages the same way.
- Attachments are listed by name, type, and size only; none is downloaded.
  An attached or forwarded email is an attachment, not the body.
- `bodyFormat: "unavailable"` means Gmail stored the body apart from the
  message and it is too large to read here; say so rather than summarizing.

## Drafting

- `create_draft` saves a draft and never sends it; tell the person it is
  waiting in Drafts. There is no send, delete, or label tool.
- To reply, pass `replyToMessageId`: the draft joins that thread with
  In-Reply-To and References set, and subject (Re: …) and `to` default
  from that message's Reply-To, else its From. Keep the Re: subject or Gmail
  may start a new thread.
- `update_draft` replaces the body entirely; send the full new text.
  From, To, Cc, Bcc, Reply-To, Subject, the thread, and reply headers are
  kept unless restated; no other header is. A draft with attachments or
  inline images is refused, unchanged — Gmail's update would delete them.
- Gmail sets From to the mailbox itself; there is no From argument.
<!-- endfragment -->
