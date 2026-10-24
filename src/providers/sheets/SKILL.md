---
{
  "name": "sheets",
  "instructionsHeading": "Connection instructions"
}
---

## Find the workbook and resolve ranges

Sheets starts from a spreadsheet id. A spreadsheet id the person gives works
as is; search Drive only for a name. The Drive file id is
the spreadsheet id. Moving, sharing and trashing the file also belong to Drive.
Read `get_spreadsheet` first to resolve sheet titles, numeric sheet ids and named
ranges before writing. Sheet id zero is valid; a tab's position is not its id.

A1 ranges use sheet titles; structural GridRanges use numeric sheet ids with
zero-based, end-exclusive row and column indexes. Quote titles containing
spaces or punctuation and double apostrophes: `'Alice''s costs'!A1:D7`.
A bare title may resolve to a named range; quote it to address the whole tab.

## Read cell meaning

Displayed values reflect spreadsheet locale and number formats. Use
unformatted numbers for arithmetic and formulas when inspecting expressions.
Date serials count days from 1899-12-30; interpret dates using the workbook's
time zone. Trailing empty rows and cells may be absent. An empty range is a
valid result, not proof that the sheet is missing.

Whole-row content reads can resume partway through a range. A named range or
whole-sheet reference may be re-read and earlier rows skipped; rowOffset is
relative to Google's echoed range. Reduce amounts inside execute_code before
returning them. Read an oversized cell separately to recover its full text.

## Edit and reconcile

Use RAW for external data; USER_ENTERED can turn leading equals signs into
formulas. In cell writes, null leaves a cell unchanged and an empty string
clears it. Clearing preserves formatting and validation. `append_values` is
pinned to INSERT_ROWS and inserts rows after the detected table. A vendor append using
OVERWRITE can replace existing cells below that table.

Read just before replacing another person's cells. Sheets has no revision
precondition or replay key: concurrent edits can be overwritten. After an
uncertain append, read the target table and identify the row before adding
anything missing. After an uncertain workbook create, search Drive by title
before creating another workbook.

Structural batches apply atomically, but can delete rows, sheets or
protections. An oversized reply may be summarized after the edit saved;
inspect the workbook to recover details. Preview comment mutations and
external data-source configuration, refresh and administration are outside
this connection. Developer-metadata searches and data-filter reads are
read-only even though their wire method is POST.
