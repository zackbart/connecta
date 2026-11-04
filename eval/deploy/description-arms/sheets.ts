import { hatchDiscovery, type ProviderTable } from "./types.js";

const READ_RULES =
  "Paths are relative to /v4. fields narrows response data; query.fields is Google's vendor mask. Values have no vendor page token.";
const WRITE_RULES =
  "Batch updates need 1–100 requests, exactly one reviewed kind each. Preview comments and external data-source configuration are refused. Hatch append may explicitly choose OVERWRITE and destroy existing cells. No revision guarantee or idempotency key.";
const SHEET = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const RANGE_PROPERTY = "A1 ranges to read; quote sheet titles and double internal apostrophes.";

export const SHEETS: ProviderTable = {
  tools: {
    get_spreadsheet: {
      terse:
        "Get a spreadsheet's title, sheets and named ranges, never cell values. To find one by name, search Drive.",
      disambiguation:
        "Resolve sheet ids, titles and named ranges, never cell values; get_values reads cells. To find a spreadsheet by name, search Drive.",
      example: `Get a spreadsheet's title, sheets and named ranges, never cell values. To find one by name, search Drive. Example: {"spreadsheetId":"${SHEET}"}.`,
    },
    get_values: {
      terse: "Read cell values from A1 ranges as rows, paged by cell count. Long cells are cut with a marker.",
      disambiguation:
        "Read cell values from A1 ranges as rows, paged by cell count; get_spreadsheet resolves titles. Long cells are cut with a marker.",
      example: `Read cell values as rows, paged by cell count; long cells are cut with a marker. Example: {"spreadsheetId":"${SHEET}","ranges":["'Alice''s costs'!A1:D7"],"valueRenderOption":"UNFORMATTED_VALUE"}.`,
      properties: { disambiguation: { ranges: RANGE_PROPERTY } },
    },
    update_values: {
      terse: "Write rows into one A1 range, overwriting what is there; use append_values below a table.",
      disambiguation:
        "Replace cells in one A1 range, overwriting what is there; to add rows below a table use append_values.",
      example: `Write rows into one A1 range, overwriting what is there; use append_values below a table. Example: {"spreadsheetId":"${SHEET}","range":"Sheet1!A2:B2","values":[["a",1]],"valueInputOption":"RAW"}.`,
    },
    batch_update_values: {
      terse: "Write values into several A1 ranges, overwriting each. All succeed or none do.",
      disambiguation:
        "Write values into several A1 ranges, overwriting each. All succeed or none do. For formatting or structure use batch_update_spreadsheet.",
      example: `Write values into several A1 ranges, overwriting each. All succeed or none do. Example: {"spreadsheetId":"${SHEET}","data":[{"range":"Sheet1!A2","values":[["a"]]}],"valueInputOption":"RAW"}.`,
    },
    append_values: {
      terse: "Append rows after a table, inserting rows so nothing below is overwritten.",
      disambiguation:
        "Add rows after a table, inserting rows so nothing below is overwritten; update_values replaces cells in place.",
      example: `Append rows after a table, inserting rows so nothing below is overwritten. Example: {"spreadsheetId":"${SHEET}","range":"Sheet1!A1:D1","values":[["a",1]],"valueInputOption":"RAW"}.`,
    },
    clear_values: {
      terse: "Clear values in A1 ranges, keeping formatting; the values are gone and nothing shifts.",
      disambiguation:
        "Clear values in A1 ranges, keeping formatting; the values are gone and nothing shifts. batch_update_spreadsheet deletes rows.",
      example: `Clear values in A1 ranges, keeping formatting; the values are gone and nothing shifts. Example: {"spreadsheetId":"${SHEET}","ranges":["Sheet1!A2:D9"]}.`,
    },
    create_spreadsheet: {
      terse: "Create a spreadsheet in My Drive root; it is not shared or moved.",
      disambiguation:
        "Create a spreadsheet in My Drive root; it is not shared or moved, which Drive does. add_sheet adds a tab.",
      example:
        'Create a spreadsheet in My Drive root; it is not shared or moved. Example: {"title":"Budget","sheetTitles":["Costs"]}.',
    },
    add_sheet: {
      terse: "Add an empty sheet tab. Fails if the title is taken.",
      disambiguation:
        "Add an empty tab to an existing spreadsheet. Fails if the title is taken; create_spreadsheet makes a new file.",
      example: `Add an empty sheet tab. Fails if the title is taken. Example: {"spreadsheetId":"${SHEET}","title":"Costs"}.`,
    },
    batch_update_spreadsheet: {
      terse: "Apply Sheets batchUpdate requests atomically; this structural workflow can destroy data.",
      disambiguation:
        "Change formatting, merges, sorts, protections or delete sheets and rows, applied atomically; this can destroy data. Values go through update_values.",
      example: `Apply Sheets batchUpdate requests atomically; this can destroy data. Example: {"spreadsheetId":"${SHEET}","requests":[{"repeatCell":{"range":{"sheetId":0,"startRowIndex":0,"endRowIndex":1},"cell":{"userEnteredFormat":{"textFormat":{"bold":true}}},"fields":"userEnteredFormat.textFormat.bold"}}]}.`,
    },
    ...hatchDiscovery(
      "Google Sheets",
      '{"query":"protected ranges","method":"GET"}',
      '{"method":"GET","path":"/spreadsheets/{spreadsheetId}"}',
      "sheets",
    ),
    sheets_api_read: {
      terse: `Read a reviewed Google Sheets API operation, including read-only POST. ${READ_RULES}`,
      disambiguation: `Read conditional formats, protected ranges, data-filter and developer-metadata fields the named reads omit; use get_values for cell paging. ${READ_RULES}`,
      example: `Read a reviewed Google Sheets API operation, including read-only POST. Example: {"path":"/spreadsheets/${SHEET}","query":{"fields":"sheets.protectedRanges"}}. ${READ_RULES}`,
    },
    sheets_api_write: {
      terse: `Send a reviewed Google Sheets API write. ${WRITE_RULES}`,
      disambiguation: `Send a reviewed write no named tool covers; prefer append_values and update_values for cells. ${WRITE_RULES}`,
      example: `Send a reviewed Google Sheets API write. Example: {"method":"POST","path":"/spreadsheets/${SHEET}:batchUpdate","body":{"requests":[{"addSheet":{"properties":{"title":"Costs"}}}]}}. ${WRITE_RULES}`,
    },
  },
};
