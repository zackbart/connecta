---
type: added
---

Add `@zackbart/connecta/providers/intercom`, a maintained Intercom REST provider pinned to API 2.18 with the operation search, details and read hatches, and named conversation writes: `reply_to_conversation` (destructive), `add_conversation_note`, `close_conversation`, `open_conversation`, `snooze_conversation`, `assign_conversation`, `unassign_conversation`, `tag_conversation` and `untag_conversation`. Every write acts as the teammate set by `admin` in deployment config, a fixed admin id or a function of the admitted identity; a call can never supply `admin_id`. The access token lives in the operator vault, `region` selects the US, EU or AU host, and attachment and recording URLs are withheld. The hosted Intercom MCP server stays a `remoteMcp()` connection (#1408, #892).
