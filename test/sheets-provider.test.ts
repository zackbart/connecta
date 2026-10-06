// The Google Sheets connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the pages and caps it reads
// under, and the safety class of every tool — H1, H9, H10, and H11 for this
// provider. Delegation, subjects, and tokens are
// test/google-workspace-delegation.test.ts; only the no-caller refusal is
// repeated here, because it is this connector's own front door.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHEETS_API_BASE_URL, SHEETS_SCOPES, sheets } from "../src/providers/sheets.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../src/types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;

interface ApiCall {
  url: URL;
  method: string;
  body: any;
}

type Route = (call: ApiCall) => { status?: number; body?: unknown } | undefined;

const calls: ApiCall[] = [];
let tokenRequests = 0;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  tokenRequests = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenRequests += 1;
      return Response.json({ access_token: "token", expires_in: 3599 });
    }
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return sheets("sheets", {
    purpose: "Finance and attendance spreadsheets",
    serviceAccount: { clientEmail: `sheets-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "treasurer@church.example",
    ...overrides,
  } as Parameters<typeof sheets>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

/** The request path below the API root, percent-escapes as sent. */
const path = (index: number) => calls[index]!.url.pathname.replace(/^\/v4/, "");

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

describe("sheets() identity and surface (H1)", () => {
  it("requires a purpose and names the routing fact in title, description, and guide", () => {
    expect(() => connection({ purpose: "  " })).toThrow(/purpose/);
    const connector = connection({ instructions: "The budget lives in the 2026 Budget spreadsheet." });
    expect(connector.title).toBe("Google Sheets");
    expect(connector.description).toContain("signed-in Workspace user");
    expect(connector.description).toContain("Finance and attendance spreadsheets");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line && !line.startsWith("#"))).toMatch(/only spreadsheets they can open/);
    expect(content).toContain("Drive");
    expect(content).toContain("last-writer-wins");
    expect(content).toContain("## Connection instructions\n\nThe budget lives in the 2026 Budget spreadsheet.");
    expect(guide(connector).required).toBe(true);
  });

  it("ships exactly its tools, each with its safety class, and never exempts itself", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(annotations).toEqual({
      get_spreadsheet: { readOnlyHint: true },
      get_values: { readOnlyHint: true },
      update_values: { readOnlyHint: false, destructiveHint: true },
      batch_update_values: { readOnlyHint: false, destructiveHint: true },
      append_values: { readOnlyHint: false, destructiveHint: false },
      clear_values: { readOnlyHint: false, destructiveHint: true },
      create_spreadsheet: { readOnlyHint: false, destructiveHint: false },
      add_sheet: { readOnlyHint: false, destructiveHint: false },
      batch_update_spreadsheet: { readOnlyHint: false, destructiveHint: true },
    });
    expect(tools.filter((tool) => isExplicitlyReadOnly(tool)).map((tool) => tool.name).sort()).toEqual([
      "get_spreadsheet",
      "get_values",
    ]);
    // No listing tool: finding a spreadsheet by name is Drive's job.
    expect(tools.some((tool) => /^(list|search)_/.test(tool.name))).toBe(false);
    expect(connector.approval).toBeUndefined();
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly the spreadsheets scope", async () => {
    expect([...SHEETS_SCOPES]).toEqual(["https://www.googleapis.com/auth/spreadsheets"]);
    route = () => ({ body: { spreadsheetId: ID } });
    await call(connection(), "get_spreadsheet", { spreadsheetId: ID });
    const assertion = (globalThis.fetch as any).mock.calls.find(([url]: [string]) => url === TOKEN_URL)[1].body;
    const jwt = new URLSearchParams(String(assertion)).get("assertion")!;
    const claims = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.scope).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(claims.sub).toBe("treasurer@church.example");
  });

  it("fails auth_required with no network when a mapped subject has no caller", async () => {
    const connector = connection({ subject: () => "treasurer@church.example" });
    await expect(call(connector, "get_values", { spreadsheetId: ID, ranges: ["A1"] })).rejects.toMatchObject({
      code: "auth_required",
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(tokenRequests).toBe(0);
  });
});

describe("reading a spreadsheet's shape (H9)", () => {
  it("asks for metadata only and projects sheets and named ranges as A1", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
        properties: { title: "2026 Budget", locale: "en_US", timeZone: "America/Chicago", defaultFormat: { noise: true } },
        sheets: [
          // The first sheet's id and index are 0, which Google leaves out.
          { properties: { title: "Summary", sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26, frozenRowCount: 1 } } },
          { properties: { sheetId: 7, title: "Q3 Budget", index: 1, sheetType: "GRID", hidden: true, gridProperties: { rowCount: 500, columnCount: 8 } } },
        ],
        namedRanges: [
          { namedRangeId: "n1", name: "Totals", range: { endRowIndex: 5, endColumnIndex: 3 } },
          { namedRangeId: "n2", name: "Spend", range: { sheetId: 7, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 4 } },
          { namedRangeId: "n3", name: "Whole", range: { sheetId: 7 } },
          { namedRangeId: "n4", name: "Rows", range: { sheetId: 7, startRowIndex: 2, endRowIndex: 9 } },
          { namedRangeId: "n5", name: "Odd", range: { sheetId: 7, startColumnIndex: 2, endRowIndex: 9 } },
        ],
      },
    });
    const result = await call(connection(), "get_spreadsheet", { spreadsheetId: ID });
    expect(calls[0]!.method).toBe("GET");
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(`${SHEETS_API_BASE_URL}/spreadsheets/${ID}`);
    const fields = calls[0]!.url.searchParams.get("fields")!;
    expect(fields).toContain("sheets.properties(");
    expect(fields).toContain("namedRanges(");
    expect(fields).not.toMatch(/data|includeGridData/);
    expect(result).toEqual({
      spreadsheetId: ID,
      title: "2026 Budget",
      url: `https://docs.google.com/spreadsheets/d/${ID}/edit`,
      locale: "en_US",
      timeZone: "America/Chicago",
      sheets: [
        { sheetId: 0, title: "Summary", index: 0, type: "GRID", rowCount: 1000, columnCount: 26, frozenRowCount: 1 },
        { sheetId: 7, title: "Q3 Budget", index: 1, type: "GRID", hidden: true, rowCount: 500, columnCount: 8 },
      ],
      namedRanges: [
        { namedRangeId: "n1", name: "Totals", sheetId: 0, range: "Summary!A1:C5" },
        { namedRangeId: "n2", name: "Spend", sheetId: 7, range: "'Q3 Budget'!B2:D" },
        { namedRangeId: "n3", name: "Whole", sheetId: 7, range: "'Q3 Budget'" },
        { namedRangeId: "n4", name: "Rows", sheetId: 7, range: "'Q3 Budget'!3:9" },
        // Not expressible in A1; the sheet id still says where it is.
        { namedRangeId: "n5", name: "Odd", sheetId: 7 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("noise");
  });

  it("caps named ranges and says how many it left out", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        sheets: [{ properties: { title: "S" } }],
        namedRanges: Array.from({ length: 205 }, (_, index) => ({ namedRangeId: `n${index}`, name: `R${index}`, range: {} })),
      },
    });
    const result = await call(connection(), "get_spreadsheet", { spreadsheetId: ID });
    expect(result.namedRanges).toHaveLength(200);
    expect(result.namedRangesOmitted).toBe(5);
  });

  it("returns Google's untouched metadata on raw: true, still without grid data", async () => {
    const body = { spreadsheetId: ID, properties: { title: "T", defaultFormat: { x: 1 } }, sheets: [] };
    route = () => ({ body });
    const result = await call(connection(), "get_spreadsheet", { spreadsheetId: ID, raw: true });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ includeGridData: "false" });
    expect(result).toEqual(body);
  });
});

describe("reading values (H9, H10)", () => {
  it("batch-reads ranges as rows with the render options it was given", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        valueRanges: [
          { range: "Summary!A1:C3", majorDimension: "ROWS", values: [["Item", "Q3"], ["Rent", 1200], [], ] },
          { range: "'Q3 Budget'!B1:B1000", majorDimension: "ROWS" },
        ],
      },
    });
    const result = await call(connection(), "get_values", {
      spreadsheetId: ID,
      ranges: ["Summary!A1:C3", "'Q3 Budget'!B:B"],
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });
    expect(path(0)).toBe(`/spreadsheets/${ID}/values:batchGet`);
    const query = calls[0]!.url.searchParams;
    expect(query.getAll("ranges")).toEqual(["Summary!A1:C3", "'Q3 Budget'!B:B"]);
    expect(query.get("majorDimension")).toBe("ROWS");
    expect(query.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(query.get("dateTimeRenderOption")).toBe("FORMATTED_STRING");
    expect(result).toEqual({
      spreadsheetId: ID,
      valueRanges: [
        { range: "Summary!A1:C3", values: [["Item", "Q3"], ["Rent", 1200], []], rowCount: 3 },
        { range: "'Q3 Budget'!B1:B1000", values: [], rowCount: 0 },
      ],
      cellCount: 5,
      page: { hasMore: false, nextCursor: null },
    });
  });

  it("pages by cell count, resuming a cut range where it stopped and then the ranges after it", async () => {
    const rows = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => [`r${from + index}`, from + index]);
    route = (request) => {
      const asked = request.url.searchParams.getAll("ranges");
      return {
        body: {
          spreadsheetId: ID,
          valueRanges: asked.map((range) =>
            range === "Data!A1:B10" || range === "Data"
              ? { range: "Data!A1:B10", values: rows(1, 10) }
              : range === "Data!A4:B10"
                ? { range: "Data!A4:B10", values: rows(4, 7) }
                : { range: "Other!A1:A2", values: [["x"], ["y"]] },
          ),
        },
      };
    };
    const connector = connection();
    const ranges = ["Data", "Other!A1:A2"];

    const first = await call(connector, "get_values", { spreadsheetId: ID, ranges, maxCells: 6 });
    expect(first.valueRanges).toEqual([
      { range: "Data!A1:B10", values: rows(1, 3), rowCount: 3, truncated: true, omittedRows: 7 },
    ]);
    expect(first.cellCount).toBe(6);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    calls.length = 0;
    const second = await call(connector, "get_values", { spreadsheetId: ID, ranges, maxCells: 20, cursor: first.page.nextCursor });
    // The cut range is rewritten to start past what was returned.
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Data!A4:B10", "Other!A1:A2"]);
    expect(second.valueRanges).toEqual([
      { range: "Data!A4:B10", values: rows(4, 7), rowCount: 7 },
      { range: "Other!A1:A2", values: [["x"], ["y"]], rowCount: 2 },
    ]);
    expect(second.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("starts an unreached range over on the next page rather than reporting it half-read", async () => {
    route = (request) => ({
      body: {
        valueRanges: request.url.searchParams.getAll("ranges").map((range) =>
          range === "A!A1:B2" ? { range, values: [[1, 2], [3, 4]] } : { range: "B!A1:C1", values: [[5, 6, 7]] },
        ),
      },
    });
    const ranges = ["A!A1:B2", "B!A1:C1"];
    const first = await call(connection(), "get_values", { spreadsheetId: ID, ranges, maxCells: 4 });
    expect(first.valueRanges).toEqual([{ range: "A!A1:B2", values: [[1, 2], [3, 4]], rowCount: 2 }]);
    expect(first.spreadsheetId).toBe(ID);
    expect(first.page.hasMore).toBe(true);
    calls.length = 0;
    const second = await call(connection(), "get_values", { spreadsheetId: ID, ranges, maxCells: 4, cursor: first.page.nextCursor });
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["B!A1:C1"]);
    expect(second.valueRanges).toEqual([{ range: "B!A1:C1", values: [[5, 6, 7]], rowCount: 1 }]);
    expect(second.page.hasMore).toBe(false);
  });

  it("resends and skips when Google's echoed range cannot be rewritten", async () => {
    route = () => ({ body: { valueRanges: [{ range: "Odd", values: [[1], [2], [3]] }] } });
    const first = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["Odd"], maxCells: 2 });
    expect(first.valueRanges[0]).toMatchObject({ values: [[1], [2]], truncated: true, omittedRows: 1 });
    calls.length = 0;
    const second = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["Odd"], maxCells: 2, cursor: first.page.nextCursor });
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Odd"]);
    expect(second.valueRanges).toEqual([{ range: "Odd", values: [[3]], rowCount: 1 }]);
    expect(second.page.hasMore).toBe(false);
  });

  it("cuts a long cell with a marker in the text and counts it", async () => {
    route = () => ({ body: { valueRanges: [{ range: "S!A1:B1", values: [["x".repeat(5_010), "short"]] }] } });
    const result = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["S!A1:B1"] });
    expect(result.valueRanges[0].values[0][0]).toBe(`${"x".repeat(5_000)}[… 10 more characters truncated]`);
    expect(result.valueRanges[0].values[0][1]).toBe("short");
    expect(result.truncatedCells).toBe(1);
  });

  it("refuses a cursor from other ranges, or no cursor at all, before any request", async () => {
    route = () => ({ body: { valueRanges: [{ range: "S!A1:A3", values: [[1], [2], [3]] }] } });
    const first = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["S!A1:A3"], maxCells: 1 });
    calls.length = 0;
    for (const args of [
      { ranges: ["S!A1:A3", "T!A1"], cursor: first.page.nextCursor },
      { ranges: ["S!A1:A3"], cursor: "not-a-cursor" },
    ]) {
      await expect(call(connection(), "get_values", { spreadsheetId: ID, ...args })).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
  });
});

describe("writing values", () => {
  it("updates one range through values:batchUpdate, overwriting it", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        totalUpdatedCells: 4,
        responses: [{ spreadsheetId: ID, updatedRange: "Summary!A1:B2", updatedRows: 2, updatedColumns: 2, updatedCells: 4 }],
      },
    });
    const result = await call(connection(), "update_values", {
      spreadsheetId: ID,
      range: "Summary!A1",
      values: [["Item", "=SUM(B2:B9)"], [null, ""]],
      valueInputOption: "USER_ENTERED",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe(`/spreadsheets/${ID}/values:batchUpdate`);
    expect(calls[0]!.body).toEqual({
      valueInputOption: "USER_ENTERED",
      data: [{ range: "Summary!A1", majorDimension: "ROWS", values: [["Item", "=SUM(B2:B9)"], [null, ""]] }],
      includeValuesInResponse: false,
    });
    expect(result).toEqual({ spreadsheetId: ID, updatedRange: "Summary!A1:B2", updatedRows: 2, updatedColumns: 2, updatedCells: 4 });
  });

  it("requires a valueInputOption rather than choosing one", async () => {
    await expect(
      call(connection(), "update_values", { spreadsheetId: ID, range: "A1", values: [["x"]] }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("writes several ranges in one call and reports each", async () => {
    route = () => ({
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
    });
    const result = await call(connection(), "batch_update_values", {
      spreadsheetId: ID,
      valueInputOption: "RAW",
      data: [
        { range: "A!A1", values: [[1, true]] },
        { range: "B!A1", values: [["x"], ["y"]] },
      ],
    });
    expect(calls[0]!.body).toEqual({
      valueInputOption: "RAW",
      data: [
        { range: "A!A1", majorDimension: "ROWS", values: [[1, true]] },
        { range: "B!A1", majorDimension: "ROWS", values: [["x"], ["y"]] },
      ],
      includeValuesInResponse: false,
    });
    expect(result).toEqual({
      spreadsheetId: ID,
      totalUpdatedRows: 3,
      totalUpdatedColumns: 2,
      totalUpdatedCells: 4,
      totalUpdatedSheets: 2,
      updates: [
        { updatedRange: "A!A1:B1", updatedRows: 1, updatedColumns: 2, updatedCells: 2 },
        { updatedRange: "B!A1:A2", updatedRows: 2, updatedColumns: 1, updatedCells: 2 },
      ],
    });
  });

  it("refuses a write past connecta's cell cap, unsent", async () => {
    const wide = Array.from({ length: 6 }, () => Array.from({ length: 9_000 }, () => 1));
    const failure = await call(connection(), "update_values", {
      spreadsheetId: ID,
      range: "A1",
      values: wide,
      valueInputOption: "RAW",
    }).catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(failure.message).toContain("Nothing was written");
    expect(calls).toEqual([]);
  });

  it("appends below the table with INSERT_ROWS pinned, the range escaped into the path", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        tableRange: "'Q3 Budget'!A1:D20",
        updates: { spreadsheetId: ID, updatedRange: "'Q3 Budget'!A21:D21", updatedRows: 1, updatedColumns: 4, updatedCells: 4 },
      },
    });
    const result = await call(connection(), "append_values", {
      spreadsheetId: ID,
      range: "'Q3 Budget'!A:D",
      values: [["2026-10-06", "Rent", 1200, "paid"]],
      valueInputOption: "USER_ENTERED",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe(`/spreadsheets/${ID}/values/'Q3%20Budget'!A%3AD:append`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      includeValuesInResponse: "false",
    });
    expect(calls[0]!.body).toEqual({ majorDimension: "ROWS", values: [["2026-10-06", "Rent", 1200, "paid"]] });
    expect(result).toEqual({
      spreadsheetId: ID,
      tableRange: "'Q3 Budget'!A1:D20",
      updatedRange: "'Q3 Budget'!A21:D21",
      updatedRows: 1,
      updatedColumns: 4,
      updatedCells: 4,
    });
  });

  it("offers no OVERWRITE append, and refuses a range that is only dots", async () => {
    const base = { spreadsheetId: ID, values: [["x"]], valueInputOption: "RAW" };
    await expect(
      call(connection(), "append_values", { ...base, range: "A1", insertDataOption: "OVERWRITE" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    for (const range of [".", ".."]) {
      await expect(call(connection(), "append_values", { ...base, range })).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    await expect(
      call(connection(), "get_spreadsheet", { spreadsheetId: "../drive/v3/files" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("clears values in several ranges", async () => {
    route = () => ({ body: { spreadsheetId: ID, clearedRanges: ["A!A1:B9", "B!C1:C1000"] } });
    const result = await call(connection(), "clear_values", { spreadsheetId: ID, ranges: ["A!A1:B9", "B!C:C"] });
    expect(path(0)).toBe(`/spreadsheets/${ID}/values:batchClear`);
    expect(calls[0]!.body).toEqual({ ranges: ["A!A1:B9", "B!C:C"] });
    expect(result).toEqual({ spreadsheetId: ID, clearedRanges: ["A!A1:B9", "B!C1:C1000"] });
  });
});

describe("creating spreadsheets and sheets", () => {
  it("creates a spreadsheet with named tabs and reads back only its ids", async () => {
    route = () => ({
      body: {
        spreadsheetId: "new-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/new-1/edit",
        properties: { title: "Attendance 2026" },
        sheets: [{ properties: { title: "Sundays" } }, { properties: { sheetId: 42, title: "Midweek" } }],
      },
    });
    const result = await call(connection(), "create_spreadsheet", {
      title: "Attendance 2026",
      sheetTitles: ["Sundays", "Midweek"],
    });
    expect(calls[0]!.method).toBe("POST");
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(`${SHEETS_API_BASE_URL}/spreadsheets`);
    expect(calls[0]!.url.searchParams.get("fields")).toBe(
      "spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)",
    );
    expect(calls[0]!.body).toEqual({
      properties: { title: "Attendance 2026" },
      sheets: [{ properties: { title: "Sundays" } }, { properties: { title: "Midweek" } }],
    });
    expect(result).toEqual({
      spreadsheetId: "new-1",
      title: "Attendance 2026",
      url: "https://docs.google.com/spreadsheets/d/new-1/edit",
      sheets: [
        { sheetId: 0, title: "Sundays" },
        { sheetId: 42, title: "Midweek" },
      ],
    });
  });

  it("creates a spreadsheet with Google's default sheet when none is named", async () => {
    route = () => ({ body: { spreadsheetId: "new-2", properties: { title: "T" }, sheets: [{ properties: { title: "Sheet1" } }] } });
    await call(connection(), "create_spreadsheet", { title: "T" });
    expect(calls[0]!.body).toEqual({ properties: { title: "T" } });
  });

  it("adds a sheet through one addSheet request", async () => {
    route = () => ({
      body: {
        spreadsheetId: ID,
        replies: [
          { addSheet: { properties: { sheetId: 99, title: "Q4", index: 2, sheetType: "GRID", gridProperties: { rowCount: 100, columnCount: 6 } } } },
        ],
      },
    });
    const result = await call(connection(), "add_sheet", {
      spreadsheetId: ID,
      title: "Q4",
      index: 2,
      rowCount: 100,
      columnCount: 6,
    });
    expect(path(0)).toBe(`/spreadsheets/${ID}:batchUpdate`);
    expect(calls[0]!.body).toEqual({
      requests: [{ addSheet: { properties: { title: "Q4", index: 2, gridProperties: { rowCount: 100, columnCount: 6 } } } }],
    });
    expect(result).toEqual({
      spreadsheetId: ID,
      sheetId: 99,
      title: "Q4",
      index: 2,
      type: "GRID",
      rowCount: 100,
      columnCount: 6,
    });

    calls.length = 0;
    await call(connection(), "add_sheet", { spreadsheetId: ID, title: "Bare" });
    expect(calls[0]!.body).toEqual({ requests: [{ addSheet: { properties: { title: "Bare" } } }] });
  });
});

describe("the raw batchUpdate hatch", () => {
  it("passes requests through untouched and returns the replies", async () => {
    const requests = [
      { deleteDimension: { range: { sheetId: 7, dimension: "ROWS", startIndex: 3, endIndex: 9 } } },
      { repeatCell: { range: { sheetId: 7 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
    ];
    route = () => ({ body: { spreadsheetId: ID, replies: [{}, {}] } });
    const result = await call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests });
    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe(`/spreadsheets/${ID}:batchUpdate`);
    expect(calls[0]!.body).toEqual({ requests, includeSpreadsheetInResponse: false });
    expect(result).toEqual({ spreadsheetId: ID, replies: [{}, {}] });
  });

  it("refuses a request object that sets no kind, two, or one Sheets does not have, unsent", async () => {
    for (const requests of [
      [{}],
      [{ addSheet: {}, deleteSheet: {} }],
      [],
      [{ repeatCell: {} }, { dropEverything: {} }],
      Array.from({ length: 101 }, () => ({ addSheet: {} })),
    ]) {
      await expect(
        call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
  });
});

describe("errors (H11)", () => {
  it("never calls a 404 absent: the spreadsheet may exist and not be shared", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
    const failure = await call(connection(), "get_spreadsheet", { spreadsheetId: ID }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.code).not.toBe("not_found");
    expect(failure.message).toContain("not visible to this account");
  });

  it("maps a refused share to connector_call_failed and a bad range to invalid_args", async () => {
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } },
    });
    await expect(call(connection(), "get_values", { spreadsheetId: ID, ranges: ["A1"] })).rejects.toMatchObject({
      code: "connector_call_failed",
    });
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Unable to parse range: Nope!A1", status: "INVALID_ARGUMENT" } },
    });
    const failure = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["Nope!A1"] }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).toContain("Unable to parse range");
  });

  it("names the Sheets API when it is not enabled, and the scope when it is missing", async () => {
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Google Sheets API has not been used", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } },
    });
    const disabled = await call(connection(), "get_spreadsheet", { spreadsheetId: ID }).catch((error) => error);
    expect(disabled.message).toContain("Google Sheets API is not enabled");
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Insufficient scopes", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    });
    const scope = await call(connection(), "get_spreadsheet", { spreadsheetId: ID }).catch((error) => error);
    expect(scope.code).toBe("auth_required");
    expect(scope.message).toContain("https://www.googleapis.com/auth/spreadsheets");
  });
});
