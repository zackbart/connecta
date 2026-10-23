// The seven Sheets methods the legacy tools send. Request paths and query
// order are kept by the shared Google adapter; these declarations own the
// manifest and the closed value-safety resolver.
import { Schema } from "effect";
import { get, post, vendor } from "../../http/vendor.js";
import { googleErrors, googleSafety, type GoogleProduct } from "../_shared/google/kit.js";
import { SHEETS_SCOPES } from "./lib/constants.js";

export const SHEETS: GoogleProduct = {
  provider: "Google Sheets",
  api: "Google Sheets API",
  scopes: SHEETS_SCOPES,
  // A Drive file can be absent or simply not shared with this user.
  notFound: "ambiguous",
};

const SpreadsheetId = { spreadsheetId: Schema.String };
const optionalString = Schema.optionalKey(Schema.String);

export const getSpreadsheet = get("getSpreadsheet", "/spreadsheets/:spreadsheetId", {
  params: SpreadsheetId,
  query: { includeGridData: optionalString, fields: optionalString },
  success: Schema.Unknown,
});

const OPERATIONS = [
  getSpreadsheet,
  post("createSpreadsheet", "/spreadsheets", {
    query: { fields: optionalString },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchUpdate", "/spreadsheets/:spreadsheetId:batchUpdate", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("batchGetValues", "/spreadsheets/:spreadsheetId/values:batchGet", {
    params: SpreadsheetId,
    query: {
      ranges: Schema.Array(Schema.String),
      majorDimension: optionalString,
      valueRenderOption: optionalString,
      dateTimeRenderOption: optionalString,
    },
    success: Schema.Unknown,
  }),
  post("batchUpdateValues", "/spreadsheets/:spreadsheetId/values:batchUpdate", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchClearValues", "/spreadsheets/:spreadsheetId/values:batchClear", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("appendValues", "/spreadsheets/:spreadsheetId/values/:range:append", {
    params: { ...SpreadsheetId, range: Schema.String },
    query: {
      valueInputOption: Schema.String,
      insertDataOption: Schema.String,
      includeValuesInResponse: optionalString,
    },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

// These exact public wire names are structural inputs to the projections in
// tools.ts. A private value equal to a name must not erase that member before
// projection. Values, unknown keys and partial key matches remain redacted.
export const SheetsApi = {
  ...vendor({ name: "Google Sheets", manifestBase: "/v4" }, ...OPERATIONS),
  fixedKeys: {
    spreadsheetId: "Public spreadsheet identifier member read by every result projection.",
    spreadsheetUrl: "Public spreadsheet URL member copied by metadata and create projections.",
    properties: "Public spreadsheet and sheet property envelope navigated by metadata and create projections.",
    title: "Public spreadsheet and tab title member read inside the properties envelope.",
    locale: "Public spreadsheet locale member copied by the metadata projection.",
    timeZone: "Public spreadsheet time-zone member copied by the metadata projection.",
    sheets: "Public sheet array traversed by metadata and create projections.",
    sheetId: "Public numeric tab identifier read by sheet and named-range projections.",
    index: "Public tab position read by the sheet projection.",
    sheetType: "Public tab type member renamed by the sheet projection.",
    hidden: "Public tab visibility member read by the sheet projection.",
    gridProperties: "Public grid property envelope navigated by the sheet projection.",
    rowCount: "Public grid row count read by the sheet projection.",
    columnCount: "Public grid column count read by the sheet projection.",
    frozenRowCount: "Public frozen-row count read by the sheet projection.",
    frozenColumnCount: "Public frozen-column count read by the sheet projection.",
    namedRanges: "Public named-range array traversed by the metadata projection.",
    namedRangeId: "Public named-range identifier copied by the metadata projection.",
    name: "Public named-range name read by the metadata projection.",
    range: "Public GridRange envelope and returned A1 range member navigated by metadata and values projections.",
    startRowIndex: "Public GridRange start-row member converted to A1 notation.",
    startColumnIndex: "Public GridRange start-column member converted to A1 notation.",
    endRowIndex: "Public GridRange end-row member converted to A1 notation.",
    endColumnIndex: "Public GridRange end-column member converted to A1 notation.",
    valueRanges: "Public batchGet result array traversed by the cell-page projection.",
    values: "Public cell-row array traversed by the cell-page projection.",
    responses: "Public batchUpdate-values response array traversed by value-write projections.",
    updatedRange: "Public updated A1 range member copied by value-write projections.",
    updatedRows: "Public updated-row count read by value-write projections.",
    updatedColumns: "Public updated-column count read by value-write projections.",
    updatedCells: "Public updated-cell count read by value-write projections.",
    totalUpdatedRows: "Public batch updated-row total read by the batch values projection.",
    totalUpdatedColumns: "Public batch updated-column total read by the batch values projection.",
    totalUpdatedCells: "Public batch updated-cell total read by the batch values projection.",
    totalUpdatedSheets: "Public batch updated-sheet total read by the batch values projection.",
    tableRange: "Public detected table range member copied by the append projection.",
    updates: "Public append update envelope navigated by the append projection.",
    clearedRanges: "Public cleared-range array read by the clear-values projection.",
    replies: "Public batchUpdate reply array traversed by add-sheet and raw-batch projections.",
    addSheet: "Public add-sheet reply envelope navigated to read the new tab's properties.",
  },
};
export const errors = googleErrors(SHEETS);
export const safety = googleSafety(SHEETS.provider, OPERATIONS);

// Delegation has no operator credential slot to probe. Never run.
export const probe = {
  operation: getSpreadsheet,
  request: { params: { spreadsheetId: "-" } },
  describe: () => "Google Sheets delegation has no credential to test.",
};
