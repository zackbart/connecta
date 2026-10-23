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

export const SheetsApi = vendor({ name: "Google Sheets", manifestBase: "/v4" }, ...OPERATIONS);
export const errors = googleErrors(SHEETS);
export const safety = googleSafety(SHEETS.provider, OPERATIONS);

// Delegation has no operator credential slot to probe. Never run.
export const probe = {
  operation: getSpreadsheet,
  request: { params: { spreadsheetId: "-" } },
  describe: () => "Google Sheets delegation has no credential to test.",
};
