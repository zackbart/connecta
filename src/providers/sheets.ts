/**
 * Google Sheets as the signed-in Workspace user: read a spreadsheet's shape
 * and its values, write, append, and clear values, create spreadsheets and
 * sheets, and reach the rest of the editor through one approval-gated
 * `batchUpdate`. Hand-written against the Sheets API v4 reference
 * (https://developers.google.com/workspace/sheets/api/reference/rest).
 *
 * Whose spreadsheets. Access is a service account with domain-wide delegation
 * (`src/providers/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. There is no per-user consent step, no operator credential slot,
 * and no argument that names an account. Sheets has no `users/me` root to
 * confine paths beneath, so the token is the confinement: a spreadsheet id
 * reaches exactly what that user could open in the Sheets UI, and nothing
 * more.
 *
 * What it will not do. Finding a spreadsheet by name is Google Drive's job —
 * the Sheets API has no list method — so this connection starts from an id.
 * It never moves, shares, or trashes a file, which are Drive's too.
 *
 * The safety classes. Reads are read-only. Creating a spreadsheet, adding a
 * sheet, and appending rows lose nothing and are additive writes. Writing over
 * a range, clearing one, and the raw `batchUpdate` — whose requests can delete
 * sheets, rows, and protections — are destructive. Append is pinned to
 * `INSERT_ROWS`: Google's `OVERWRITE` writes over whatever sits below the
 * table, and a tool that could do that is not additive.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `scripts/drift/sheets-endpoints.json` records the seven methods the tools
 * call, and `npm run providers:check -- --provider sheets` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import type { Connector, JsonSchema } from "../types.js";
import {
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "./google/workspace.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "./google/workspace.js";

/**
 * The Sheets API root. Every path the tools send is beneath
 * `/spreadsheets`; the delegated token decides which ones the user can open.
 */
export const SHEETS_API_BASE_URL = "https://sheets.googleapis.com/v4";

/**
 * Exactly the scope this connection requests, and what the Admin console's
 * domain-wide delegation entry must add for it. One scope reads and writes
 * every spreadsheet the user can open; Google offers no narrower one that
 * writes.
 */
export const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"] as const;

/** Options for {@link sheets}: the shared Workspace delegation options. */
export type SheetsOptions = GoogleWorkspaceOptions;

/** Cells per page of get_values: connecta's cap, since Sheets has no paging. */
const DEFAULT_PAGE_CELLS = 2_000;
const MAX_PAGE_CELLS = 10_000;
/** A cell holds up to 50,000 characters; a read keeps this many of them. */
const MAX_CELL_CHARS = 5_000;
/** Ranges per read or clear. */
const MAX_RANGES = 20;
/** Ranges per batch_update_values. */
const MAX_DATA_RANGES = 100;
/** Rows and cells one write may carry: connecta's cap, under Google's 10 MB request. */
const MAX_WRITE_ROWS = 10_000;
const MAX_WRITE_CELLS = 50_000;
/** Sheets' own column ceiling (ZZZ). */
const MAX_COLUMNS = 18_278;
/** Named ranges a metadata read lists before saying how many it left out. */
const MAX_NAMED_RANGES = 200;
/** Requests per raw batchUpdate. */
const MAX_BATCH_REQUESTS = 100;
/** A wide values read; Google itself recommends payloads under 2 MB. */
const SHEETS_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/** A 0-based column index as its A1 letters: 0 → A, 26 → AA. */
function columnLetters(index: number): string {
  let letters = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/** A sheet title as A1 needs it: bare when it can be, else single-quoted. */
function sheetPrefix(title: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(title) && !/^[A-Za-z]{1,3}\d+$/.test(title)
    ? title
    : `'${title.replace(/'/g, "''")}'`;
}

/**
 * A GridRange as A1, or `undefined` for a shape A1 cannot say. Google leaves
 * a zero index out of the JSON, and a missing start index means "from the
 * first", so both read as 0; a missing end means "to the edge".
 */
function gridRangeA1(range: JsonRecord, title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const startRow = integer(range["startRowIndex"]) ?? 0;
  const startColumn = integer(range["startColumnIndex"]) ?? 0;
  const endRow = integer(range["endRowIndex"]);
  const endColumn = integer(range["endColumnIndex"]);
  const prefix = sheetPrefix(title);
  if (endRow === undefined && endColumn === undefined) {
    return startRow === 0 && startColumn === 0 ? prefix : undefined;
  }
  if (endColumn === undefined) {
    return startColumn === 0 ? `${prefix}!${startRow + 1}:${endRow}` : undefined;
  }
  const start = `${columnLetters(startColumn)}${startRow + 1}`;
  return `${prefix}!${start}:${columnLetters(endColumn - 1)}${endRow ?? ""}`;
}

// --- Reading values ---------------------------------------------------------------

/**
 * Where a values read resumes: the index into the caller's `ranges`, the A1
 * range to send for it, and rows of that range already returned when the
 * range could not be rewritten to start past them.
 */
interface ValuesCursor {
  n: number;
  i: number;
  r: string;
  s: number;
}

function encodeCursor(cursor: ValuesCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string, ranges: readonly string[]): ValuesCursor {
  const refuse = () =>
    new ConnectorCallError(
      "invalid_args",
      "cursor is not one get_values returned for these ranges. Pass page.nextCursor back unchanged, with the same spreadsheetId and ranges.",
    );
  let parsed: unknown;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    throw refuse();
  }
  const cursor = asRecord(parsed);
  if (
    cursor["n"] !== ranges.length ||
    integer(cursor["i"]) === undefined ||
    cursor["i"] < 0 ||
    cursor["i"] >= ranges.length ||
    typeof cursor["r"] !== "string" ||
    !RANGE_REGEX.test(cursor["r"]) ||
    integer(cursor["s"]) === undefined ||
    cursor["s"] < 0
  ) {
    throw refuse();
  }
  return cursor as unknown as ValuesCursor;
}

/**
 * The rest of a bounded A1 range after its first `rows` rows, or `undefined`
 * when the range Google echoed is not one this can rewrite. Google echoes the
 * whole requested range, bounded (`Sheet1!A1:D1000`), and values start at its
 * first row, so the continuation starts `rows` further down.
 */
function rangeAfter(range: string, rows: number): string | undefined {
  const match = /^(.*!)?([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  if (!match || match[4] === undefined) return undefined;
  const start = Number(match[3]) + rows;
  if (start > Number(match[5])) return undefined;
  return `${match[1] ?? ""}${match[2]}${start}:${match[4]}${match[5]}`;
}

/** A cell as read, cut at {@link MAX_CELL_CHARS} with a marker in the text. */
function cappedCell(value: unknown, cut: { cells: number }): unknown {
  if (typeof value !== "string" || value.length <= MAX_CELL_CHARS) return value;
  cut.cells += 1;
  return `${value.slice(0, MAX_CELL_CHARS)}[… ${value.length - MAX_CELL_CHARS} more characters truncated]`;
}

// --- Writing values ---------------------------------------------------------------

/** Refuse a write past connecta's per-call cell cap before anything is sent. */
function checkWriteSize(blocks: readonly (readonly (readonly unknown[])[])[]): void {
  let cells = 0;
  for (const block of blocks) for (const row of block) cells += row.length;
  if (cells > MAX_WRITE_CELLS) {
    throw new ConnectorCallError(
      "invalid_args",
      `This write carries ${cells} cells; connecta sends at most ${MAX_WRITE_CELLS} per call (Google's own request limit is larger). Split it into several calls. Nothing was written.`,
    );
  }
}

function projectUpdate(value: unknown): JsonRecord {
  const update = asRecord(value);
  return compact({
    updatedRange: text(update["updatedRange"]),
    updatedRows: integer(update["updatedRows"]) ?? 0,
    updatedColumns: integer(update["updatedColumns"]) ?? 0,
    updatedCells: integer(update["updatedCells"]) ?? 0,
  });
}

/**
 * Every `Request` kind Sheets' batchUpdate accepts, from the Discovery
 * document's `Request` schema at revision 20260930. A request must set exactly
 * one of them; its body is Google's to validate. Too many to close in the
 * schema without overrunning H7, so the handler checks the kind before
 * anything is sent. A kind Google adds changes the batchUpdate contract digest,
 * so the drift check surfaces it for this list rather than letting it pass.
 */
const REQUEST_KINDS: ReadonlySet<string> = new Set([
  "addBanding", "addChart", "addCommentReply", "addConditionalFormatRule",
  "addDataSource", "addDimensionGroup", "addFilterView", "addNamedRange",
  "addProtectedRange", "addSheet", "addSlicer", "addTable", "appendCells",
  "appendDimension", "autoFill", "autoResizeDimensions",
  "cancelDataSourceRefresh", "clearBasicFilter", "copyPaste",
  "createDeveloperMetadata", "cutPaste", "deleteBanding", "deleteComment",
  "deleteCommentReply", "deleteConditionalFormatRule", "deleteDataSource",
  "deleteDeveloperMetadata", "deleteDimension", "deleteDimensionGroup",
  "deleteDuplicates", "deleteEmbeddedObject", "deleteFilterView",
  "deleteNamedRange", "deleteProtectedRange", "deleteRange", "deleteSheet",
  "deleteTable", "duplicateFilterView", "duplicateSheet", "findReplace",
  "insertComment", "insertDimension", "insertRange", "mergeCells",
  "moveDimension", "pasteData", "randomizeRange", "refreshDataSource",
  "repeatCell", "setBasicFilter", "setDataValidation", "sortRange",
  "textToColumns", "trimWhitespace", "unmergeCells", "updateBanding",
  "updateBorders", "updateCells", "updateChartSpec", "updateCommentPost",
  "updateConditionalFormatRule", "updateDataSource", "updateDeveloperMetadata",
  "updateDimensionGroup", "updateDimensionProperties",
  "updateEmbeddedObjectBorder", "updateEmbeddedObjectPosition",
  "updateFilterView", "updateNamedRange", "updateProtectedRange",
  "updateSheetProperties", "updateSlicerSpec", "updateSpreadsheetProperties",
  "updateTable",
]);

/** Refuse a raw request that is not exactly one known kind, unsent. */
function checkRequestKinds(requests: readonly unknown[]): void {
  requests.forEach((request, index) => {
    const kinds = Object.keys(asRecord(request));
    if (kinds.length !== 1 || !REQUEST_KINDS.has(kinds[0]!)) {
      throw new ConnectorCallError(
        "invalid_args",
        `requests[${index}] must set exactly one Sheets Request kind (addSheet, repeatCell, deleteDimension, …); it sets ${kinds.length === 0 ? "none" : kinds.slice(0, 3).join(", ")}. Nothing was sent.`,
      );
    }
  });
}

// --- Schemas ----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const SPREADSHEET_ID_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Spreadsheet id: the part of its URL between /d/ and /edit. Find one by name with a Drive search; Sheets cannot list.",
};

/**
 * One line, at least one character that is not a dot: a range is a path
 * segment for append, and `.` or `..` there would climb out of it.
 */
const RANGE_PATTERN = "^[^\\r\\n]*[^.\\r\\n][^\\r\\n]*$";
const RANGE_REGEX = new RegExp(RANGE_PATTERN);

function rangeProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 512, pattern: RANGE_PATTERN, description };
}

const A1_HELP = "A1 notation: Sheet1!A1:D20, 'Q3 Budget'!B:B, a sheet title alone, or a named range";

const RANGES_PROPERTY: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_RANGES,
  items: rangeProperty(`${A1_HELP}.`),
  description: `Ranges to read, 1 to ${MAX_RANGES}, returned in this order.`,
};

const VALUE_INPUT_PROPERTY: JsonSchema = {
  type: "string",
  enum: ["RAW", "USER_ENTERED"],
  description: "RAW stores each value literally; USER_ENTERED parses it as if typed, so =SUM(A1:A3) is a formula and 2026-10-06 a date.",
};

const ROWS_PROPERTY: JsonSchema = {
  type: "array",
  minItems: 1,
  maxItems: MAX_WRITE_ROWS,
  items: {
    type: "array",
    maxItems: MAX_COLUMNS,
    items: { type: ["string", "number", "boolean", "null"], maxLength: 50_000 },
    description: "One row's cells, left to right.",
  },
  description: `Rows of cells, top to bottom. null leaves a cell unchanged; "" empties it. At most ${MAX_WRITE_CELLS} cells per call, connecta's cap.`,
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const CELL_SCHEMA: JsonSchema = { type: ["string", "number", "boolean"] };

const UPDATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    updatedRange: { type: "string" },
    updatedRows: { type: "integer" },
    updatedColumns: { type: "integer" },
    updatedCells: { type: "integer" },
  },
};

const SHEET_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    sheetId: { type: "integer" },
    title: { type: "string" },
    index: { type: "integer" },
    type: { type: "string" },
    hidden: { type: "boolean" },
    rowCount: { type: "integer" },
    columnCount: { type: "integer" },
    frozenRowCount: { type: "integer" },
    frozenColumnCount: { type: "integer" },
  },
};

function projectSheet(value: unknown): JsonRecord {
  const properties = asRecord(asRecord(value)["properties"]);
  const grid = asRecord(properties["gridProperties"]);
  return compact({
    // The first sheet's id is 0, which Google leaves out of the JSON.
    sheetId: integer(properties["sheetId"]) ?? 0,
    title: text(properties["title"]),
    index: integer(properties["index"]) ?? 0,
    type: text(properties["sheetType"]),
    hidden: properties["hidden"] === true ? true : undefined,
    rowCount: integer(grid["rowCount"]),
    columnCount: integer(grid["columnCount"]),
    frozenRowCount: integer(grid["frozenRowCount"]),
    frozenColumnCount: integer(grid["frozenColumnCount"]),
  });
}

/** The metadata get_spreadsheet reads: no grid data, no formatting. */
const SPREADSHEET_FIELDS = [
  "spreadsheetId",
  "spreadsheetUrl",
  "properties(title,locale,timeZone)",
  "sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount))",
  "namedRanges(namedRangeId,name,range)",
].join(",");

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  // Additive: nothing that existed is lost. Not read-only, so each crosses
  // call_destructive_tool unless the deployment exempts it in
  // `execute.approval`; the provider never exempts itself.
  const additive = { readOnlyHint: false, destructiveHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const spreadsheetPath = (args: JsonRecord) =>
    `/spreadsheets/${encodeURIComponent(String(args["spreadsheetId"]))}`;

  return [
    {
      name: "get_spreadsheet",
      description:
        "Get a spreadsheet's title, sheets (ids, titles, grid sizes), and named ranges as A1, never cell values. To find one by name, search Drive; Sheets cannot list.",
      annotations: readOnly,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          raw: {
            type: "boolean",
            description: "Return Google's untouched spreadsheet metadata — formatting, protections, charts — instead of the projection. Never cell values.",
          },
        },
        ["spreadsheetId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          locale: { type: "string" },
          timeZone: { type: "string" },
          sheets: { type: "array", items: SHEET_SCHEMA },
          namedRanges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                namedRangeId: { type: "string" },
                name: { type: "string" },
                sheetId: { type: "integer" },
                range: { type: "string" },
              },
            },
          },
          namedRangesOmitted: { type: "integer" },
        },
        required: ["spreadsheetId", "sheets"],
      },
      handler: async (args, ctx) => {
        if (args["raw"] === true) {
          return await client.json(
            { method: "GET", path: spreadsheetPath(args), query: { includeGridData: false } },
            ctx,
          );
        }
        const spreadsheet = asRecord(
          await client.json(
            { method: "GET", path: spreadsheetPath(args), query: { fields: SPREADSHEET_FIELDS } },
            ctx,
          ),
        );
        const properties = asRecord(spreadsheet["properties"]);
        const sheets = asArray(spreadsheet["sheets"]).map(projectSheet);
        const titles = new Map(sheets.map((sheet) => [sheet["sheetId"] as number, sheet["title"] as string]));
        const named = asArray(spreadsheet["namedRanges"]);
        return compact({
          spreadsheetId: text(spreadsheet["spreadsheetId"]) ?? args["spreadsheetId"],
          title: text(properties["title"]),
          url: text(spreadsheet["spreadsheetUrl"]),
          locale: text(properties["locale"]),
          timeZone: text(properties["timeZone"]),
          sheets,
          namedRanges: named.length > 0
            ? named.slice(0, MAX_NAMED_RANGES).map((value) => {
                const entry = asRecord(value);
                const range = asRecord(entry["range"]);
                const sheetId = integer(range["sheetId"]) ?? 0;
                return compact({
                  namedRangeId: text(entry["namedRangeId"]),
                  name: text(entry["name"]),
                  sheetId,
                  range: gridRangeA1(range, titles.get(sheetId)),
                });
              })
            : undefined,
          namedRangesOmitted: named.length > MAX_NAMED_RANGES ? named.length - MAX_NAMED_RANGES : undefined,
        });
      },
    },
    {
      name: "get_values",
      description:
        "Read cell values from one or more A1 ranges as rows, paged by cell count. Long cells are cut with a marker; no formatting, notes, or formulas unless asked.",
      annotations: readOnly,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          ranges: RANGES_PROPERTY,
          valueRenderOption: {
            type: "string",
            enum: ["FORMATTED_VALUE", "UNFORMATTED_VALUE", "FORMULA"],
            description: "FORMATTED_VALUE (default) as displayed; UNFORMATTED_VALUE as raw numbers; FORMULA shows formulas instead of results.",
          },
          dateTimeRenderOption: {
            type: "string",
            enum: ["SERIAL_NUMBER", "FORMATTED_STRING"],
            description: "Dates when valueRenderOption is not FORMATTED_VALUE: SERIAL_NUMBER (Google's default, days since 1899-12-30) or FORMATTED_STRING.",
          },
          maxCells: {
            type: "integer",
            minimum: 1,
            maximum: MAX_PAGE_CELLS,
            description: `Cells per page, 1 to ${MAX_PAGE_CELLS}; defaults to ${DEFAULT_PAGE_CELLS}. Connecta's cap: Sheets returns whole ranges, so this pages by rows.`,
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            description: "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same spreadsheetId, ranges, and options.",
          },
        },
        ["spreadsheetId", "ranges"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          valueRanges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                range: { type: "string" },
                values: { type: "array", items: { type: "array", items: CELL_SCHEMA } },
                rowCount: { type: "integer" },
                truncated: { type: "boolean" },
                omittedRows: { type: "integer" },
              },
            },
          },
          cellCount: { type: "integer" },
          truncatedCells: { type: "integer" },
          page: PAGE_SCHEMA,
        },
        required: ["spreadsheetId", "valueRanges", "page"],
      },
      handler: async (args, ctx) => {
        const ranges: string[] = args["ranges"];
        const budget: number = args["maxCells"] ?? DEFAULT_PAGE_CELLS;
        const resume = typeof args["cursor"] === "string" ? decodeCursor(args["cursor"], ranges) : undefined;
        const offset = resume?.i ?? 0;
        const sent = resume ? [resume.r, ...ranges.slice(offset + 1)] : ranges;
        const skip = resume?.s ?? 0;
        const response = asRecord(
          await client.json(
            {
              method: "GET",
              path: `${spreadsheetPath(args)}/values:batchGet`,
              query: {
                ranges: sent,
                majorDimension: "ROWS",
                valueRenderOption: args["valueRenderOption"],
                dateTimeRenderOption: args["dateTimeRenderOption"],
              },
            },
            ctx,
          ),
        );
        const valueRanges: JsonRecord[] = [];
        const cut = { cells: 0 };
        let cells = 0;
        let next: ValuesCursor | undefined;
        const returned = asArray(response["valueRanges"]);
        for (let index = 0; index < returned.length && next === undefined; index += 1) {
          const valueRange = asRecord(returned[index]);
          const rows = asArray(valueRange["values"]).slice(index === 0 ? skip : 0);
          const echoed = text(valueRange["range"]) ?? sent[index]!;
          const kept: unknown[][] = [];
          for (const row of rows) {
            // An empty row still costs one, so every page makes progress.
            const width = Math.max(1, asArray(row).length);
            if (cells > 0 && cells + width > budget) break;
            cells += width;
            kept.push(asArray(row).map((cell) => cappedCell(cell, cut)));
          }
          if (kept.length < rows.length) {
            const done = kept.length;
            // A range this page never reached is not reported half-read; the
            // next page starts it over.
            if (done === 0) {
              next = { n: ranges.length, i: offset + index, r: sent[index]!, s: 0 };
              break;
            }
            // Rewritten to start past the rows returned when Google's echo is
            // a bounded A1 range; otherwise resent whole with a row skip.
            const before = index === 0 ? skip : 0;
            const rewritten = before > 0 ? undefined : rangeAfter(echoed, done);
            next = {
              n: ranges.length,
              i: offset + index,
              r: rewritten ?? sent[index]!,
              s: rewritten ? 0 : before + done,
            };
            valueRanges.push({
              range: echoed,
              values: kept,
              rowCount: done,
              truncated: true,
              omittedRows: rows.length - done,
            });
            break;
          }
          valueRanges.push({ range: echoed, values: kept, rowCount: kept.length });
          if (cells >= budget && index + 1 < returned.length) {
            next = { n: ranges.length, i: offset + index + 1, r: sent[index + 1]!, s: 0 };
          }
        }
        const nextCursor = next ? encodeCursor(next) : null;
        return compact({
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          valueRanges,
          cellCount: cells,
          truncatedCells: cut.cells > 0 ? cut.cells : undefined,
          page: { hasMore: nextCursor !== null, nextCursor },
        });
      },
    },
    {
      name: "update_values",
      description:
        "Write rows of values into one A1 range, overwriting what is there. Cells past the given rows are untouched; to add rows below a table use append_values.",
      annotations: destructive,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          range: rangeProperty(`${A1_HELP}; the top-left cell is where the first value goes.`),
          values: ROWS_PROPERTY,
          valueInputOption: VALUE_INPUT_PROPERTY,
        },
        ["spreadsheetId", "range", "values", "valueInputOption"],
      ),
      outputSchema: {
        type: "object",
        properties: { spreadsheetId: { type: "string" }, ...(UPDATE_SCHEMA.properties as Record<string, JsonSchema>) },
        required: ["spreadsheetId"],
      },
      handler: async (args, ctx) => {
        checkWriteSize([args["values"]]);
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchUpdate`,
              body: {
                valueInputOption: args["valueInputOption"],
                data: [{ range: args["range"], majorDimension: "ROWS", values: args["values"] }],
                includeValuesInResponse: false,
              },
            },
            ctx,
          ),
        );
        return {
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          ...projectUpdate(asArray(response["responses"])[0]),
        };
      },
    },
    {
      name: "batch_update_values",
      description:
        "Write values into several A1 ranges in one call, overwriting each. All succeed or none do. For formatting or structure use batch_update_spreadsheet.",
      annotations: destructive,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          data: {
            type: "array",
            minItems: 1,
            maxItems: MAX_DATA_RANGES,
            items: {
              type: "object",
              properties: {
                range: rangeProperty(`${A1_HELP}.`),
                values: ROWS_PROPERTY,
              },
              required: ["range", "values"],
              additionalProperties: false,
            },
            description: `Ranges and their rows, 1 to ${MAX_DATA_RANGES}.`,
          },
          valueInputOption: VALUE_INPUT_PROPERTY,
        },
        ["spreadsheetId", "data", "valueInputOption"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          totalUpdatedRows: { type: "integer" },
          totalUpdatedColumns: { type: "integer" },
          totalUpdatedCells: { type: "integer" },
          totalUpdatedSheets: { type: "integer" },
          updates: { type: "array", items: UPDATE_SCHEMA },
        },
        required: ["spreadsheetId", "updates"],
      },
      handler: async (args, ctx) => {
        const data = asArray(args["data"]).map(asRecord);
        checkWriteSize(data.map((entry) => entry["values"]));
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchUpdate`,
              body: {
                valueInputOption: args["valueInputOption"],
                data: data.map((entry) => ({ range: entry["range"], majorDimension: "ROWS", values: entry["values"] })),
                includeValuesInResponse: false,
              },
            },
            ctx,
          ),
        );
        return {
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          totalUpdatedRows: integer(response["totalUpdatedRows"]) ?? 0,
          totalUpdatedColumns: integer(response["totalUpdatedColumns"]) ?? 0,
          totalUpdatedCells: integer(response["totalUpdatedCells"]) ?? 0,
          totalUpdatedSheets: integer(response["totalUpdatedSheets"]) ?? 0,
          updates: asArray(response["responses"]).map(projectUpdate),
        };
      },
    },
    {
      name: "append_values",
      description:
        "Append rows after the last row of the table in an A1 range, inserting new rows so nothing below is overwritten. Returns where they landed.",
      annotations: additive,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          range: rangeProperty(`${A1_HELP}; Sheets finds the table in it and appends below its last row.`),
          values: ROWS_PROPERTY,
          valueInputOption: VALUE_INPUT_PROPERTY,
        },
        ["spreadsheetId", "range", "values", "valueInputOption"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          tableRange: { type: "string" },
          ...(UPDATE_SCHEMA.properties as Record<string, JsonSchema>),
        },
        required: ["spreadsheetId"],
      },
      handler: async (args, ctx) => {
        checkWriteSize([args["values"]]);
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}/values/${encodeURIComponent(String(args["range"]))}:append`,
              query: {
                valueInputOption: args["valueInputOption"],
                // Pinned: OVERWRITE writes over whatever sits below the table.
                insertDataOption: "INSERT_ROWS",
                includeValuesInResponse: false,
              },
              body: { majorDimension: "ROWS", values: args["values"] },
            },
            ctx,
          ),
        );
        return compact({
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          tableRange: text(response["tableRange"]),
          ...projectUpdate(response["updates"]),
        });
      },
    },
    {
      name: "clear_values",
      description:
        "Clear the values in one or more A1 ranges, keeping formatting, notes, and validation. The values are gone; nothing is deleted or shifted.",
      annotations: destructive,
      inputSchema: input(
        { spreadsheetId: SPREADSHEET_ID_PROPERTY, ranges: { ...RANGES_PROPERTY, description: `Ranges to clear, 1 to ${MAX_RANGES}.` } },
        ["spreadsheetId", "ranges"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          clearedRanges: { type: "array", items: { type: "string" } },
        },
        required: ["spreadsheetId", "clearedRanges"],
      },
      handler: async (args, ctx) => {
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchClear`,
              body: { ranges: args["ranges"] },
            },
            ctx,
          ),
        );
        return {
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          clearedRanges: asArray(response["clearedRanges"]).filter((range) => typeof range === "string"),
        };
      },
    },
    {
      name: "create_spreadsheet",
      description:
        "Create a new spreadsheet in the user's My Drive root, optionally with named sheets. It is not shared or moved; that is Drive's job.",
      annotations: additive,
      inputSchema: input(
        {
          title: { type: "string", minLength: 1, maxLength: 255, pattern: "^[^\\r\\n]*$", description: "The spreadsheet's file name." },
          sheetTitles: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            uniqueItems: true,
            items: { type: "string", minLength: 1, maxLength: 100, pattern: "^[^\\r\\n]*$", description: "One sheet tab's title." },
            description: "Sheet tabs to start with, in order; omit for Google's one sheet, Sheet1.",
          },
        },
        ["title"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          sheets: {
            type: "array",
            items: { type: "object", properties: { sheetId: { type: "integer" }, title: { type: "string" } } },
          },
        },
        required: ["spreadsheetId", "sheets"],
      },
      handler: async (args, ctx) => {
        const titles: string[] | undefined = args["sheetTitles"];
        const spreadsheet = asRecord(
          await client.json(
            {
              method: "POST",
              path: "/spreadsheets",
              query: { fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)" },
              body: compact({
                properties: { title: args["title"] },
                sheets: titles?.map((title) => ({ properties: { title } })),
              }),
            },
            ctx,
          ),
        );
        return compact({
          spreadsheetId: text(spreadsheet["spreadsheetId"]),
          title: text(asRecord(spreadsheet["properties"])["title"]),
          url: text(spreadsheet["spreadsheetUrl"]),
          sheets: asArray(spreadsheet["sheets"]).map((sheet) => {
            const { sheetId, title } = projectSheet(sheet);
            return compact({ sheetId, title });
          }),
        });
      },
    },
    {
      name: "add_sheet",
      description:
        "Add a new, empty sheet tab to a spreadsheet. Fails if the title is taken; it never renames, replaces, or copies an existing sheet.",
      annotations: additive,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          title: { type: "string", minLength: 1, maxLength: 100, pattern: "^[^\\r\\n]*$", description: "The new tab's title, unique in the spreadsheet." },
          index: { type: "integer", minimum: 0, maximum: 1_000, description: "Tab position, 0 first; omit to add it last." },
          rowCount: { type: "integer", minimum: 1, maximum: 1_000_000, description: "Rows in the grid; Google defaults to 1,000." },
          columnCount: { type: "integer", minimum: 1, maximum: MAX_COLUMNS, description: "Columns in the grid; Google defaults to 26." },
        },
        ["spreadsheetId", "title"],
      ),
      outputSchema: { type: "object", properties: { spreadsheetId: { type: "string" }, ...(SHEET_SCHEMA.properties as Record<string, JsonSchema>) }, required: ["spreadsheetId", "sheetId"] },
      handler: async (args, ctx) => {
        const grid = compact({ rowCount: args["rowCount"], columnCount: args["columnCount"] });
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}:batchUpdate`,
              body: {
                requests: [
                  {
                    addSheet: {
                      properties: compact({
                        title: args["title"],
                        index: args["index"],
                        gridProperties: Object.keys(grid).length > 0 ? grid : undefined,
                      }),
                    },
                  },
                ],
              },
            },
            ctx,
          ),
        );
        const added = asRecord(asRecord(asArray(response["replies"])[0])["addSheet"]);
        return {
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          ...projectSheet(added),
        };
      },
    },
    {
      name: "batch_update_spreadsheet",
      description:
        "Apply raw Sheets batchUpdate requests — formatting, merges, sorts, deleting sheets or rows, protections — atomically. The approval-gated hatch; it can destroy data.",
      // Destructive, whatever the requests are: they can delete sheets, rows,
      // ranges, and protections, and connecta does not read them to guess.
      annotations: destructive,
      inputSchema: input(
        {
          spreadsheetId: SPREADSHEET_ID_PROPERTY,
          requests: {
            type: "array",
            minItems: 1,
            maxItems: MAX_BATCH_REQUESTS,
            items: {
              type: "object",
              minProperties: 1,
              maxProperties: 1,
              description: "One Sheets Request with exactly one kind set, as Google documents it: { repeatCell: {…} }, { deleteDimension: {…} }, { sortRange: {…} }.",
            },
            description: `Sheets API Request objects, 1 to ${MAX_BATCH_REQUESTS}, applied in order; all succeed or none do.`,
          },
        },
        ["spreadsheetId", "requests"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          spreadsheetId: { type: "string" },
          replies: { type: "array", items: { type: "object" } },
        },
        required: ["spreadsheetId", "replies"],
      },
      handler: async (args, ctx) => {
        checkRequestKinds(args["requests"]);
        const response = asRecord(
          await client.json(
            {
              method: "POST",
              path: `${spreadsheetPath(args)}:batchUpdate`,
              body: { requests: args["requests"], includeSpreadsheetInResponse: false },
            },
            ctx,
          ),
        );
        return {
          spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          replies: asArray(response["replies"]).map(asRecord),
        };
      },
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `# Google Sheets usage

Acts as the signed-in person in their own Google Sheets through Workspace delegation: it reaches only spreadsheets they can open, starting from an id.

Connection purpose: ${purpose}

## Whose spreadsheets

Every call acts as the Workspace account deployment config maps the caller
to. No argument names an account. A call with none mapped fails
\`auth_required\`; only an operator can change the mapping. An id that is
unknown or not shared with this person fails the same way — Google does not
say which.

## Finding a spreadsheet

- Sheets cannot list or search files. Find one by name with a Google Drive
  search, or take the id from its URL (between \`/d/\` and \`/edit\`).
- \`get_spreadsheet\` first: sheet titles, ids, grid sizes, and named ranges,
  so ranges are named right rather than guessed.

## Ranges

- A1 notation. Quote a sheet title with spaces or punctuation:
  \`'Q3 Budget'!A1:D20\`, doubling any \`'\` inside it. A bare title is the
  whole sheet; \`Sheet1!B:B\` a whole column; a named range works by name.
- \`get_values\` pages by cell count, not by range: page with
  \`page.nextCursor\` and the same ranges. A cell over ${MAX_CELL_CHARS}
  characters ends with a truncation marker. Reduce inside \`execute_code\`
  before returning a large read.

## Writing

- \`valueInputOption\` is required: \`RAW\` stores text as given;
  \`USER_ENTERED\` parses it as typed, so a leading \`=\` makes a formula. Use
  RAW for data from outside the spreadsheet.
- In written rows, \`null\` leaves a cell as it was and \`""\` empties it.
- \`append_values\` inserts rows below the table and overwrites nothing;
  \`update_values\` and \`batch_update_values\` overwrite the cells they
  cover; \`clear_values\` empties values but keeps formatting.
- \`batch_update_spreadsheet\` takes Google's own Request objects for
  everything else (formatting, sorting, deleting rows or sheets); it is
  atomic, always needs approval, and can destroy data.
- Sheets has no revision check on writes: edits are last-writer-wins, so a
  person editing the same cells meanwhile is overwritten without warning.
  Read just before writing over anything a person may be editing.
- Moving, sharing, or deleting a spreadsheet file is Drive's job.
${extra ? `\n## Connection instructions\n\n${extra}\n` : ""}`;
}

// --- Construction -----------------------------------------------------------------

/**
 * A maintained Google Sheets connection acting as each signed-in Workspace
 * user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Google Sheets API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches spreadsheets.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new (or
 *    edit the client ID's existing entry — one client ID has one entry, so add
 *    to the scopes another Workspace provider already listed rather than
 *    replacing them). The scope this connection needs ({@link SHEETS_SCOPES}):
 *    `https://www.googleapis.com/auth/spreadsheets`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to accounts:
 *
 * ```ts
 * sheets("sheets", {
 *   purpose: "Finance and attendance spreadsheets",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => accounts[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * Reads are read-only. `create_spreadsheet`, `add_sheet`, and `append_values`
 * are additive writes the host approves unless the deployment exempts them in
 * `execute.approval`; the value writes, `clear_values`, and the raw
 * `batch_update_spreadsheet` are destructive.
 */
export function sheets(id: string, options: SheetsOptions): Connector {
  const connection = workspaceConnection("sheets", options);
  const client = googleWorkspaceClient({
    provider: "Google Sheets",
    api: "Google Sheets API",
    baseUrl: options.baseUrl?.trim() || SHEETS_API_BASE_URL,
    scopes: SHEETS_SCOPES,
    maxResponseBytes: SHEETS_MAX_RESPONSE_BYTES,
    // A spreadsheet is a Drive file: a 404 may be a file that exists and is
    // not shared with this user, so absence is never asserted.
    notFound: "ambiguous",
    connection,
  });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Google Sheets",
    description: `Google Sheets as the signed-in Workspace user: read and write values in spreadsheets they can open, by id — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own spreadsheets by id: A1 ranges, cell-paged reads, RAW or USER_ENTERED writes, raw batchUpdate.",
      // Required: whose spreadsheets they are, that Drive finds them, and what
      // null and "" mean in a written row are conventions no schema carries.
      required: true,
    },
    tools: tools(client),
  });
}
