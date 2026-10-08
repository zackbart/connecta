---
type: added
---

**Google Sheets connection** ([#682](https://github.com/zackbart/connecta/issues/682)).
`@zackbart/connecta/providers/sheets` exports `sheets(id, options)` with the
same Workspace options as `gmail()`, plus `SHEETS_SCOPES` and
`SHEETS_API_BASE_URL`. Nine hand-written tools: `get_spreadsheet` (title,
sheets with ids and grid sizes, named ranges as A1 with the sheet title
always quoted, never cell values; `raw: true` for Google's untouched
metadata) and `get_values` (one to twenty A1 ranges through
`values:batchGet`, value and date render options, paged by whole rows under
`maxCells` and `maxBytes` — never more, an oversized row is refused — with
the default byte budget sized to what `execute_code` can receive and at most
4 MiB for a direct `call_tool` read, which the result stash can still page,
and a cursor bound to the call's spreadsheet, ranges, and render options
that only ever continues the caller's own ranges; cells over 5,000 characters cut with a marker, and
`maxCellChars` up to 50,000 to read one whole) are read-only;
`create_spreadsheet`, `add_sheet`, and `append_values` (pinned to
`INSERT_ROWS`, so nothing below the table is overwritten) are additive
writes; `update_values`, `batch_update_values`, `clear_values`, and
`batch_update_spreadsheet` — Google's own `batchUpdate` requests, passed
through untouched and classified as a write, its replies cut to their kind,
ids, and counts when too large to deliver — are destructive. Writes take a
required `RAW` or `USER_ENTERED` and at most 50,000 cells per call. Value
updates and clears of fixed ranges are idempotent, so a 5xx stays
retryable; an append or create whose outcome is unknown says what to read
before repeating it — the table, or a Drive search for the title. A 404
never claims absence, since a spreadsheet is a Drive file that may simply not
be shared with the caller. Listing and finding spreadsheets is Drive's job.
The one scope, `https://www.googleapis.com/auth/spreadsheets`, and its setup
are documented on `sheets()`.

Trusted pools permit program writes; read-only pools use `call_destructive_tool`.
The MCP host controls approval.
