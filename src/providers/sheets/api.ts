// The complete reviewed 17-method Sheets inventory; hatches validate against the frozen index.
import { Schema } from "effect";
import { get, post, put, vendor } from "../../http/vendor.js";
import { googleErrors, type GoogleProduct } from "../_shared/google/kit.js";
import { valueSafety } from "../_shared/rest/value-safety.js";
import { sheetsIndex } from "./lib/hatch.js";
import { SHEETS_VALUE_SAFETY } from "./safety.js";
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
  get("getValues", "/spreadsheets/:spreadsheetId/values/:range", {
    params: { ...SpreadsheetId, range: Schema.String },
    success: Schema.Unknown,
  }),
  put("updateValues", "/spreadsheets/:spreadsheetId/values/:range", {
    params: { ...SpreadsheetId, range: Schema.String },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("clearValues", "/spreadsheets/:spreadsheetId/values/:range:clear", {
    params: { ...SpreadsheetId, range: Schema.String },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  get("getDeveloperMetadata", "/spreadsheets/:spreadsheetId/developerMetadata/:metadataId", {
    params: { ...SpreadsheetId, metadataId: Schema.String },
    success: Schema.Unknown,
  }),
  post("searchDeveloperMetadata", "/spreadsheets/:spreadsheetId/developerMetadata:search", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("getByDataFilter", "/spreadsheets/:spreadsheetId:getByDataFilter", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchGetByDataFilter", "/spreadsheets/:spreadsheetId/values:batchGetByDataFilter", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchClearByDataFilter", "/spreadsheets/:spreadsheetId/values:batchClearByDataFilter", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("batchUpdateByDataFilter", "/spreadsheets/:spreadsheetId/values:batchUpdateByDataFilter", {
    params: SpreadsheetId,
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
  post("copySheet", "/spreadsheets/:spreadsheetId/sheets/:sheetId:copyTo", {
    params: { ...SpreadsheetId, sheetId: Schema.String },
    payload: Schema.Unknown,
    success: Schema.Unknown,
  }),
] as const;

export const SheetsApi = vendor({ name: "Google Sheets", manifestBase: "/v4" }, ...OPERATIONS);
export const errors = googleErrors(SHEETS, { standard: true });
const values = valueSafety(SHEETS_VALUE_SAFETY, () => sheetsIndex);
export const safety = {
  reviewed: {
    resolve: (method: string, path: string) => {
      const op = sheetsIndex.resolve(method, path).op;
      return { method: op.method, template: op.path };
    },
    redact: (data: unknown, op: { method: string; template: string }) => values.redact(data, op.method, op.template),
    withholdsErrors: (op: { method: string; template: string }) =>
      values.withholdsErrors(
        sheetsIndex.ops.find((entry) => entry.method === op.method && entry.path === op.template)!,
      ),
  },
  sensitiveFields: { names: [], choice: "drop" },
} as const;

// Delegation has no operator credential slot to probe. Never run.
export const probe = {
  operation: getSpreadsheet,
  request: { params: { spreadsheetId: "-" } },
  describe: () => "Google Sheets delegation has no credential to test.",
};
