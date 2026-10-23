---
{
  "name": "notion",
  "instructionsHeading": "Workspace instructions",
  "content": "shared"
}
---



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
  or `GET /v1/users/me`, and comments with `GET /v1/comments`. Update
  properties, trash or restore (`in_trash`) with `PATCH /v1/pages/{page_id}`,
  and comment with `POST /v1/comments` (`rich_text` or `markdown`).
- Refused by design: Notion's OAuth token endpoints (`/v1/oauth/*`) and
  multipart file sends. Import a file with `POST /v1/file_uploads` and
  `mode: "external_url"` instead.
- Notion-minted file links lose their whole query and fragment wherever
  they appear, including page Markdown, async task results, and error text.
  Connecta matches the actual authority: `file.notion.so`,
  `secure.notion-static.com`, `notionusercontent.com` and their subdomains,
  or the `prod-files-secure` and `secure.notion-static.com` S3 buckets,
  virtual-hosted or exactly the first path segment on an S3 endpoint.
  Escaped schemes, slashes, and query/fragment openers are recognized. The
  withheld span runs through the next whitespace, quote, or angle bracket;
  trailing closing punctuation comes back. A returned file URL names the
  file but cannot download it. Links at other authorities, including proxy
  URLs with a Notion URL inside their path or query, come back as written.
  AWS `X-Amz-*` and Google `X-Goog-*` signing `Signature`, `Credential`, and
  `Security-Token` values are withheld at any host.
- A write whose Notion file link carries the exact `[redacted]` placeholder
  in its own query or fragment, plain or up to four layers encoded, is
  refused before dispatch. Each inline Markdown destination is checked,
  including adjacent links and images, balanced or escaped parentheses, and
  leading spaces, tabs, or one line ending. A marker after the destination's
  close is ordinary text. To keep a file, leave its block in place or
  re-upload it with `POST /v1/file_uploads`; to edit Markdown around media,
  match `old_str` on nearby text rather than the withheld URL.
- Each string is scanned separately. Links split across rich-text runs,
  encoded hostnames or signing-parameter names, bare hosts without `//`,
  and userinfo before a Notion host are outside this scan's threat model.
  The shared URL rule still removes userinfo from whole URL fields.
  Credential-named fields read as `"[redacted]"`, a database property named
  like a credential (`API token`) included. Failures of the OAuth, file upload, bot user, and
  agent operations carry Notion's code, not its message.
- Not here: the hosted MCP's user identity, its search across connected
  apps, page duplication, team and skill search, attachment downloads, and
  page-to-skill conversion. Those need an OAuth connector.

## Databases contain data sources

- The id in a Notion database URL is a **database id**.
  `GET /v1/databases/{database_id}` through `notion_api_read` lists its
  `data_sources`, usually one. `integration_search` returns data sources
  directly and skips that step.
- `integration_get_data_source_schema` and `integration_query_data_source`
  take the **data_source_id**, and `integration_create_page` takes it as
  `parent_data_source_id` when adding a row.

So the sequence for "find rows in this database" is the database read, then
`integration_get_data_source_schema`, then `integration_query_data_source`.

## Reading

- `integration_get_page` returns properties. To read or summarize a whole
  body, prefer `notion_api_read` `GET /v1/pages/{page_id}/markdown`: one
  request returns every nested level as Markdown (headings, lists, to-dos,
  toggles, tables, code, links, mentions, equations). A huge page comes back
  with `truncated: true` and the unread blocks in `unknown_block_ids`; read
  each id as a `page_id` on the same path.
- `integration_get_page_content` returns the body as flat blocks with ids,
  for quoting a block or appending after one. Nested blocks (toggles, list
  children, table rows) need `depth`, and each level multiplies requests. A
  deep read stops at an internal ceiling and reports `truncated: true` rather
  than spending the whole rate-limit budget.
- Notion truncates `title`, `rich_text`, `relation`, and `people` at 25
  entries. `integration_get_page` reports each in `truncated_properties` as
  `{ name, id }`; read the complete value with `notion_api_read`
  `GET /v1/pages/{page_id}/properties/{property_id}` and follow its cursor.
- Every named read projects Notion's payload to ids, plain text, and
  flattened property values. Pass `raw: true` for the full response, with
  the same value-safety redaction, when a specific field is missing. It is
  much larger. Narrow
  `integration_query_data_source` and `integration_get_page` with `properties`
  when the goal is fewer fields. This also narrows the request to Notion with
  repeated `filter_properties` URL parameters, shrinking the response before
  Connecta reads it. The title property is always fetched so the projected
  `title` stays populated. Page retrieval allows at most 100 distinct filters,
  including the title id. A larger selection fetches all properties and still
  projects only the selected names locally. Data source queries have no
  documented filter count limit. `raw: true` returns the upstream response,
  filtered when those filters fit and full when page retrieval falls back.
  Omit `properties` for the full response on either tool.
  `integration_get_page_content` with `raw: true` returns one level and ignores
  `depth`.

## Writing content

`integration_append_blocks` adds children and nothing else. It cannot move,
reorder, or replace an existing block, and a block appended through the API can
never be relocated by it afterwards. Get the position right the first time with
`position` and `after_block_id`. Notion caps one call at 100 blocks. Text
longer than Notion's 2,000-character run limit is split into runs for you.

For formatted content, write Markdown to a page with `notion_api_write`
`PATCH /v1/pages/{page_id}/markdown`. Append with
`{"type":"insert_content","insert_content":{"content":"## Notes\n- one","position":{"type":"end"}}}`
(`start` prepends). Edit text in place with `update_content`, whose
`content_updates` are `{ old_str, new_str }` pairs copied exactly from the
page's Markdown, and `replace_content` swaps the whole page for `new_str`.
Notion refuses an edit that would delete a child page or database with a
`validation_error` naming them. Removing ordinary text needs no flag; to delete
those children, set `allow_deleting_content: true` inside the command body
(`{"type":"update_content","update_content":{"content_updates":[…],"allow_deleting_content":true}}`),
and leave it out unless the task is to delete them. `integration_create_page`
takes the same Markdown for a new page's body.

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
- A data source query stops at 10,000 rows. `integration_query_data_source`
  then returns `incomplete: true`, and a generic query `page.hasMore` without
  `page.next`: narrow the filter rather than trusting the count.
- Cursors are opaque: never parse or construct one. Follow pages inside
  `execute_code` and reduce there.

## Failures worth reading carefully

- **404** means "no such object" *or* "not shared with this integration", and
  Notion will not say which. Never conclude a page was deleted from it; check
  that the page is shared with the integration in Notion.
- **403** is not an expired token. The integration is missing a capability
  (comment capabilities are off by default), the object was never shared, or
  the workspace is past its plan's block limit; Notion's message says which.
  Re-authorizing cannot fix it; an operator must change it in Notion.
- **429** carries a retry window. Notion's [request limits](https://developers.notion.com/reference/request-limits)
  allow 600 requests a minute per connection on Business and Enterprise and
  180 on other plans, plus a workspace-wide limit shared by all connections.
  Connecta defaults to 180 calls a minute, three at a time, per runtime.
  A token connector's optional `callAdmission` replaces that whole policy;
  account for other runtime traffic and tools that make multiple HTTP requests.
  Wait out the window rather than retrying immediately. A 429 that says the
  integration's API access is blocked is not retryable.
- **5xx on a write** may still have been saved. When Notion names the
  object it committed, the failure says so: read that object instead of
  repeating the write. Otherwise check the target before trying again.
<!-- endfragment -->

<!-- fragment: shared -->

## Notion's data model

- A database is a container; its rows and schema live in a *data source*
  inside it. Queries, schema reads, and new rows take the data source, and
  Notion rejects a database id in its place.
- Property names in filters, sorts, and writes must match the schema exactly,
  including case. Read the schema before composing one.
- A `status` write must use an existing option name; inventing one fails.
  A new `select` or `multi_select` name does not fail: when the connection
  can write to the data source, Notion adds it to the schema as a new
  option. Use the options the schema lists unless a schema change is meant.
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
