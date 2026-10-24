import { Schema } from "effect";
import { Integer, isMinChars, isMaxChars } from "../../../http/json-schema.js";
const optional = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.Struct(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, Schema.optionalKey(value)])));
const str = (description: string, max: number, pattern?: RegExp) =>
  Schema.String.check(
    isMinChars(1),
    isMaxChars(max),
    ...(pattern
      ? [
          Schema.makeFilter((value: string) => pattern.test(value), {
            expected: `matching ${pattern.source}`,
            toJsonSchema: () => ({ pattern: pattern.source }),
          }),
        ]
      : []),
  ).annotate({ description });
const int = (description: string, min: number, max: number) =>
  Integer.check(Schema.isGreaterThanOrEqualTo(min), Schema.isLessThanOrEqualTo(max)).annotate({ description });
const id = str("Spreadsheet id from its Drive file URL; find by name through Drive.", 256, /^[A-Za-z0-9_-]+$/);
const range = str(
  "A1 range or named range; quote sheet titles and double internal apostrophes.",
  512,
  /^[^\r\n]*[^.\r\n][^\r\n]*$/,
);
const ranges = Schema.Array(range).check(Schema.isMinLength(1), Schema.isMaxLength(20));
const cell = Schema.Union([Schema.String.check(isMaxChars(50000)), Schema.Finite, Schema.Boolean, Schema.Null]);
const rows = Schema.Array(Schema.Array(cell).check(Schema.isMaxLength(18278)))
  .check(Schema.isMinLength(1), Schema.isMaxLength(10000))
  .annotate({
    description: "Rows of scalar cells, at most 50000 cells total. null skips a cell; empty string clears it.",
  });
const mode = Schema.Literals(["RAW", "USER_ENTERED"]).annotate({
  description: "RAW stores literals; USER_ENTERED parses formulas, dates and numbers as typed.",
});
const title = (max: number) => str("Title on one line.", max, /^[^\r\n]*$/);
const sheetFields = {
  sheetId: Integer,
  title: Schema.String,
  index: Integer,
  type: Schema.String,
  hidden: Schema.Boolean,
  rowCount: Integer,
  columnCount: Integer,
  frozenRowCount: Integer,
  frozenColumnCount: Integer,
};
const updateFields = {
  updatedRange: Schema.String,
  updatedRows: Integer,
  updatedColumns: Integer,
  updatedCells: Integer,
};
const cuts = { truncated: Schema.Array(Schema.String) };
const AnyObject = Schema.Record(Schema.String, Schema.Unknown);
export const inputs = {
  get_spreadsheet: Schema.Struct({ spreadsheetId: id }),
  get_values: Schema.Struct({
    spreadsheetId: id,
    ranges,
    valueRenderOption: Schema.optionalKey(Schema.Literals(["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"])),
    dateTimeRenderOption: Schema.optionalKey(Schema.Literals(["SERIAL_NUMBER", "FORMATTED_STRING"])),
    maxCells: Schema.optionalKey(int("Whole-row content budget; defaults to 2000 cells.", 1, 10000)),
    maxBytes: Schema.optionalKey(
      int("Whole-page JSON byte budget; defaults to 192 KiB. Above that use a direct call.", 1024, 4194304),
    ),
    maxCellChars: Schema.optionalKey(
      int("Characters kept per cell; defaults to 5000. Read a cut cell alone with up to 50000.", 1, 50000),
    ),
    cursor: Schema.optionalKey(
      str("Opaque page.nextCursor; keep spreadsheet, ranges and render options unchanged.", 1024),
    ),
  }),
  update_values: Schema.Struct({ spreadsheetId: id, range, values: rows, valueInputOption: mode }),
  batch_update_values: Schema.Struct({
    spreadsheetId: id,
    data: Schema.Array(Schema.Struct({ range, values: rows })).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    valueInputOption: mode,
  }),
  append_values: Schema.Struct({ spreadsheetId: id, range, values: rows, valueInputOption: mode }),
  clear_values: Schema.Struct({ spreadsheetId: id, ranges }),
  create_spreadsheet: Schema.Struct({
    title: title(255),
    sheetTitles: Schema.optionalKey(
      Schema.Array(title(100)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(50),
        Schema.makeFilter((values) => new Set(values).size === values.length, {
          expected: "unique sheet titles",
          toJsonSchema: () => ({ uniqueItems: true }),
        }),
      ),
    ),
  }),
  add_sheet: Schema.Struct({
    spreadsheetId: id,
    title: title(100),
    index: Schema.optionalKey(int("Zero-based tab position; omit for last.", 0, 1000)),
    rowCount: Schema.optionalKey(int("Grid rows.", 1, 1000000)),
    columnCount: Schema.optionalKey(int("Grid columns.", 1, 18278)),
  }),
  batch_update_spreadsheet: Schema.Struct({
    spreadsheetId: id,
    requests: Schema.Array(
      Schema.Record(Schema.String, AnyObject)
        .annotate({
          description: "One reviewed Sheets Request kind and its object body; details provides nested contracts.",
        })
        .check(
          Schema.makeFilter((value) => Object.keys(value).length === 1, {
            expected: "exactly one reviewed Sheets request kind",
            toJsonSchema: () => ({ minProperties: 1, maxProperties: 1 }),
          }),
        ),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
};
export const outputs = {
  get_spreadsheet: optional({
    spreadsheetId: Schema.String,
    title: Schema.String,
    url: Schema.String,
    locale: Schema.String,
    timeZone: Schema.String,
    sheets: Schema.Array(optional(sheetFields)),
    namedRanges: Schema.Array(
      optional({ namedRangeId: Schema.String, name: Schema.String, sheetId: Integer, range: Schema.String }),
    ),
    ...cuts,
  }),
  get_values: optional({
    spreadsheetId: Schema.String,
    valueRanges: Schema.Array(
      optional({
        range: Schema.String,
        values: Schema.Array(Schema.Array(cell)),
        rowOffset: Integer,
        rowCount: Integer,
      }),
    ),
    cellCount: Integer,
    page: Schema.Struct({ hasMore: Schema.Boolean, nextCursor: Schema.optionalKey(Schema.String) }),
    ...cuts,
  }),
  update_values: optional({ spreadsheetId: Schema.String, ...updateFields }),
  batch_update_values: optional({
    spreadsheetId: Schema.String,
    totalUpdatedRows: Integer,
    totalUpdatedColumns: Integer,
    totalUpdatedCells: Integer,
    totalUpdatedSheets: Integer,
    updates: Schema.Array(optional(updateFields)),
  }),
  append_values: optional({ spreadsheetId: Schema.String, tableRange: Schema.String, ...updateFields }),
  clear_values: optional({ spreadsheetId: Schema.String, clearedRanges: Schema.Array(Schema.String) }),
  create_spreadsheet: optional({
    spreadsheetId: Schema.String,
    title: Schema.String,
    url: Schema.String,
    sheets: Schema.Array(optional({ sheetId: Integer, title: Schema.String })),
  }),
  add_sheet: optional({ spreadsheetId: Schema.String, ...sheetFields }),
  batch_update_spreadsheet: optional({
    spreadsheetId: Schema.String,
    replies: Schema.Array(AnyObject),
    note: Schema.String,
    ...cuts,
  }),
};
