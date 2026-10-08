---
{
  "name": "notion",
  "instructionsHeading": "Workspace instructions"
}
---

<!-- fragment: guide_0 -->


## Databases contain data sources

A Notion database is a container; the rows and the schema live in a *data
source* inside it. The two ids are not interchangeable and Notion rejects the
wrong one.

- The id in a Notion database URL is a **database id**.
- `get_database` turns it into the `data_sources` list — usually one entry.
- `get_data_source_schema` and `query_data_source` take that
  **data_source_id**, and so does `create_page` when adding a row.

So the sequence for "find rows in this database" is `get_database` →
`get_data_source_schema` → `query_data_source`. `search` returns data
sources directly and skips the first step.

## Property quirks that break writes

- Property names in filters, sorts, and writes must match the schema exactly,
  including case. Read `get_data_source_schema` before composing one.
- `select` and `status` writes must use an existing option name; inventing
  one fails. The schema lists the valid options.
- Writes **replace** a property. Sending one item to a `multi_select` or
  `relation` drops the others, so send the complete intended value.
- `rollup`, `formula`, `unique_id`, and the created/edited fields are
  computed. They cannot be written.
- A page's title column is rarely called "title" — pass `title_property` from
  the schema when creating or updating a row.
- Notion truncates `title`, `rich_text`, `relation`, and `people` at 25
  entries. `get_page` reports each one in `truncated_properties` as
  `{ name, id }`; pass that `id` as `property_id` to
  `get_page_property` for the complete value.

## Reading page content

`get_page` returns properties. `get_page_content` returns the body as flat
blocks. Nested blocks (toggles, list children, table rows) need `depth`, and
each level multiplies requests — a deep read stops at an internal ceiling and
reports `truncated: true` rather than spending the whole rate-limit budget.

## Appending is append-only

`append_blocks` adds children and nothing else. It cannot move, reorder, or
replace an existing block, and a block appended through the API can never be
relocated by it afterwards. Get the position right the first time with
`position` and `after_block_id`. Notion caps one call at 100 blocks.

## Lean by default, raw on request

Every read projects Notion's payload down to ids, plain text, and flattened
property values. Where the dropped detail can matter — `search`, `get_page`,
`get_page_content`, `get_page_property`, `get_data_source_schema`,
`query_data_source`, `list_comments` — pass `raw: true` to get Notion's
untouched response instead. It is much larger; reach for it only when a
specific field is missing. Narrow `query_data_source` and `get_page` with
`properties` instead whenever the goal is fewer fields, not more.

`get_page_content` with `raw: true` returns one level exactly as Notion
sent it and does not walk nested children, so `depth` is ignored alongside
it. A block type this projection does not model keeps its payload under
`raw` on the block itself, so nothing silently flattens to an empty string.

## Failures worth reading carefully

- **404** means "no such object" *or* "not shared with this integration", and
  Notion will not say which. Never conclude a page was deleted from it; check
  that the page is shared with the integration in Notion.
- **403** is not an expired token. The integration is missing a capability
  (comment capabilities are off by default) or the object was never shared.
  Re-authorizing cannot fix it; an operator must change it in Notion.
- **429** carries a retry window. Notion allows roughly three requests per
  second per integration, so wait it out rather than retrying immediately.

## No escape hatch

This connection has no guarded raw-REST tool, deliberately. Notion's public
API is small and slow-moving enough for the named surface to cover it, so
there is no `notion_api_*` to reach for — an operation absent from the tool
list is absent from this connection, not hidden behind a generic call.

## Writes and pagination

- Notion has **no idempotency key**. A retried `create_page` or
  `add_comment` creates a duplicate. Confirm with `search` before repeating
  a write that may have partially succeeded.
- List tools take `page_size` (max 100) and return `has_more` with
  `next_cursor`. Pass a cursor back verbatim — it is opaque and must never be
  parsed or constructed. Follow pages inside `execute_code` and reduce there.
<!-- endfragment -->

<!-- fragment: guide_1 -->
# Notion MCP usage

Official MCP interface: tool names, descriptions, argument schemas, and result
schemas come from Notion's live server. Connecta preserves that catalog and
only fills in release-reviewed safety annotations when Notion leaves them out.

Workspace purpose: <!-- endfragment -->

<!-- fragment: guide_2 -->


- Discover the live catalog before assuming a tool exists. Notion can gate
  tools by workspace, account, client, and rollout independently of Connecta.
- Start broad discovery with `notion-search`, then use `notion-fetch` on
  the exact page, database, data source, or object before changing it.
- Use the live input schema as the contract. Notion owns these MCP schemas;
  the REST schemas in Connecta's API interface do not apply to MCP tools with
  similar names.
- Session and agent tools can launch asynchronous work. Read session state and
  events before sending another message, waiting, or stopping a session.
- File uploads and attachment tools create durable workspace state. Keep
  downloads inside the requested task and do not expose signed attachment URLs.
- An `auth_required` failure means this connector's OAuth grant is missing or
  expired. Run `authorize_connector` for this connector id, then retry.
<!-- endfragment -->
