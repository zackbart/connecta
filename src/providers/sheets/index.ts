import { skill } from "./skill.generated.js";
/**
 * Google Sheets as the signed-in Workspace user: read a spreadsheet's shape
 * and its values, write, append, and clear values, create spreadsheets and
 * sheets, and reach the rest of the editor through one approval-gated
 * `batchUpdate`. Hand-written against the Sheets API v4 reference
 * (https://developers.google.com/workspace/sheets/api/reference/rest).
 *
 * Whose spreadsheets. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
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
 * `src/providers/sheets/drift.json` records the seven methods the tools
 * call, and `npm run providers:check -- --provider sheets` reports a touched
 * contract that moved or a method that stopped accepting the scope below.
 */
import { apiConnector as api, defined, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connector, JsonSchema } from "../../types.js";
import {
  googleOutcomeOf,
  GOOGLE_WORKSPACE_OPTIONS,
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "../_shared/google/workspace.js";
import { clampText, jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { asProviderFactory } from "../../provider.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

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
/**
 * Bytes per page of get_values as serialized, beside the cell count: a page
 * has to be deliverable, and cells say nothing about size — 60 cells of 5,000
 * characters already outgrow the QuickJS executor's host bridge. The default
 * is the Workspace providers' shared result budget, so an execute_code
 * program always receives a default page; unlike that budget's envelope
 * allowance, maxBytes bounds the whole page, fields and cursor included. A
 * direct call_tool caller may ask for more, up to 4 MiB: base64 in the result
 * stash makes that about 5.6 MiB, under the stash's default 8 MiB, so an
 * oversized page still pages through get_result rather than being dropped.
 */
const DEFAULT_PAGE_BYTES = RESULT_BUDGET_BYTES;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Characters a read keeps per cell by default. A cell holds at most 50,000
 * (Sheets' own limit), so `maxCellChars` at that ceiling always reads one whole.
 */
const DEFAULT_CELL_CHARS = 5_000;
const MAX_CELL_CHARS = 50_000;
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

/**
 * A sheet title as A1, always single-quoted. Bare, a whole-sheet range is
 * indistinguishable from a named range of the same name — and Google resolves
 * the named range first, so `Sheet1` handed to clear_values could clear
 * something else. No named range can contain a quote, so quoted cannot.
 */
function sheetPrefix(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
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
 * Where a values read resumes: an index into the caller's own `ranges` and
 * the rows of that range already returned, bound by digest to the call's
 * spreadsheet, ranges, and render options. It carries no range of its own, so
 * a cursor can only ever continue what the arguments name.
 */
interface ValuesCursor {
  d: string;
  i: number;
  s: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What a cursor is bound to: everything that decides which cells a page reads. */
async function readDigest(args: JsonRecord): Promise<string> {
  const bound = JSON.stringify([
    args["spreadsheetId"],
    args["ranges"],
    args["valueRenderOption"] ?? null,
    args["dateTimeRenderOption"] ?? null,
  ]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bound)));
  return base64Url(hash.subarray(0, 16));
}

function encodeCursor(cursor: ValuesCursor): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeCursor(value: string, ranges: readonly string[], digest: string): ValuesCursor {
  const refuse = () =>
    new ConnectorCallError(
      "invalid_args",
      "cursor is not one get_values returned for this call. Pass page.nextCursor back unchanged, with the same spreadsheetId, ranges, and render options.",
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
  const index = integer(cursor["i"]);
  const skip = integer(cursor["s"]);
  if (
    Object.keys(cursor).length !== 3 ||
    cursor["d"] !== digest ||
    index === undefined ||
    index < 0 ||
    index >= ranges.length ||
    skip === undefined ||
    skip < 0
  ) {
    throw refuse();
  }
  return { d: digest, i: index, s: skip };
}

/**
 * The caller's own range past its first `rows` rows, when the range says
 * where it starts: `Sheet1!C5:F100` → `Sheet1!C8:F100`, `B:D` → `B4:D`. A
 * sheet title, a named range, or R1C1 does not, and is resent whole with the
 * rows skipped instead — correct, but it re-reads what earlier pages did.
 */
function rangeAfter(range: string, rows: number): string | undefined {
  if (rows === 0) return range;
  const match = /^(.*!)?([A-Z]+)(\d+)?:([A-Z]+)(\d+)?$/.exec(range);
  if (!match) return undefined;
  const [, prefix = "", startColumn, startRow, endColumn, endRow] = match;
  if (startRow === undefined && endRow !== undefined) return undefined;
  const first = Number(startRow ?? 1);
  if (endRow !== undefined && first > Number(endRow)) return undefined;
  const start = first + rows;
  if (endRow !== undefined && start > Number(endRow)) return undefined;
  return `${prefix}${startColumn}${start}:${endColumn}${endRow ?? ""}`;
}

/** A cell as read, cut at `max` characters with a marker saying how to read the rest. */
function cappedCell(value: unknown, max: number, cut: { cells: number }): unknown {
  if (typeof value !== "string" || value.length <= max) return value;
  cut.cells += 1;
  return `${value.slice(0, max)}[… ${value.length - max} more characters truncated; read this cell alone with maxCellChars up to ${MAX_CELL_CHARS} for the rest]`;
}

/** Refuse a row no page of `budget` bytes can hold, rather than overrun the cap. */
function rowTooLarge(range: string, row: number, needed: number, budget: number): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `Row ${row} of ${range} needs a page of ${needed} bytes with the page's own fields, more than this page's maxBytes of ${budget}; narrow the range's columns or lower maxCellChars${raiseBytes(needed)}.`,
  );
}

/** Refuse a page too small for even one range's own fields. */
function pageTooSmall(range: string, needed: number, budget: number): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `A page reporting ${range} needs ${needed} bytes before any of its rows, more than this page's maxBytes of ${budget}; shorten the range${raiseBytes(needed)}.`,
  );
}

function raiseBytes(needed: number): string {
  if (needed > MAX_PAGE_BYTES) return "";
  return needed <= DEFAULT_PAGE_BYTES
    ? `, or raise maxBytes to at least ${needed}`
    : `, or raise maxBytes to at least ${needed} (above ${DEFAULT_PAGE_BYTES}, only for a direct call_tool read: execute_code cannot receive it)`;
}

/** Refuse a row no page of `budget` cells can hold, rather than overrun the cap. */
function rowTooWide(range: string, row: number, width: number, budget: number): ConnectorCallError {
  const fix = width <= MAX_PAGE_CELLS
    ? `raise maxCells to at least ${width}, or narrow the range's columns`
    : `narrow the range's columns; a page holds at most ${MAX_PAGE_CELLS} cells`;
  return new ConnectorCallError(
    "invalid_args",
    `Row ${row} of ${range} has ${width} cells, more than this page's maxCells of ${budget}; ${fix}.`,
  );
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

/**
 * A write whose outcome is unknown — sent, and then anything but an answer
 * Google refused it with: a reply that broke off, no reply, a redirect, or a
 * 5xx after receiving it — told what to read before trying again, for the
 * writes where the shared "re-read before repeating it" has nothing to re-read
 * or where repeating does harm. The advice claims nothing either way; only
 * the client's own message says "probably applied", and only for a 2xx whose
 * body broke off. A refusal, and anything never sent, passes through as the
 * client mapped it.
 */
async function uncertainWrite<T>(advice: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const outcome = googleOutcomeOf(error);
    if (!(error instanceof ConnectorCallError) || !outcome?.dispatched || outcome.phase === "refused") {
      throw error;
    }
    throw new ConnectorCallError(error.code, `${error.message} ${advice}`, { retryable: false, cause: error });
  }
}

// --- Raw batchUpdate replies -----------------------------------------------------

/** A string kept in a reply summary, cut so a long one cannot crowd out ids. */
const SUMMARY_TEXT_BYTES = 256;

/** The scalar fields of an object — ids, titles, counts — and nothing nested. */
function scalarsOf(value: unknown): JsonRecord | undefined {
  const scalars: JsonRecord = {};
  for (const [key, field] of Object.entries(asRecord(value))) {
    if (typeof field === "string") {
      scalars[key] = clampText(field, SUMMARY_TEXT_BYTES, (dropped) => `[… ${dropped} more characters]`);
    } else if (typeof field === "number" || typeof field === "boolean") {
      scalars[key] = field;
    }
  }
  return Object.keys(scalars).length > 0 ? scalars : undefined;
}

/**
 * One reply reduced to its kind and the scalars an agent acts on next: a new
 * sheet's id and title, a chart's id, findReplace's counts. Google's replies
 * put those at the top of the kind's body or one object down (`properties`,
 * `chart`, `namedRange`); arrays and anything deeper are dropped.
 */
function summarizeReply(reply: JsonRecord): JsonRecord {
  const kind = Object.keys(reply)[0];
  if (kind === undefined) return {};
  const body = asRecord(reply[kind]);
  const nested: JsonRecord = {};
  for (const [key, field] of Object.entries(body)) {
    if (field && typeof field === "object" && !Array.isArray(field)) nested[key] = scalarsOf(field);
  }
  return compact({ kind, ...scalarsOf(body), ...compact(nested) });
}

/**
 * A batchUpdate result that can be delivered. The write has already applied,
 * so whatever does not fit is summarized, never dropped silently and never
 * reported as a failure: replies are kept whole, in order, while the ones
 * after them still fit as summaries; the rest become summaries; and a reply
 * set too large even for that leaves the counts and where to re-read.
 */
function deliverableReplies(spreadsheetId: string, replies: JsonRecord[], requestCount: number): JsonRecord {
  const whole = { spreadsheetId, replies };
  if (jsonBytes(whole) <= RESULT_BUDGET_BYTES) return whole;
  const note = `All ${requestCount} requests applied. Replies too large to return here are cut to their kind, ids, and counts; read the spreadsheet with get_spreadsheet or get_values for the rest. Do not send the requests again.`;
  const summaries = replies.map(summarizeReply);
  // What every reply from index i on costs as a summary, comma included.
  const rest = Array.from({ length: replies.length + 1 }, () => 0);
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    rest[index] = rest[index + 1]! + jsonBytes(summaries[index]) + 1;
  }
  let bytes = jsonBytes({ spreadsheetId, replies: [], repliesSummarized: replies.length, note });
  if (bytes + rest[0]! <= RESULT_BUDGET_BYTES) {
    const kept: JsonRecord[] = [];
    let summarized = 0;
    replies.forEach((reply, index) => {
      const size = jsonBytes(reply) + 1;
      if (summarized === 0 && bytes + size + rest[index + 1]! <= RESULT_BUDGET_BYTES) {
        bytes += size;
        kept.push(reply);
      } else {
        summarized += 1;
        kept.push(summaries[index]!);
      }
    });
    return { spreadsheetId, replies: kept, repliesSummarized: summarized, note };
  }
  return {
    spreadsheetId,
    replies: [],
    repliesOmitted: replies.length,
    note: `All ${requestCount} requests applied, but their ${replies.length} replies are too large to return even summarized. Read the spreadsheet with get_spreadsheet or get_values to see the result. Do not send the requests again.`,
  };
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
            description: `Cells per page, 1 to ${MAX_PAGE_CELLS}; defaults to ${DEFAULT_PAGE_CELLS}. Connecta's cap: Sheets returns whole ranges, so this pages by whole rows.`,
          },
          maxBytes: {
            type: "integer",
            minimum: 1_024,
            maximum: MAX_PAGE_BYTES,
            description: `Bytes of the whole page as JSON; defaults to ${DEFAULT_PAGE_BYTES}, what execute_code can receive. Raise it, to ${MAX_PAGE_BYTES}, only for a direct call_tool read.`,
          },
          maxCellChars: {
            type: "integer",
            minimum: 1,
            maximum: MAX_CELL_CHARS,
            description: `Characters kept per cell, to ${MAX_CELL_CHARS} (Sheets' cell limit, so the whole cell); defaults to ${DEFAULT_CELL_CHARS}. Longer cells end with a marker.`,
          },
          cursor: {
            type: "string",
            minLength: 1,
            maxLength: 1024,
            description: "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same spreadsheetId, ranges, and render options.",
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
                rowOffset: { type: "integer" },
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
        const byteBudget: number = args["maxBytes"] ?? DEFAULT_PAGE_BYTES;
        const cellChars: number = args["maxCellChars"] ?? DEFAULT_CELL_CHARS;
        const digest = await readDigest(args);
        const resume = typeof args["cursor"] === "string"
          ? decodeCursor(args["cursor"], ranges, digest)
          : { d: digest, i: 0, s: 0 };
        // Every range sent is the caller's own, or the caller's own rewritten
        // to start further down; nothing in the cursor names a range.
        const rewritten = rangeAfter(ranges[resume.i]!, resume.s);
        const sent = [rewritten ?? ranges[resume.i]!, ...ranges.slice(resume.i + 1)];
        const skip = rewritten === undefined ? resume.s : 0;
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
        const spreadsheetId: string = text(response["spreadsheetId"]) ?? args["spreadsheetId"];
        const valueRanges: JsonRecord[] = [];
        const cut = { cells: 0 };
        let cells = 0;
        // maxBytes bounds the whole page as serialized, not just its cells. The
        // envelope is reserved first at its largest: both counts at their
        // ceiling and the longest cursor this call could end with.
        let bytes = jsonBytes({
          spreadsheetId,
          valueRanges: [],
          cellCount: MAX_PAGE_CELLS,
          truncatedCells: MAX_PAGE_CELLS,
          page: {
            hasMore: false,
            nextCursor: encodeCursor({ d: digest, i: ranges.length - 1, s: Number.MAX_SAFE_INTEGER }),
          },
        });
        let next: ValuesCursor | undefined;
        const returned = asArray(response["valueRanges"]);
        for (let index = 0; index < returned.length && next === undefined; index += 1) {
          const valueRange = asRecord(returned[index]);
          // Rows of the caller's range earlier pages returned, and of those,
          // how many Google sent again and this page drops.
          const before = index === 0 ? resume.s : 0;
          const dropped = index === 0 ? skip : 0;
          const rows = asArray(valueRange["values"]).slice(dropped);
          const echoed = text(valueRange["range"]) ?? sent[index]!;
          const entry = (kept: unknown[][], truncated: boolean) =>
            compact({
              range: echoed,
              rowOffset: dropped > 0 ? dropped : undefined,
              values: kept,
              rowCount: kept.length,
              truncated: truncated ? true : undefined,
              omittedRows: truncated ? rows.length - kept.length : undefined,
            });
          // This range's own fields at their largest, and the comma before it;
          // an empty range costs them too.
          const fields = jsonBytes(compact({
            range: echoed,
            rowOffset: dropped > 0 ? dropped : undefined,
            values: [],
            rowCount: rows.length,
            truncated: true,
            omittedRows: rows.length,
          })) + 1;
          if (bytes + fields > byteBudget) {
            if (valueRanges.length === 0) throw pageTooSmall(echoed, bytes + fields, byteBudget);
            next = { d: digest, i: resume.i + index, s: before };
            break;
          }
          bytes += fields;
          const kept: unknown[][] = [];
          for (const row of rows) {
            const empty = valueRanges.length === 0 && kept.length === 0;
            // An empty row still costs one cell, so every page makes progress.
            const width = Math.max(1, asArray(row).length);
            if (cells + width > budget) {
              if (cells === 0) throw rowTooWide(echoed, dropped + kept.length + 1, width, budget);
              break;
            }
            const rowCut = { cells: 0 };
            const capped = asArray(row).map((cell) => cappedCell(cell, cellChars, rowCut));
            // The row as serialized, plus the comma before it.
            const size = jsonBytes(capped) + 1;
            if (bytes + size > byteBudget) {
              if (empty) throw rowTooLarge(echoed, dropped + 1, bytes + size, byteBudget);
              break;
            }
            cells += width;
            bytes += size;
            cut.cells += rowCut.cells;
            kept.push(capped);
          }
          if (kept.length < rows.length) {
            next = { d: digest, i: resume.i + index, s: before + kept.length };
            // A range this page never reached is not reported half-read; the
            // next page starts it.
            if (kept.length > 0) valueRanges.push(entry(kept, true));
            break;
          }
          valueRanges.push(entry(kept, false));
          if (cells >= budget && index + 1 < returned.length) {
            next = { d: digest, i: resume.i + index + 1, s: 0 };
          }
        }
        const nextCursor = next ? encodeCursor(next) : null;
        return compact({
          spreadsheetId,
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
            // The same cells set to the same values twice is one write: a 5xx
            // stays retryable.
            { idempotent: true },
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
            { idempotent: true },
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
          // Appending is not idempotent: a second call after one that landed
          // adds the rows twice.
          await uncertainWrite(
            "Appending again would add the rows a second time if the first append landed: read the table with get_values and append only what is missing.",
            () => client.json(
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
            // Clearing fixed ranges twice clears them once.
            { idempotent: true },
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
          // A spreadsheet that may exist has no id to re-read; only its title
          // can find it, and Sheets cannot search.
          await uncertainWrite(
            "Search Drive for this title before creating it again, or a second spreadsheet results.",
            () => client.json(
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
          repliesSummarized: { type: "integer" },
          repliesOmitted: { type: "integer" },
          note: { type: "string" },
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
        return deliverableReplies(
          text(response["spreadsheetId"]) ?? args["spreadsheetId"],
          asArray(response["replies"]).map(asRecord),
          asArray(args["requests"]).length,
        );
      },
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${DEFAULT_CELL_CHARS}${skill.fragments.guide_2}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
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
export const sheets = asProviderFactory<SheetsOptions>({
  name: "sheets",
  title: "Google Sheets",
  kind: "api",
  readme: "Google Sheets",
  bundle: {"baselineGzip":26026,"maxGzip":86026,"note":"./providers/sheets starts at 26,026 B gzip (#682): the same class as ./providers/gmail — a hand-written api() surface over the shared Workspace delegation layer, with no OAuth client and no MCP SDK. The cap uses the existing baseline + 60,000 B policy."},
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  create: sheetsConnector,
});

function sheetsConnector(id: string, options: SheetsOptions): Connector {
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
