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
`unknown` are retired types to skip. Reading one conversation returns its
parts; list and search results do not, so read the conversation to see the
whole thread.

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

A reply to a closed conversation reopens it. Closing sends the customer
nothing. A conversation can have both a teammate and a team assignee;
unassigning clears both. Tags must already exist: find the tag id in the
tags list.

Read the conversation again before repeating a write whose outcome is
unknown; a repeated reply or note is a second message.
<!-- end -->
