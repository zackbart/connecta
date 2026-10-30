import { routePhrases, type RoutePhrases } from "../../agent-routes.js";
import { asRecord, asArray, compact } from "../_shared/json.js";
// Google Sheets named projections, bounded cell reads and guarded writes.
import { Effect, Option, Schema } from "effect";
import type { ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import { Refusal, type HttpFailure } from "../../http/errors.js";
import type { CallServices } from "../../http/services.js";
import type { Connection } from "../../http/vendor.js";
import type { ConnectorContext } from "../../types.js";
import { googleClient, googleFailureMessage, googleOutcomeOf } from "../_shared/google/kit.js";
import { clampText, jsonBytes, RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { encodeForAgent, redactBeforeCut } from "../../sent-secrets.js";
import { read, write } from "../../http/tools.js";
import { boundCursor } from "../../http/paging.js";
import { fieldsContract, selectFields } from "../../http/fields.js";
import { Operation } from "../../runtime/call.js";
import { sheetsIndex } from "./lib/hatch.js";
import { SHEETS_ADMITTED_KINDS, SHEETS_REFUSED_KINDS, sheetsExternalDataProblem } from "./lib/requests.js";
import { inputs, outputs } from "./lib/schemas.js";

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
 * oversized page still pages through connecta.result rather than being dropped.
 */
const DEFAULT_PAGE_BYTES = RESULT_BUDGET_BYTES;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/**
 * Characters a read keeps per cell by default. A cell holds at most 50,000
 * (Sheets' own limit), so `maxCellChars` at that ceiling always reads one whole.
 */
const DEFAULT_CELL_CHARS = 5_000;
const MAX_CELL_CHARS = 50_000;
/** Rows and cells one write may carry: connecta's cap, under Google's 10 MB request. */
const MAX_WRITE_CELLS = 50_000;
/** Named ranges a metadata read lists before reporting a size cut. */
const MAX_NAMED_RANGES = 200;

type JsonRecord = Record<string, any>;

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

/** Signed positions within the caller's ranges; the shared codec binds deployment, caller and read arguments. */
interface ValuesCursor {
  i: number;
  s: number;
}

function valuesCursorArgs(args: JsonRecord): JsonRecord {
  return {
    spreadsheetId: args["spreadsheetId"],
    ranges: args["ranges"],
    valueRenderOption: args["valueRenderOption"] ?? null,
    dateTimeRenderOption: args["dateTimeRenderOption"] ?? null,
  };
}

function encodeCursor(ctx: ConnectorContext, args: JsonRecord, cursor: ValuesCursor) {
  return boundCursor.encode("get_values", valuesCursorArgs(args), JSON.stringify(cursor), (json) =>
    encodeForAgent(ctx, json, { url: true, claims: true }),
  );
}

function decodeCursor(value: string, ranges: readonly string[]): ValuesCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  const cursor = asRecord(parsed),
    index = integer(cursor["i"]),
    skip = integer(cursor["s"]);
  if (
    Object.keys(cursor).length !== 2 ||
    index === undefined ||
    index < 0 ||
    index >= ranges.length ||
    skip === undefined ||
    skip < 0 ||
    !Number.isSafeInteger(skip)
  ) {
    throw new ConnectorCallError(
      "invalid_args",
      "Pass the get_values page.nextCursor back unchanged with the same spreadsheet, ranges and render options.",
    );
  }
  return { i: index, s: skip };
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

/** A cell as read, cut at `max` characters with a marker saying how to read the rest. Every
 * secret the request sent is replaced first: a cut through an echo leaves a fragment. */
function cappedCell(ctx: ConnectorContext, whole: unknown, max: number, cut: { cells: number }): unknown {
  if (typeof whole !== "string" || whole.length <= max) return whole;
  const value = redactBeforeCut(ctx, whole);
  if (value.length <= max) return value;
  cut.cells += 1;
  return `${value.slice(0, max)}[… ${value.length - max} more characters truncated; read this cell alone with maxCellChars up to ${MAX_CELL_CHARS} for the rest]`;
}

/** Refuse a row no page of `budget` bytes can hold, rather than overrun the cap. */
function rowTooLarge(
  range: string,
  row: number,
  needed: number,
  budget: number,
  phrases: RoutePhrases,
): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `Row ${row} of ${range} needs a page of ${needed} bytes with the page's own fields, more than this page's maxBytes of ${budget}; narrow the range's columns or lower maxCellChars${raiseBytes(needed, phrases)}.`,
  );
}

/** Refuse a page too small for even one range's own fields. */
function pageTooSmall(range: string, needed: number, budget: number, phrases: RoutePhrases): ConnectorCallError {
  return new ConnectorCallError(
    "invalid_args",
    `A page reporting ${range} needs ${needed} bytes before any of its rows, more than this page's maxBytes of ${budget}; shorten the range${raiseBytes(needed, phrases)}.`,
  );
}

function raiseBytes(needed: number, phrases: RoutePhrases): string {
  if (needed > MAX_PAGE_BYTES) return "";
  return needed <= DEFAULT_PAGE_BYTES
    ? `, or raise maxBytes to at least ${needed}`
    : `, or raise maxBytes to at least ${needed} (above ${DEFAULT_PAGE_BYTES}, ${phrases.onlyDirectRead}${phrases.program ? `: ${phrases.program} cannot receive it` : ""})`;
}

/** Refuse a row no page of `budget` cells can hold, rather than overrun the cap. */
function rowTooWide(range: string, row: number, width: number, budget: number): ConnectorCallError {
  const fix =
    width <= MAX_PAGE_CELLS
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

/** Refuse a raw request that is not exactly one known kind, unsent. */
function checkRequestKinds(requests: readonly unknown[]): void {
  for (const request of requests)
    for (const kind of Object.keys(asRecord(request)))
      if (Object.hasOwn(SHEETS_REFUSED_KINDS, kind))
        throw new ConnectorCallError("invalid_args", SHEETS_REFUSED_KINDS[kind]!);
  const problem = sheetsExternalDataProblem(requests);
  if (problem) throw new ConnectorCallError("invalid_args", problem);
  requests.forEach((request, index) => {
    const kinds = Object.keys(asRecord(request));
    if (kinds.length !== 1 || !SHEETS_ADMITTED_KINDS.includes(kinds[0]! as (typeof SHEETS_ADMITTED_KINDS)[number])) {
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
function uncertainWrite<A>(
  connection: Connection,
  advice: string,
  write: Effect.Effect<A, HttpFailure, CallServices>,
): Effect.Effect<A, HttpFailure, CallServices> {
  return write.pipe(
    Effect.catch((failure) => {
      const outcome = googleOutcomeOf(failure);
      return outcome?.dispatched && outcome.phase !== "refused"
        ? googleFailureMessage(connection, failure, (message) => `${message} ${advice}`)
        : Effect.fail(failure);
    }),
  );
}

// --- Raw batchUpdate replies -----------------------------------------------------

/** A string kept in a reply summary, cut so a long one cannot crowd out ids. */
const SUMMARY_TEXT_BYTES = 256;

/** The scalar fields of an object — ids, titles, counts — and nothing nested. */
function scalarsOf(ctx: ConnectorContext, value: unknown): JsonRecord | undefined {
  const scalars: JsonRecord = {};
  for (const [key, field] of Object.entries(asRecord(value))) {
    if (typeof field === "string") {
      scalars[key] = clampText(ctx, field, SUMMARY_TEXT_BYTES, (dropped) => `[… ${dropped} more characters]`);
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
function summarizeReply(ctx: ConnectorContext, reply: JsonRecord): JsonRecord {
  const kind = Object.keys(reply)[0];
  if (kind === undefined) return {};
  const body = asRecord(reply[kind]);
  const nested: JsonRecord = {};
  for (const [key, field] of Object.entries(body)) {
    if (field && typeof field === "object" && !Array.isArray(field)) nested[key] = scalarsOf(ctx, field);
  }
  return compact({ kind, ...scalarsOf(ctx, body), ...compact(nested) });
}

/**
 * A batchUpdate result that can be delivered. The write has already applied,
 * so whatever does not fit is summarized, never dropped silently and never
 * reported as a failure: replies are kept whole, in order, while the ones
 * after them still fit as summaries; the rest become summaries; and a reply
 * set too large even for that leaves the counts and where to re-read.
 */
function deliverableReplies(
  ctx: ConnectorContext,
  spreadsheetId: string,
  replies: JsonRecord[],
  requestCount: number,
): JsonRecord {
  const whole = { spreadsheetId, replies };
  if (jsonBytes(whole) <= RESULT_BUDGET_BYTES) return whole;
  const note = `All ${requestCount} requests applied. Replies too large to return here are cut to their kind, ids, and counts; read the spreadsheet with get_spreadsheet or get_values for the rest. Do not send the requests again.`;
  const summaries = replies.map((reply) => summarizeReply(ctx, reply));
  // What every reply from index i on costs as a summary, comma included.
  const rest = Array.from({ length: replies.length + 1 }, () => 0);
  for (let index = replies.length - 1; index >= 0; index -= 1) {
    rest[index] = rest[index + 1]! + jsonBytes(summaries[index]) + 1;
  }
  let bytes = jsonBytes({ spreadsheetId, replies: [], truncated: ["replies[]"], note });
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
    return { spreadsheetId, replies: kept, truncated: ["replies[]"], note };
  }
  return {
    spreadsheetId,
    replies: [],
    truncated: ["replies[]"],
    note: `All ${requestCount} requests applied, but their ${replies.length} replies are too large to return even summarized. Read the spreadsheet with get_spreadsheet or get_values to see the result. Do not send the requests again.`,
  };
}

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

export function sheetsTools({ connection }: { connection: Connection }): ApiTool[] {
  const client = googleClient(connection, sheetsIndex);
  const readOnly = { readOnlyHint: true } as const;
  // Additive: nothing that existed is lost. Writes require a writable
  // endpoint: call_destructive_tool or a program. The host controls approval.
  const additive = { readOnlyHint: false, destructiveHint: false } as const;
  const destructive = { readOnlyHint: false, destructiveHint: true } as const;
  const spreadsheetPath = (args: JsonRecord) => `/spreadsheets/${encodeURIComponent(String(args["spreadsheetId"]))}`;

  const declarations = [
    {
      name: "get_spreadsheet",
      description:
        "Get a spreadsheet's title, sheets (ids, titles, grid sizes), and named ranges as A1, never cell values. To find one by name, search Drive; Sheets cannot list.",
      annotations: readOnly,
      input: inputs.get_spreadsheet,
      output: outputs.get_spreadsheet,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const spreadsheet = asRecord(
            yield* client.json({
              method: "GET",
              path: spreadsheetPath(args),
              template: "/spreadsheets/{spreadsheetId}",
              query: { fields: SPREADSHEET_FIELDS },
            }),
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
            namedRanges:
              named.length > 0
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
            truncated: named.length > MAX_NAMED_RANGES ? ["namedRanges[]"] : undefined,
          });
        }),
    },
    {
      name: "get_values",
      description:
        "Read cell values from one or more A1 ranges as rows, paged by cell count. Long cells are cut with a marker; no formatting, notes, or formulas unless asked.",
      annotations: readOnly,
      input: inputs.get_values,
      output: outputs.get_values,
      run: (args: JsonRecord, ctx: ConnectorContext) =>
        Effect.gen(function* () {
          const ranges: string[] = args["ranges"];
          const budget: number = args["maxCells"] ?? DEFAULT_PAGE_CELLS;
          const byteBudget: number = args["maxBytes"] ?? DEFAULT_PAGE_BYTES;
          const cellChars: number = args["maxCellChars"] ?? DEFAULT_CELL_CHARS;
          const resume =
            typeof args["cursor"] === "string"
              ? decodeCursor(yield* boundCursor.decode("get_values", valuesCursorArgs(args), args["cursor"]), ranges)
              : { i: 0, s: 0 };
          // Every range sent is the caller's own, or the caller's own rewritten
          // to start further down; nothing in the cursor names a range.
          const rewritten = rangeAfter(ranges[resume.i]!, resume.s);
          const sent = [rewritten ?? ranges[resume.i]!, ...ranges.slice(resume.i + 1)];
          const skip = rewritten === undefined ? resume.s : 0;
          const response = asRecord(
            yield* client.json({
              method: "GET",
              path: `${spreadsheetPath(args)}/values:batchGet`,
              template: "/spreadsheets/{spreadsheetId}/values:batchGet",
              query: {
                ranges: sent,
                majorDimension: "ROWS",
                valueRenderOption: args["valueRenderOption"],
                dateTimeRenderOption: args["dateTimeRenderOption"],
              },
            }),
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
            truncated: ["valueRanges[].values"],
            page: {
              hasMore: false,
              nextCursor: yield* encodeCursor(ctx, args, { i: ranges.length - 1, s: Number.MAX_SAFE_INTEGER }),
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
            const entry = (kept: unknown[][]) =>
              compact({
                range: echoed,
                rowOffset: dropped > 0 ? dropped : undefined,
                values: kept,
                rowCount: kept.length,
              });
            // This range's own fields at their largest, and the comma before it;
            // an empty range costs them too.
            const fields =
              jsonBytes(
                compact({
                  range: echoed,
                  rowOffset: dropped > 0 ? dropped : undefined,
                  values: [],
                  rowCount: rows.length,
                }),
              ) + 1;
            if (bytes + fields > byteBudget) {
              if (valueRanges.length === 0) throw pageTooSmall(echoed, bytes + fields, byteBudget, routePhrases(ctx));
              next = { i: resume.i + index, s: before };
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
              const capped = asArray(row).map((cell) => cappedCell(ctx, cell, cellChars, rowCut));
              // The row as serialized, plus the comma before it.
              const size = jsonBytes(capped) + 1;
              if (bytes + size > byteBudget) {
                if (empty) throw rowTooLarge(echoed, dropped + 1, bytes + size, byteBudget, routePhrases(ctx));
                break;
              }
              cells += width;
              bytes += size;
              cut.cells += rowCut.cells;
              kept.push(capped);
            }
            if (kept.length < rows.length) {
              next = { i: resume.i + index, s: before + kept.length };
              // A range this page never reached is not reported half-read; the
              // next page starts it.
              if (kept.length > 0) valueRanges.push(entry(kept));
              break;
            }
            valueRanges.push(entry(kept));
            if (cells >= budget && index + 1 < returned.length) {
              next = { i: resume.i + index + 1, s: 0 };
            }
          }
          const nextCursor = next ? yield* encodeCursor(ctx, args, next) : null;
          return compact({
            spreadsheetId,
            valueRanges,
            cellCount: cells,
            truncated: cut.cells > 0 || next ? ["valueRanges[].values"] : undefined,
            page: compact({ hasMore: nextCursor !== null, nextCursor: nextCursor ?? undefined }),
          });
        }),
    },
    {
      name: "update_values",
      description:
        "Write rows of values into one A1 range, overwriting what is there. Cells past the given rows are untouched; to add rows below a table use append_values.",
      annotations: destructive,
      input: inputs.update_values,
      output: outputs.update_values,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          checkWriteSize([args["values"]]);
          const response = asRecord(
            yield* client.json({
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchUpdate`,
              template: "/spreadsheets/{spreadsheetId}/values:batchUpdate",
              body: {
                valueInputOption: args["valueInputOption"],
                data: [{ range: args["range"], majorDimension: "ROWS", values: args["values"] }],
                includeValuesInResponse: false,
              },
            }),
          );
          return {
            spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            ...projectUpdate(asArray(response["responses"])[0]),
          };
        }),
    },
    {
      name: "batch_update_values",
      description:
        "Write values into several A1 ranges in one call, overwriting each. All succeed or none do. For formatting or structure use batch_update_spreadsheet.",
      annotations: destructive,
      input: inputs.batch_update_values,
      output: outputs.batch_update_values,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const data = asArray(args["data"]).map(asRecord);
          checkWriteSize(data.map((entry) => entry["values"]));
          const response = asRecord(
            yield* client.json({
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchUpdate`,
              template: "/spreadsheets/{spreadsheetId}/values:batchUpdate",
              body: {
                valueInputOption: args["valueInputOption"],
                data: data.map((entry) => ({ range: entry["range"], majorDimension: "ROWS", values: entry["values"] })),
                includeValuesInResponse: false,
              },
            }),
          );
          return {
            spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            totalUpdatedRows: integer(response["totalUpdatedRows"]) ?? 0,
            totalUpdatedColumns: integer(response["totalUpdatedColumns"]) ?? 0,
            totalUpdatedCells: integer(response["totalUpdatedCells"]) ?? 0,
            totalUpdatedSheets: integer(response["totalUpdatedSheets"]) ?? 0,
            updates: asArray(response["responses"]).map(projectUpdate),
          };
        }),
    },
    {
      name: "append_values",
      description:
        "Append rows after the last row of the table in an A1 range, inserting new rows so nothing below is overwritten. Returns where they landed.",
      annotations: additive,
      input: inputs.append_values,
      output: outputs.append_values,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          checkWriteSize([args["values"]]);
          const response = asRecord(
            // A second call after one that landed adds the rows twice.
            yield* uncertainWrite(
              connection,
              "Appending again would add the rows a second time if the first append landed: read the table with get_values and append only what is missing.",
              client.json({
                method: "POST",
                path: `${spreadsheetPath(args)}/values/${encodeURIComponent(String(args["range"]))}:append`,
                template: "/spreadsheets/{spreadsheetId}/values/{range}:append",
                query: {
                  valueInputOption: args["valueInputOption"],
                  // Pinned: OVERWRITE writes over whatever sits below the table.
                  insertDataOption: "INSERT_ROWS",
                  includeValuesInResponse: false,
                },
                body: { majorDimension: "ROWS", values: args["values"] },
              }),
            ),
          );
          return compact({
            spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            tableRange: text(response["tableRange"]),
            ...projectUpdate(response["updates"]),
          });
        }),
    },
    {
      name: "clear_values",
      description:
        "Clear the values in one or more A1 ranges, keeping formatting, notes, and validation. The values are gone; nothing is deleted or shifted.",
      annotations: destructive,
      input: inputs.clear_values,
      output: outputs.clear_values,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const response = asRecord(
            yield* client.json({
              method: "POST",
              path: `${spreadsheetPath(args)}/values:batchClear`,
              template: "/spreadsheets/{spreadsheetId}/values:batchClear",
              body: { ranges: args["ranges"] },
            }),
          );
          return {
            spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            clearedRanges: asArray(response["clearedRanges"]).filter((range) => typeof range === "string"),
          };
        }),
    },
    {
      name: "create_spreadsheet",
      description:
        "Create a new spreadsheet in the user's My Drive root, optionally with named sheets. It is not shared or moved; that is Drive's job.",
      annotations: additive,
      input: inputs.create_spreadsheet,
      output: outputs.create_spreadsheet,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const titles: string[] | undefined = args["sheetTitles"];
          const spreadsheet = asRecord(
            // A spreadsheet that may exist has no id to re-read; only its title
            // can find it, and Sheets cannot search.
            yield* uncertainWrite(
              connection,
              "Search Drive for this title before creating it again, or a second spreadsheet results.",
              client.json({
                method: "POST",
                path: "/spreadsheets",
                template: "/spreadsheets",
                query: { fields: "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)" },
                body: compact({
                  properties: { title: args["title"] },
                  sheets: titles?.map((title) => ({ properties: { title } })),
                }),
              }),
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
        }),
    },
    {
      name: "add_sheet",
      description:
        "Add a new, empty sheet tab to a spreadsheet. Fails if the title is taken; it never renames, replaces, or copies an existing sheet.",
      annotations: additive,
      input: inputs.add_sheet,
      output: outputs.add_sheet,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const grid = compact({ rowCount: args["rowCount"], columnCount: args["columnCount"] });
          const response = asRecord(
            yield* client.json({
              method: "POST",
              path: `${spreadsheetPath(args)}:batchUpdate`,
              template: "/spreadsheets/{spreadsheetId}:batchUpdate",
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
            }),
          );
          const added = asRecord(asRecord(asArray(response["replies"])[0])["addSheet"]);
          return {
            spreadsheetId: text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            ...projectSheet(added),
          };
        }),
    },
    {
      name: "batch_update_spreadsheet",
      description:
        "Apply Sheets batchUpdate requests — formatting, merges, sorts, deleting sheets or rows, protections — atomically. This named structural workflow can destroy data.",
      // Destructive, whatever the requests are: they can delete sheets, rows,
      // ranges, and protections, and connecta does not read them to guess.
      annotations: destructive,
      input: inputs.batch_update_spreadsheet,
      output: outputs.batch_update_spreadsheet,
      run: (args: JsonRecord, ctx: ConnectorContext) =>
        Effect.gen(function* () {
          checkRequestKinds(args["requests"]);
          const response = asRecord(
            yield* client.json({
              method: "POST",
              path: `${spreadsheetPath(args)}:batchUpdate`,
              template: "/spreadsheets/{spreadsheetId}:batchUpdate",
              body: { requests: args["requests"], includeSpreadsheetInResponse: false },
            }),
          );
          return deliverableReplies(
            ctx,
            text(response["spreadsheetId"]) ?? args["spreadsheetId"],
            asArray(response["replies"]).map(asRecord),
            asArray(args["requests"]).length,
          );
        }),
    },
  ];
  return declarations.map((declaration) => {
    const spec = {
      name: declaration.name,
      description: declaration.description,
      input: declaration.input,
      output: declaration.output,
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const current = yield* Effect.serviceOption(Operation);
          if (Option.isNone(current) || !current.value)
            return yield* Effect.die(new Error("Sheets tools require a call context."));
          return yield* declaration.run(args, current.value);
        }).pipe(
          Effect.catchDefect((defect) =>
            defect instanceof ConnectorCallError ? Effect.fail(new Refusal({ error: defect })) : Effect.die(defect),
          ),
        ),
    };
    if (!declaration.annotations.readOnlyHint)
      return write(connection, { ...spec, destructive: declaration.annotations.destructiveHint });
    const contract = fieldsContract(
      "result",
      declaration.output,
      "Truncation and content continuation metadata remain available.",
    );
    return read(connection, {
      ...spec,
      input: Schema.Struct({ ...declaration.input.fields, fields: Schema.optionalKey(contract.input) }),
      run: (args: JsonRecord) =>
        Effect.gen(function* () {
          const { fields, ...rest } = args;
          const problem = contract.problem(fields);
          if (problem) return yield* Effect.fail(new Refusal({ error: problem }));
          const result: JsonRecord = yield* spec.run(rest);
          return {
            ...(selectFields(result, fields) as JsonRecord),
            ...(result["truncated"] ? { truncated: result["truncated"] } : {}),
            ...(declaration.name === "get_values" ? { page: result["page"] } : {}),
          };
        }),
    });
  });
}
