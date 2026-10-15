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
- Results default to at most 192 KiB; `list_labels` pages the same way.
- `get_message` and `get_thread` list attachment metadata. An attached or
  forwarded email is an attachment, not the body.
- `bodyFormat: "unavailable"` means Gmail stored the body apart from the
  message and it is too large to read here; say so rather than summarizing.
- `get_message`, each `get_thread` message, and `get_draft` return `bodyNote`
  when decoding falls back to UTF-8 for an unsupported charset. The note
  survives character and result-byte truncation, including `maxBodyChars: 0`
  when inline body data is decoded. It counts toward the result's byte limit.

## Attachments

- `get_attachment` takes `messageId` and the listing's immutable `partId`.
  Prefer `partId`, which stays stable across message reads, including an
  empty id for a root attachment. `attachmentId` is an alternative that
  Gmail can rotate between reads. When both are supplied, `partId` wins and
  the fresh message's download id is used. Read the listing again after
  an unknown-id refusal; never store an attachmentId for later use.
- Small attachments can have inline data and no attachmentId. Use their
  partId too. Only carried attachment parts can be read, never arbitrary
  message body parts or blind download ids.
- Text, JSON, XML, calendar invites, CSV, and `message/rfc822` return
  `format: "text"` and `content` decoded in the declared charset. An unsupported
  charset produces an explicit `note` that decoding used UTF-8. Message bodies
  return the notice separately as `bodyNote`.
  Parsed forwarded emails render From, To, Date, Subject, and their own
  plain body, else HTML converted to text. Raw forwarded data is preferred
  when present. A forwarded email without readable text returns an
  `unavailable` note.
  `maxChars` defaults to 12,000 code points, at most 100,000. A character
  or byte cut ends with a truncation marker and `contentTruncated: true`.
  Reduce attachment text inside `execute_code` before returning it.
- Binary attachments return `format: "base64"` and standard base64 in
  `content`. Pass it unchanged to Drive `create_file` as `contentBase64`,
  with `name: filename` and `mimeType`. File creation is a write: use
  `call_destructive_tool` or a program on a writable endpoint for that step.
- Downloads, text and binary, are limited to 1 MiB. Declared size is
  checked before a separate download. Parsed forwarded emails check the sum
  of descendant sizes before downloading any stored body, and return that
  sum as `size`. Attachment data must match both the message part's declared
  size and the download response's size when supplied; inconsistent payloads
  fail rather than return incomplete files. Binary content must also fit the
  whole-result `maxBytes`, which defaults to 192 KiB. `format: "unavailable"`
  returns a note and no content when it cannot fit. Raising `maxChars`
  or `maxBytes` cannot bypass the download cap.
- Raise `maxBytes` only for a direct `call_tool` read, from 64 KiB up to
  4 MiB, as with Drive `get_file_content`. `execute_code` cannot receive
  large results; keep the default there. Direct-call results may be paged.

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
