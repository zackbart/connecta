---
{"name":"intercom","instructionsHeading":"Workspace instructions"}
---

## Workspace records

Intercom ids are numeric strings: conversations, teammates (admins), teams,
tags and tickets. Contacts use hex ids; `external_id` is the customer's own
identifier, and an email address is human-readable but can match several
contacts. Resolve an id from a list or search before acting on it; a name or
email is never an id.

A conversation's `source` is its first message. `conversation_parts` holds
everything after it in order: comments, notes, assignments, closes and other
events. `part_type` says which; a `note` is teammate-only, and parts typed
`unknown` are retired types to skip. List and search results carry no parts;
read the conversation for them.

Reading a conversation without `page` returns only its 500 most recent parts.
To read a whole thread, send `page` 1 (with `per_page` up to 500): parts then
come oldest first, and the read's next cursor continues until no page
remains. Part-type and `parts_created_after`/`parts_created_before` filters
apply before paging. `conversation_parts.total_count` counts only the parts in
that response, never the conversation's total.

The access token belongs to the teammate who installed the app, and reads see
only what that teammate's conversation access allows. A missing conversation
or contact does not prove it does not exist.

Search endpoints take a `query` of `field`, `operator` and `value` filters,
nested under `AND` or `OR`. Timestamps throughout are Unix seconds in UTC.
Attachment and file download links are withheld; names, types and sizes
remain.

<!-- when: writes -->
## Writing as a teammate

Every write acts as the teammate this connection's deployment configured.
`reply_to_conversation` sends the customer a message they see, by email or in
the Messenger, and cannot be recalled. Use `add_conversation_note` for
anything meant only for teammates, and reply only when the user asked for
customer-facing words.

A reply to a closed conversation reopens it, and so does assigning or
unassigning it. Closing skips notifications but can still send the customer a
satisfaction survey or a workflow's message, so close only when the user asked
for it. A conversation can have both a teammate and a team assignee;
unassigning clears both. Tags must already exist: find the tag id in the
tags list.

Read the conversation again before repeating a write whose outcome is
unknown; a repeated reply or note is a second message.
<!-- end -->
