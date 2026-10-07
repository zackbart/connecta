---
type: added
---

**Draft-only Gmail connection.** `@zackbart/connecta/providers/gmail`
exports `gmail(id, { purpose, serviceAccount, subject, title?,
instructions?, callAdmission?, maxResultBytes?, baseUrl? })`, plus
`GMAIL_SCOPES` and `GMAIL_API_BASE_URL`. Eight hand-written tools:
`search_threads` (Gmail search syntax, cursor-paged, each thread summarized),
`get_thread`, `get_message` (the message's own body — never an attached or
forwarded email's — decoded from its charset, HTML converted only when no
text part exists, fetched from the attachments endpoint when Gmail stored it
apart, reported as `bodyFormat: "unavailable"` rather than empty when too
large to read, capped by `maxBodyChars` with an explicit marker, and
metadata only for attachments, which include unnamed inline images and any
other part that is not body text), `list_labels`, `list_drafts`,
`get_draft`, `create_draft`
(To/Cc/Bcc, RFC 2047-encoded headers, an optional HTML alternative, and
`replyToMessageId`, which sets the thread, `In-Reply-To`, `References`, a
`Re:` subject, and every recipient of the replied message's Reply-To or
From, parsed as an RFC 5322 address list), and `update_draft` (replaces the
body; keeps From, To, Cc, Bcc, Reply-To, Subject, the thread, and the reply
headers unless restated, and no other header; refuses, unchanged, a draft
with attachments, inline images, or anything else Gmail's whole-message
update would delete, and one nested deeper than it inspects). Every result
is built to stay under 192 KiB of JSON, so it reaches a program through
`execute_code`'s 256 KiB bridge as well as `call_tool` — the whole result,
wrapper and cursor included, measured as sent rather than estimated:
`get_thread` and `list_labels` page by cursor when a thread or label set is
larger, every string field is bounded, an identifier far past any Gmail id
is dropped rather than cut and the drop is said — `omittedIds` names the
field, `labelIdsOmitted`, `labelsOmitted`, and `attachmentsOmitted` count
what a list left out — a saved draft whose id Gmail returned unusably still
reads `saved: true` with a note pointing to `list_drafts`, a body past
the limit ends with a marker at any `maxBodyChars`, and an untouched
`raw: true` message past it is refused with the way forward. Every cursor is
bound to the tool and arguments that issued it, and a thread or label page
resumes by the identity of what came before: a message or label added or
removed before that point answers `conflict` rather than repeating or
skipping one. There is no send, delete, or label tool and no raw
hatch; `gmail.compose` technically permits sending, and the tool surface is
what forbids it. `create_draft` is an additive write and `update_draft` a
destructive one; neither is exempt from approval unless the deployment says
so in `execute.approval`. The transport is confined beneath `users/me`, so the
token's subject is the only mailbox a request can reach. Setup — Cloud
project, API, service account with no IAM roles, JSON key (and the
`iam.disableServiceAccountKeyCreation` override some organizations need), and
the Admin console's domain-wide delegation entry with exactly
`gmail.readonly` and `gmail.compose` — is documented on `gmail()` itself.
