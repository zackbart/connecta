---
{
  "name": "notion",
  "instructionsHeading": "Workspace instructions",
  "content": "shared"
}
---

<!-- fragment: oauth_head -->
# Notion MCP usage

Official MCP interface: tool names, descriptions, argument schemas, and result
schemas come from Notion's live server. Connecta preserves that catalog and
applies release-reviewed classification. Reviewed writes stay writes even when Notion claims they only read.

Workspace purpose: <!-- endfragment -->

<!-- fragment: oauth -->


- This connection acts as its OAuth-authorized user and reaches what that user
  can. It holds no integration token. An internal integration (bot) is a
  separate connector with `auth: { type: "token" }` under another id; never
  switch to it to recover a failed call here.
- Discover the live catalog before assuming a tool exists. Notion can gate
  tools by workspace, account, client, and rollout independently of Connecta.
- Start broad discovery with `notion-search`, then use `notion-fetch` on
  the exact page, database, data source, or object before changing it.
- Use the live input schema as the contract. Notion owns these MCP schemas;
  the REST schemas of Connecta's token connector do not apply to MCP tools with
  similar names.
- Session and agent tools can launch asynchronous work. Read session state and
  events before sending another message, waiting, or stopping a session.
- File uploads and attachment tools create durable workspace state. Keep
  downloads inside the requested task and do not expose signed attachment URLs.
- Connecta's generic REST tools (`notion_api_*`) and the `integration_*`
  helpers exist only on a token connector.
- An `auth_required` failure means this connector's OAuth grant is missing or
  expired. Run `authorize_connector` for this connector id, then retry.
<!-- endfragment -->

<!-- fragment: key -->

## Identity and tools

This is Connecta's REST connector to `api.notion.com`, acting as one internal
integration (a bot) with an operator-managed integration token. It reaches
exactly the pages and data sources shared with that integration, and the
integration's capabilities decide which calls succeed: comment and
user-information capabilities are off by default. It never acts as a person.
Hosted Notion MCP is a separate OAuth connector.

- Named tools cover the common path and flatten Notion's payloads:
  `integration_search` (titles), `integration_get_page` (properties),
  `integration_get_page_content` (blocks as text),
  `integration_get_data_source_schema`, and `integration_query_data_source`
  (rows). `integration_create_page` and `integration_append_blocks` author
  Notion's rich-text and block shapes from plain text, Markdown, or checklists.
- Four generic tools reach every other operation in the pinned API index.
  `notion_api_search` finds operations, not content. `notion_api_details`
  returns one operation's parameters. `notion_api_read` calls GETs plus the
  read-only POST queries: search, data source and meeting note queries, and
  agent, session, and session event queries. `notion_api_write` calls every
  other POST, PATCH, and DELETE with `method` and `path` stated.
- Every generic call is checked against the index before it is sent. An
  unknown path returns the nearest operations, and an unknown or missing
  parameter returns `validation.issues` with the accepted names. Nothing
  reached Notion, so fix the call from that answer.
- The generic set replaces the old one-operation tools. Read a database
  container with `GET /v1/databases/{database_id}`, users with `GET /v1/users`
  or `GET /v1/users/me`, comments with `GET /v1/comments`, and a page as
  Markdown with `GET /v1/pages/{page_id}/markdown`. Update properties, trash or
  restore (`in_trash`) with `PATCH /v1/pages/{page_id}`, and comment with
  `POST /v1/comments`.
- Refused by design: Notion's OAuth token endpoints (`/v1/oauth/*`) and
  multipart file sends. Import a file with `POST /v1/file_uploads` and
  `mode: "external_url"` instead.
- Not here: the hosted MCP's user identity, its search across connected
  apps, page duplication, team and skill search, attachment downloads, and
  page-to-skill conversion. Those need an OAuth connector.

## Databases contain data sources

- The id in a Notion database URL is a **database id**.
  `GET /v1/databases/{database_id}` through `notion_api_read` lists its
  `data_sources`, usually one. `integration_search` returns data sources
  directly and skips that step.
- `integration_get_data_source_schema` and `integration_query_data_source`
  take the **data_source_id**, and so does `integration_create_page` when
  adding a row.

So the sequence for "find rows in this database" is the database read, then
`integration_get_data_source_schema`, then `integration_query_data_source`.

## Reading

- `integration_get_page` returns properties. `integration_get_page_content`
  returns the body as flat blocks. Nested blocks (toggles, list children,
  table rows) need `depth`, and each level multiplies requests. A deep read
  stops at an internal ceiling and reports `truncated: true` rather than
  spending the whole rate-limit budget.
- Notion truncates `title`, `rich_text`, `relation`, and `people` at 25
  entries. `integration_get_page` reports each in `truncated_properties` as
  `{ name, id }`; read the complete value with `notion_api_read`
  `GET /v1/pages/{page_id}/properties/{property_id}` and follow its cursor.
- Every named read projects Notion's payload to ids, plain text, and
  flattened property values. Pass `raw: true` for Notion's untouched response
  when a specific field is missing. It is much larger. Narrow
  `integration_query_data_source` and `integration_get_page` with `properties`
  when the goal is fewer fields. `integration_get_page_content` with
  `raw: true` returns one level and ignores `depth`.

## Appending is append-only

`integration_append_blocks` adds children and nothing else. It cannot move,
reorder, or replace an existing block, and a block appended through the API can
never be relocated by it afterwards. Get the position right the first time with
`position` and `after_block_id`. Notion caps one call at 100 blocks.

## Pagination

- Named list tools take `page_size` (max 100) and return `has_more` with
  `next_cursor`; pass it back as `start_cursor`.
- Generic results arrive as `{ status, data, page? }`. On a list,
  `page.next` is the cursor and `page.param` is `start_cursor`: send it in
  `query` for a GET, and in `body` when `page.in` is `body`, as on the POST
  queries. Pass `select` dot paths relative to `data`, such as `results.id`;
  `page` survives any `select`.
- A view query is created with `notion_api_write`
  `POST /v1/views/{view_id}/queries`, a write because Notion stores it until
  `expires_at`. Its first page names the continuation in `page.path`: read
  `GET /v1/views/{view_id}/queries/{query_id}` with `start_cursor` in `query`.
- Meeting-note queries have no cursor. `limit` caps at 50, and
  `page.hasMore` without `page.next` means more notes exist: narrow the
  filter (for example by `created_time`) rather than paging.
- Cursors are opaque: never parse or construct one. Follow pages inside
  `execute_code` and reduce there.

## Failures worth reading carefully

- **404** means "no such object" *or* "not shared with this integration", and
  Notion will not say which. Never conclude a page was deleted from it; check
  that the page is shared with the integration in Notion.
- **403** is not an expired token. The integration is missing a capability
  (comment capabilities are off by default) or the object was never shared.
  Re-authorizing cannot fix it; an operator must change it in Notion.
- **429** carries a retry window. Notion allows an average of three requests
  per second per integration; Connecta admits 180 calls a minute, three at a
  time, per runtime. Wait out the window rather than retrying immediately.
<!-- endfragment -->

<!-- fragment: shared -->

## Notion's data model

- A database is a container; its rows and schema live in a *data source*
  inside it. Queries, schema reads, and new rows take the data source, and
  Notion rejects a database id in its place.
- Property names in filters, sorts, and writes must match the schema exactly,
  including case. Read the schema before composing one.
- `select` and `status` writes must use an existing option name; inventing
  one fails. The schema lists the valid options.
- Writes **replace** a property. Sending one item to a `multi_select` or
  `relation` drops the others, so send the complete intended value.
- `rollup`, `formula`, `unique_id`, and the created and edited fields are
  computed. They cannot be written.
- A data source's title column is rarely called "title". Read its name from
  the schema before creating or renaming a row.
- Notion has **no idempotency key**. A retried page create or comment makes a
  duplicate. Confirm with a search before repeating a write that may have
  partially succeeded.
<!-- endfragment -->
