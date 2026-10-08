---
{
  "name": "sheets",
  "instructionsHeading": "Connection instructions"
}
---

<!-- fragment: guide_0 -->
# Google Sheets usage

Acts as the signed-in person in their own Google Sheets through Workspace delegation: it reaches only spreadsheets they can open, starting from an id.

Connection purpose: <!-- endfragment -->

<!-- fragment: guide_1 -->


## Whose spreadsheets

Every call acts as the Workspace account deployment config maps the caller
to. No argument names an account. A call with none mapped fails
`auth_required`; only an operator can change the mapping. An id that is
unknown or not shared with this person fails the same way — Google does not
say which.

## Finding a spreadsheet

- Sheets cannot list or search files. Find one by name with a Google Drive
  search, or take the id from its URL (between `/d/` and `/edit`).
- `get_spreadsheet` first: sheet titles, ids, grid sizes, and named ranges,
  so ranges are named right rather than guessed.

## Ranges

- A1 notation. Quote a sheet title with spaces or punctuation:
  `'Q3 Budget'!A1:D20`, doubling any `'` inside it. A bare title is the
  whole sheet; `Sheet1!B:B` a whole column; a named range works by name.
- `get_values` pages by whole rows under `maxCells` and `maxBytes`:
  page with `page.nextCursor` and the same spreadsheetId, ranges, and
  render options. A range with explicit rows (`A1:D500`, `B:D`) resumes
  where it stopped; a sheet title or named range is re-read and its earlier
  rows skipped, so `rowOffset` says how far into Google's echoed range the
  page starts.
- A row too wide or too large for one page is refused, not cut: narrow the
  columns or lower `maxCellChars`. The default `maxBytes` is what
  `execute_code` can receive; raise it only for a direct `call_tool`
  read.
- A cell over <!-- endfragment -->

<!-- fragment: guide_2 -->
 characters ends with a truncation marker;
  read it alone with `maxCellChars` for the rest. Reduce inside
  `execute_code` before returning a large read.

## Writing

- `valueInputOption` is required: `RAW` stores text as given;
  `USER_ENTERED` parses it as typed, so a leading `=` makes a formula. Use
  RAW for data from outside the spreadsheet.
- In written rows, `null` leaves a cell as it was and `""` empties it.
- `append_values` inserts rows below the table and overwrites nothing;
  `update_values` and `batch_update_values` overwrite the cells they
  cover; `clear_values` empties values but keeps formatting.
- `batch_update_spreadsheet` takes Google's own Request objects for
  everything else (formatting, sorting, deleting rows or sheets); it is
  atomic, always needs approval, and can destroy data. Replies too large
  to return come back cut to their kind, ids, and counts with a `note`;
  the requests still applied, so never send them again to see the rest.
- Sheets has no revision check on writes: edits are last-writer-wins, so a
  person editing the same cells meanwhile is overwritten without warning.
  Read just before writing over anything a person may be editing.
- Moving, sharing, or deleting a spreadsheet file is Drive's job.
<!-- endfragment -->
