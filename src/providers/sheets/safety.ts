import { safe, vendorErrors, type ValueSafetyTable } from "../_shared/rest/value-safety.js";
/** Cell values, user notes, formulas, metadata and ordinary links are requested content.
 * Sheets declares no vendor credential values; its errors may echo user content or sent secrets,
 * which the sent-secret boundary redacts before error mapping. */
export const SHEETS_VALUE_SAFETY = {
  title: "Google Sheets",
  embeddedUrls: {},
  operations: {
    "POST /spreadsheets": vendorErrors(
      safe("Created chart scorecard ranges describe user cells, not authentication keys.", [
        "sheets[].charts[].spec.scorecardChart.keyValueData",
      ]),
    ),
    "GET /spreadsheets/{spreadsheetId}": vendorErrors(
      safe("Chart scorecard ranges describe user cells, not authentication keys.", [
        "sheets[].charts[].spec.scorecardChart.keyValueData",
      ]),
    ),
    "POST /spreadsheets/{spreadsheetId}:getByDataFilter": vendorErrors(
      safe("Filter-selected chart scorecard ranges describe user cells, not authentication keys.", [
        "sheets[].charts[].spec.scorecardChart.keyValueData",
      ]),
    ),
    "POST /spreadsheets/{spreadsheetId}:batchUpdate": vendorErrors(
      safe("Expanded spreadsheet and chart replies contain cell-data ranges, not authentication keys.", [
        "replies[].addChart.chart.spec.scorecardChart.keyValueData",
        "updatedSpreadsheet.sheets[].charts[].spec.scorecardChart.keyValueData",
      ]),
    ),
    "POST /spreadsheets/{spreadsheetId}/developerMetadata:search": vendorErrors(
      safe(
        "Developer metadata search is a documented read-only lookup; keys and values are user-authored metadata, not credentials.",
      ),
    ),
  },
  fields: {
    keyValueData: { verdict: "keep", reason: "A scorecard chart's cell-data range, not an authentication key." },
  },
} as const satisfies ValueSafetyTable;
