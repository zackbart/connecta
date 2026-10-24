import { sheets } from "../../../src/providers/sheets/index.js";
import { defineGoldenSpec } from "../harness.js";

import { PRIVATE_KEY } from "../rsa-fixture.js";

const ACCESS_TOKEN = "golden-sheets-access-token/123+456=";

const ID = "sheet-budget-1";

const SPREADSHEET = {
  spreadsheetId: ID,
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
  properties: { title: "2026 Budget", locale: "en_US", timeZone: "America/Chicago" },
  sheets: [
    // The first sheet's id and index are 0, which Google leaves out.
    {
      properties: {
        title: "Summary",
        sheetType: "GRID",
        gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 },
      },
    },
    {
      properties: {
        sheetId: 7,
        title: "Q3 Budget",
        index: 1,
        sheetType: "GRID",
        hidden: true,
        gridProperties: { rowCount: 500, columnCount: 8 },
      },
    },
  ],
  namedRanges: [
    { namedRangeId: "n1", name: "Totals", range: { endRowIndex: 5, endColumnIndex: 3 } },
    {
      namedRangeId: "n2",
      name: "Spend",
      range: { sheetId: 7, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 4 },
    },
  ],
};

const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => [`r${from + index}`, from + index]);

export default defineGoldenSpec({
  provider: "sheets",
  // Delegated tokens are cached per service account for the process, so each
  // scenario names its own account and mints its own token.
  create: (scenario) =>
    sheets("sheets", {
      purpose: "Finance and attendance spreadsheets",
      serviceAccount: {
        clientEmail: `sheets-${scenario}@project.iam.gserviceaccount.com`,
        privateKey: PRIVATE_KEY,
      },
      subject: "alice@example.com",
    }),
  secrets: { privateKey: PRIVATE_KEY, accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === "https://oauth2.googleapis.com/token",
      reply: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } },
    },
  ],
  failureReply: (status, message) => ({
    status,
    body: { error: { code: status, message, status: "GOLDEN_FAILURE" } },
  }),
  calls: [
    { tool: "sheets_api_search", args: { query: "read cell formulas" }, replies: [] },
    {
      tool: "sheets_api_details",
      args: { method: "POST", path: "/spreadsheets/{spreadsheetId}:batchUpdate" },
      replies: [],
    },
    {
      tool: "sheets_api_read",
      args: { method: "GET", path: `/spreadsheets/${ID}/values/Sheet1!A1%3AD7`, fields: ["values"] },
      replies: [{ body: { range: "Sheet1!A1:D7", majorDimension: "ROWS", values: [["literal", 3]] } }],
    },
    {
      label: "sheets_api_read metadata search POST",
      tool: "sheets_api_read",
      args: {
        method: "POST",
        path: `/spreadsheets/${ID}/developerMetadata:search`,
        body: { dataFilters: [{ developerMetadataLookup: { metadataKey: "review" } }] },
      },
      replies: [
        {
          body: {
            matchedDeveloperMetadata: [
              { developerMetadata: { metadataId: 9, metadataKey: "review", metadataValue: "checked" } },
            ],
          },
        },
      ],
    },
    {
      tool: "sheets_api_write",
      args: {
        method: "PUT",
        path: `/spreadsheets/${ID}/values/Sheet1!A1%3AB1`,
        query: { valueInputOption: "RAW" },
        body: { values: [["literal", null]] },
      },
      replies: [{ body: { spreadsheetId: ID, updatedRange: "Sheet1!A1:B1", updatedCells: 1 } }],
    },

    { tool: "get_spreadsheet", args: { spreadsheetId: ID }, replies: [{ body: SPREADSHEET }] },
    {
      tool: "get_values",
      args: {
        spreadsheetId: ID,
        ranges: ["Summary!A1:C3", "'Q3 Budget'!B:B"],
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "FORMATTED_STRING",
      },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            valueRanges: [
              { range: "Summary!A1:C3", majorDimension: "ROWS", values: [["Item", "Q3"], ["Rent", 1200], []] },
              { range: "'Q3 Budget'!B1:B1000", majorDimension: "ROWS" },
            ],
          },
        },
      ],
    },
    {
      label: "get_values paged by maxCells",
      tool: "get_values",
      args: { spreadsheetId: ID, ranges: ["Data!A1:B10", "Other!A1:A2"], maxCells: 6 },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            valueRanges: [
              { range: "Data!A1:B10", values: rows(1, 10) },
              { range: "Other!A1:A2", values: [["x"], ["y"]] },
            ],
          },
        },
      ],
    },
    {
      tool: "update_values",
      args: {
        spreadsheetId: ID,
        range: "Summary!A1",
        values: [
          ["Item", "=SUM(B2:B9)"],
          [null, ""],
        ],
        valueInputOption: "USER_ENTERED",
      },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            totalUpdatedCells: 4,
            responses: [
              { spreadsheetId: ID, updatedRange: "Summary!A1:B2", updatedRows: 2, updatedColumns: 2, updatedCells: 4 },
            ],
          },
        },
      ],
    },
    {
      tool: "batch_update_values",
      args: {
        spreadsheetId: ID,
        valueInputOption: "RAW",
        data: [
          { range: "A!A1", values: [[1, true]] },
          { range: "B!A1", values: [["x"], ["y"]] },
        ],
      },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            totalUpdatedRows: 3,
            totalUpdatedColumns: 2,
            totalUpdatedCells: 4,
            totalUpdatedSheets: 2,
            responses: [
              { updatedRange: "A!A1:B1", updatedRows: 1, updatedColumns: 2, updatedCells: 2 },
              { updatedRange: "B!A1:A2", updatedRows: 2, updatedColumns: 1, updatedCells: 2 },
            ],
          },
        },
      ],
    },
    {
      tool: "append_values",
      args: {
        spreadsheetId: ID,
        range: "'Q3 Budget'!A:D",
        values: [["2026-10-06", "Rent", 1200, "paid"]],
        valueInputOption: "USER_ENTERED",
      },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            tableRange: "'Q3 Budget'!A1:D20",
            updates: {
              spreadsheetId: ID,
              updatedRange: "'Q3 Budget'!A21:D21",
              updatedRows: 1,
              updatedColumns: 4,
              updatedCells: 4,
            },
          },
        },
      ],
    },
    {
      tool: "clear_values",
      args: { spreadsheetId: ID, ranges: ["A!A1:B9", "B!C:C"] },
      replies: [{ body: { spreadsheetId: ID, clearedRanges: ["A!A1:B9", "B!C1:C1000"] } }],
    },
    {
      tool: "create_spreadsheet",
      args: { title: "Attendance 2026", sheetTitles: ["Sundays", "Midweek"] },
      replies: [
        {
          body: {
            spreadsheetId: "new-1",
            spreadsheetUrl: "https://docs.google.com/spreadsheets/d/new-1/edit",
            properties: { title: "Attendance 2026" },
            sheets: [{ properties: { title: "Sundays" } }, { properties: { sheetId: 42, title: "Midweek" } }],
          },
        },
      ],
    },
    {
      tool: "add_sheet",
      args: { spreadsheetId: ID, title: "Q4", index: 2, rowCount: 100, columnCount: 6 },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            replies: [
              {
                addSheet: {
                  properties: {
                    sheetId: 99,
                    title: "Q4",
                    index: 2,
                    sheetType: "GRID",
                    gridProperties: { rowCount: 100, columnCount: 6 },
                  },
                },
              },
            ],
          },
        },
      ],
    },
    {
      tool: "batch_update_spreadsheet",
      args: {
        spreadsheetId: ID,
        requests: [
          { deleteDimension: { range: { sheetId: 7, dimension: "ROWS", startIndex: 3, endIndex: 9 } } },
          { duplicateSheet: { sourceSheetId: 0, newSheetName: "Copy of Summary" } },
        ],
      },
      replies: [
        {
          body: {
            spreadsheetId: ID,
            replies: [{}, { duplicateSheet: { properties: { sheetId: 101, title: "Copy of Summary", index: 2 } } }],
          },
        },
      ],
    },
  ],
  unsent: ["privateKey"],
  // Google redacts a vendor message whole before cutting it to 500 characters.
  errorEcho: "all",
  echo: {
    tool: "get_spreadsheet",
    args: { spreadsheetId: ID },
    replies: (text) => [{ body: { ...SPREADSHEET, properties: { ...SPREADSHEET.properties, title: text } } }],
  },
  failures: {
    read: { tool: "get_spreadsheet", args: { spreadsheetId: ID } },
    write: {
      tool: "update_values",
      args: { spreadsheetId: ID, range: "Summary!A1", values: [["Item", 1200]], valueInputOption: "RAW" },
    },
  },
});
