import { codePoints } from "../../../http/json-schema.js";
import type { Connection } from "../../../http/vendor.js";
import { googleBatchGuard, googleHatchBinding } from "../../_shared/google/hatch.js";
import { OperationIndex } from "../../_shared/rest/operation-index.js";
import type { RestCall } from "../../_shared/rest/tools.js";
import { openapi } from "../openapi.generated.js";
import { SHEETS_ADMITTED_KINDS, SHEETS_REFUSED_KINDS, sheetsExternalDataProblem } from "./requests.js";

export const sheetsIndex = new OperationIndex(openapi, {
  vendor: "sheets",
  title: "Google Sheets",
  pathMatching: "uri-template",
});

/** Decode range colons only. Encoded actions, ids and unreserved bytes still fail the shared backstop. */
export function sheetsPath(path: string): string {
  const match = /^(\/spreadsheets\/[A-Za-z0-9_-]+\/values\/)([^/?#]+)$/.exec(path);
  if (!match) return path;
  const tail = match[2]!;
  const action = /:(append|clear)$/.exec(tail)?.[0] ?? "";
  const range = action ? tail.slice(0, -action.length) : tail;
  // An encoded trailing action could change the matched method; preserve its refusal.
  if (/%3a(?:append|clear)$/i.test(range)) return path;
  return `${match[1]}${range.replace(/%3a/gi, ":")}${action}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Same scalar, range and write-cell ceilings as the named workflows, including filter-selected writes. */
export function sheetsRequestProblem(
  call: Pick<RestCall, "method" | "op" | "query" | "body" | "params">,
): string | undefined {
  const body = record(call.body);
  if (call.op.path === "/spreadsheets/{spreadsheetId}:batchUpdate") {
    const requests = body["requests"];
    if (Array.isArray(requests))
      for (const request of requests) {
        for (const kind of Object.keys(record(request)))
          if (SHEETS_REFUSED_KINDS[kind]) return SHEETS_REFUSED_KINDS[kind];
      }
    const problem = googleBatchGuard(body, { kinds: SHEETS_ADMITTED_KINDS, revision: false });
    if (problem) return problem;
  }
  if (
    call.method !== "GET" &&
    SHEETS_HATCH.verdicts[`${call.method} ${call.op.path}` as keyof typeof SHEETS_HATCH.verdicts] !== "read"
  ) {
    const problem = sheetsExternalDataProblem(body);
    if (problem) return problem;
  }
  const isValue = call.op.path.includes("/values");
  for (const [key, max] of [
    ["ranges", 20],
    ["dataFilters", 20],
    ["data", 100],
  ] as const) {
    const list = body[key] ?? call.query[key];
    if (Array.isArray(list) && (!list.length || list.length > max)) return `${key} needs 1–${max} entries.`;
  }
  const rangeProblem = (value: unknown) =>
    typeof value !== "string" ||
    !value.length ||
    codePoints(value) > 512 ||
    /[\r\n]/.test(value) ||
    /^\.+$/.test(value);
  const ranges = [
    ...(Array.isArray(body["ranges"]) ? body["ranges"] : []),
    ...(Array.isArray(call.query["ranges"]) ? call.query["ranges"] : []),
  ];
  if (call.params["range"] !== undefined) ranges.push(call.params["range"]);
  if (ranges.some(rangeProblem)) return "Ranges must be nonempty single-line A1 strings of at most 512 characters.";
  let cells = 0;
  const stack: unknown[] = [body];
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const obj = record(value);
    if (typeof obj["a1Range"] === "string" && rangeProblem(obj["a1Range"]))
      return "Data-filter A1 ranges must be nonempty single-line strings of at most 512 characters.";
    if (isValue && obj["range"] !== undefined && rangeProblem(obj["range"]))
      return "Value ranges must be nonempty single-line strings of at most 512 characters.";
    if (isValue && obj["values"] !== undefined) {
      const rows = obj["values"];
      if (!Array.isArray(rows) || !rows.length || rows.length > (obj["majorDimension"] === "COLUMNS" ? 18278 : 10000))
        return "Values need 1–10000 rows or columns.";
      for (const row of rows) {
        if (!Array.isArray(row) || row.length > (obj["majorDimension"] === "COLUMNS" ? 10000 : 18278))
          return "Values must be a bounded two-dimensional cell array.";
        cells += row.length;
        for (const cell of row)
          if (
            !(
              cell === null ||
              typeof cell === "boolean" ||
              (typeof cell === "number" && Number.isFinite(cell)) ||
              (typeof cell === "string" && codePoints(cell) <= 50000)
            )
          )
            return "Cells must be scalar strings (at most 50000 characters), finite numbers, booleans or null.";
      }
      if (cells > 50000) return "A values write carries at most 50000 cells; split it into several calls.";
    }
    stack.push(...Object.values(obj));
  }
  return undefined;
}

export function sheetsBinding(connection: Connection) {
  return {
    ...googleHatchBinding(connection, {
      index: sheetsIndex,
      review:
        "Seventeen explicitly reviewed Sheets JSON methods, seven reads including three side-effect-free POST reads; bounded scalar value writes and reviewed non-preview batch kinds, delegated subject and permanent value safety.",
      refuse: sheetsRequestProblem,
    }),
    path: sheetsPath,
  };
}

export const SHEETS_HATCH = {
  name: "sheets",
  title: "Google Sheets",
  index: sheetsIndex,
  pathExample: "/spreadsheets/sheet_123",
  verdicts: {
    "GET /spreadsheets/{spreadsheetId}": "read",
    "GET /spreadsheets/{spreadsheetId}/developerMetadata/{metadataId}": "read",
    "POST /spreadsheets/{spreadsheetId}/developerMetadata:search": "read",
    "POST /spreadsheets/{spreadsheetId}:getByDataFilter": "read",
    "GET /spreadsheets/{spreadsheetId}/values/{range}": "read",
    "GET /spreadsheets/{spreadsheetId}/values:batchGet": "read",
    "POST /spreadsheets/{spreadsheetId}/values:batchGetByDataFilter": "read",
    "POST /spreadsheets": "write",
    "POST /spreadsheets/{spreadsheetId}:batchUpdate": "destructive",
    "POST /spreadsheets/{spreadsheetId}/sheets/{sheetId}:copyTo": "write",
    "PUT /spreadsheets/{spreadsheetId}/values/{range}": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values/{range}:append": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values/{range}:clear": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values:batchUpdate": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values:batchUpdateByDataFilter": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values:batchClear": "destructive",
    "POST /spreadsheets/{spreadsheetId}/values:batchClearByDataFilter": "destructive",
  },
  named: {
    "GET /spreadsheets/{spreadsheetId}": "get_spreadsheet",
    "GET /spreadsheets/{spreadsheetId}/values:batchGet": "get_values",
    "POST /spreadsheets": "create_spreadsheet",
    "POST /spreadsheets/{spreadsheetId}:batchUpdate": "batch_update_spreadsheet",
    "POST /spreadsheets/{spreadsheetId}/values/{range}:append": "append_values",
    "POST /spreadsheets/{spreadsheetId}/values:batchUpdate": "batch_update_values",
    "POST /spreadsheets/{spreadsheetId}/values:batchClear": "clear_values",
  },
} as const;
