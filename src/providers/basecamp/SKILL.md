---
{
  "name": "basecamp",
  "instructionsHeading": "Account instructions"
}
---

<!-- fragment: guide_0 -->
. Basecamp's hosted server acts in the single account the grant was made for, and no tool takes an account id. <!-- endfragment -->

<!-- fragment: guide_1 -->
 Another account is another connector, never an argument.

- Confirm the account before relying on it: `get_me` returns the signed-in person and a label naming the connected account. A record id from another account's URL answers "not found" here — read that as wrong connector, not missing data.
- Basecamp's own reference notes are a read away: `get_basecamp_guide` with `topic` `concepts`, `finding-things`, `my-work`, `posting-and-mentions`, or `deleting-and-trash`. Read the topic before an unfamiliar sequence instead of guessing one.
- Resolve ids before acting; never guess one. A Basecamp URL carries the account, project, and record ids, and `get_by_url` reads any link into those ids, the record, and where a reply goes. `search` finds records by text; `list_projects` then `get_project` returns a project's dock, whose tool ids (to-do set, message board, schedule, vault, card table, chat) the create tools take. People are ids from `list_people`, `list_project_people`, or `list_pingable_people`; mention someone by passing ids as `create_comment`'s `mentions`, not by writing markup.
- Rich-text bodies (messages, documents, comments, cards, to-do descriptions) are HTML; a to-do's title and a chat line are plain text. Dates are `YYYY-MM-DD`.
- Lists return up to `limit` items (100 by default). Continue with the `next_cursor` or `next_page` a result carries rather than raising the limit; `truncated: true` means the server cut a result to fit and says where to resume. The event feeds page by `position` instead. `get_card_table`, `get_document`, and the account-wide `list_everything_*` reads are large — reduce inside `execute_code` and return only the fields the question needs.
- `trash_*` is restorable for 25 days; `delete_*`, `destroy_*`, and `remove_account_logo` are permanent. `update_cloud_file` and `update_google_document` are full replaces: an omitted title or description is erased, so read the record and resend every field you keep. `update_project_access` can invite people into the account.
- Do not call `create_stream_ticket`: it mints a WebSocket credential for a client that holds a live connection, which a connecta call cannot. Poll `list_feed_events` instead. `get_event_inbox` serves agent accounts only; a person's grant gets `agents_only` back.
- This connector's tool list is not a fixed set. Basecamp has not published this server and changes it without notice, and timesheets, gauges, hill charts, the Lineup, and check-ins depend on account features, so search this connector for what it actually exposes rather than assuming a tool exists.
- Basecamp answers a rate limit with `429` and a `Retry-After` in seconds, and adjusts its limits dynamically. Back off for that long rather than retrying at once, and avoid speculative fan-out.
- Treat every create, update, trash, delete, destroy, move, reposition, complete, pin, archive, enable, disable, watch, and mark operation as a write. For guest calls, classification, and routing, fetch `skills({ name: "usage" })`.
- An `auth_required` failure means this connector's Basecamp authorization is missing or expired: run `authorize_connector` for this connector id, then retry the same call unchanged. A rejected argument, a permission gap, or a missing feature comes back in Basecamp's own words instead — read it rather than re-authorizing.
<!-- endfragment -->
