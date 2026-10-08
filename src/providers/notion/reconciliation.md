# Notion operation ownership

Hosted MCP is the default for OAuth user operations. Explicit `surface: "api"`
retains required internal-integration operations under `integration_*` names.
Configure distinct connector ids and grants. Each identity has one canonical
implementation; failed calls never switch identity or replay a write.

Reviewed on 2026-10-07: [supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools)
and [authorization](https://developers.notion.com/guides/mcp/get-started-with-mcp).
Hosted MCP requires interactive user OAuth and cannot adopt an internal token.
User access/ownership is not equivalent to the bot's sharing and capability
boundary. Consequently, every bot-scoped REST capability remains available,
including headless discovery, creation, edits and comments. These are deliberate
auth complements, not fallback implementations for user OAuth operations.

| Capability | Canonical owner | Reason |
| --- | --- | --- |
| User-owned search/content/users/comments/creation/editing | Hosted MCP | Vendor user identity and live contracts |
| Required integration-owned content/search/creation/editing/comments/users | API `integration_*` | Hosted OAuth cannot act as the configured internal integration |
| Complete property items | API `integration_get_page_property` | REST property-item cursors absent from published MCP fetch |
| Complete data-source scan | API `integration_query_data_source` | Hosted rows mode caps at 100 with no cursor and may be plan-metered |
| Exact JSON block read/append positions | API `integration_get_page_content`, `integration_append_blocks` | Preserve typed block data and position contract rather than converting to markdown |
| Bot identity | API `integration_get_self` | Identifies the configured internal integration |
| Trash/restore | API `integration_trash_page` | Published MCP update contract does not promise REST `in_trash` |
| Sessions/agents/attachments/other workspace objects | Hosted MCP | Not present in the authored REST catalog |

| Retired ambiguous API name | Canonical integration replacement |
| --- | --- |
| `search` | `integration_search` |
| `get_page` | `integration_get_page` |
| `get_page_content` | `integration_get_page_content` |
| `get_page_property` | `integration_get_page_property` |
| `get_database` | `integration_get_database` |
| `get_data_source_schema` | `integration_get_data_source_schema` |
| `query_data_source` | `integration_query_data_source` |
| `list_users` | `integration_list_users` |
| `get_self` | `integration_get_self` |
| `list_comments` | `integration_list_comments` |
| `create_page` | `integration_create_page` |
| `append_blocks` | `integration_append_blocks` |
| `update_page_properties` | `integration_update_page_properties` |
| `trash_page` | `integration_trash_page` |
| `add_comment` | `integration_add_comment` |

Before/after registry catalogs and classification evidence are recorded in
`reconciliation-before.json` and `reconciliation-after.json`. Hosted listings
use reviewed synthetic transport facts, not authenticated live captures.
