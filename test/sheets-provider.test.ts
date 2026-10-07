// The Google Sheets connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the pages and caps it reads
// under, and the safety class of every tool — H1, H9, H10, and H11 for this
// provider. Delegation, subjects, and tokens are
// test/google-workspace-delegation.test.ts; only the no-caller refusal is
// repeated here, because it is this connector's own front door.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUICKJS_HOST_RPC_BYTES } from "../src/executors/quickjs-protocol.js";
import { RESULT_BUDGET_BYTES } from "../src/providers/google/result-size.js";
import { createMetaTools } from "../src/meta-tools.js";
import { SHEETS_API_BASE_URL, SHEETS_SCOPES, sheets } from "../src/providers/sheets.js";
import { Registry } from "../src/registry.js";
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

/** A JSON reply, or a hand-built Response (`raw`) for a reply that breaks. */
type Route = (call: ApiCall) => { status?: number; body?: unknown; raw?: () => Response } | undefined;

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
    if (reply.raw) return reply.raw();
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
      // Titles are always quoted: a bare whole-sheet title is a name Google
      // resolves to a same-named named range first.
      namedRanges: [
        { namedRangeId: "n1", name: "Totals", sheetId: 0, range: "'Summary'!A1:C5" },
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

  const rows = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => [`r${from + index}`, from + index]);

  /** Google's batchGet over a ten-row Data sheet and a two-row Other sheet. */
  function sheetData(request: ApiCall) {
    return {
      body: {
        spreadsheetId: ID,
        valueRanges: request.url.searchParams.getAll("ranges").map((range) => {
          const start = /^Data!A(\d+):B10$/.exec(range);
          if (start) return { range, values: rows(Number(start[1]), 11 - Number(start[1])) };
          if (range === "Data") return { range: "Data!A1:B10", values: rows(1, 10) };
          return { range: "Other!A1:A2", values: [["x"], ["y"]] };
        }),
      },
    };
  }

  it("pages by whole rows under maxCells, resuming a bounded range where it stopped", async () => {
    route = sheetData;
    const connector = connection();
    const ranges = ["Data!A1:B10", "Other!A1:A2"];

    const first = await call(connector, "get_values", { spreadsheetId: ID, ranges, maxCells: 6 });
    expect(first.valueRanges).toEqual([
      { range: "Data!A1:B10", values: rows(1, 3), rowCount: 3, truncated: true, omittedRows: 7 },
    ]);
    expect(first.cellCount).toBe(6);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    calls.length = 0;
    const second = await call(connector, "get_values", { spreadsheetId: ID, ranges, maxCells: 20, cursor: first.page.nextCursor });
    // The caller's own range, rewritten to start past what was returned.
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Data!A4:B10", "Other!A1:A2"]);
    expect(second.valueRanges).toEqual([
      { range: "Data!A4:B10", values: rows(4, 7), rowCount: 7 },
      { range: "Other!A1:A2", values: [["x"], ["y"]], rowCount: 2 },
    ]);
    expect(second.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("re-reads a sheet title or named range and says where the page starts", async () => {
    route = sheetData;
    const ranges = ["Data"];
    const first = await call(connection(), "get_values", { spreadsheetId: ID, ranges, maxCells: 8 });
    expect(first.valueRanges[0]).toMatchObject({ values: rows(1, 4), truncated: true, omittedRows: 6 });
    calls.length = 0;
    const second = await call(connection(), "get_values", { spreadsheetId: ID, ranges, maxCells: 20, cursor: first.page.nextCursor });
    // A bare title could be a named range, so it is never rewritten.
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Data"]);
    expect(second.valueRanges).toEqual([{ range: "Data!A1:B10", rowOffset: 4, values: rows(5, 6), rowCount: 6 }]);
    expect(second.page.hasMore).toBe(false);
  });

  it("starts an unreached range on the next page rather than reporting it half-read", async () => {
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

  it("never returns more than maxCells: a row wider than the page is refused, not cut", async () => {
    const wideRow = Array.from({ length: 18_278 }, () => 1);
    route = (request) => {
      const range = request.url.searchParams.get("ranges")!;
      return { body: { valueRanges: [{ range, values: range === "W!A2:ZZZ2" ? [wideRow] : [[1, 2, 3], wideRow] }] } };
    };
    const narrow = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["W!A1:ZZZ2"], maxCells: 1 }).catch((error) => error);
    expect(narrow).toMatchObject({ code: "invalid_args" });
    expect(narrow.message).toContain("raise maxCells to at least 3");

    // The first row fits; the page stops before the one that cannot.
    const first = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["W!A1:ZZZ2"], maxCells: 10_000 });
    expect(first.cellCount).toBe(3);
    expect(first.page.hasMore).toBe(true);
    const wide = await call(connection(), "get_values", {
      spreadsheetId: ID,
      ranges: ["W!A1:ZZZ2"],
      maxCells: 10_000,
      cursor: first.page.nextCursor,
    }).catch((error) => error);
    expect(wide).toMatchObject({ code: "invalid_args" });
    expect(wide.message).toContain("narrow the range's columns");
    expect(wide.message).toContain("18278 cells");
  });

  it("cuts a long cell with a marker that says how to read the rest, and reads it whole on request", async () => {
    const long = "x".repeat(5_010);
    route = () => ({ body: { valueRanges: [{ range: "S!A1:B1", values: [[long, "short"]] }] } });
    const result = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["S!A1:B1"] });
    expect(result.valueRanges[0].values[0][0]).toBe(
      `${"x".repeat(5_000)}[… 10 more characters truncated; read this cell alone with maxCellChars up to 50000 for the rest]`,
    );
    expect(result.valueRanges[0].values[0][1]).toBe("short");
    expect(result.truncatedCells).toBe(1);

    const whole = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["S!A1"], maxCellChars: 50_000 });
    expect(whole.valueRanges[0].values[0][0]).toBe(long);
    expect(whole.truncatedCells).toBeUndefined();
  });

  it("binds a cursor to its spreadsheet, ranges, and render options, and refuses one forged", async () => {
    route = () => ({ body: { valueRanges: [{ range: "S!A1:A3", values: [[1], [2], [3]] }] } });
    const args = { spreadsheetId: ID, ranges: ["S!A1:A3"], valueRenderOption: "FORMULA" };
    const first = await call(connection(), "get_values", { ...args, maxCells: 1 });
    const cursor = first.page.nextCursor;
    const forge = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const decoded = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    calls.length = 0;
    for (const attempt of [
      // Replayed against other arguments of the same shape.
      { ...args, ranges: ["Private!Z1:Z3"], cursor },
      { ...args, spreadsheetId: "another-spreadsheet", cursor },
      { ...args, valueRenderOption: "FORMATTED_VALUE", cursor },
      // Forged: a range of its own, an index past the ranges, a wrong digest.
      { ...args, cursor: forge({ n: 1, i: 0, r: "Private!Z1:Z2", s: 0 }) },
      { ...args, cursor: forge({ ...decoded, r: "Private!Z1:Z2" }) },
      { ...args, cursor: forge({ ...decoded, i: 1 }) },
      { ...args, cursor: forge({ ...decoded, d: "AAAAAAAAAAAAAAAAAAAAAA" }) },
      { ...args, cursor: "not-a-cursor" },
    ]) {
      await expect(call(connection(), "get_values", attempt)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);

    // Whatever row offset a cursor claims, only the caller's own range is read.
    await call(connection(), "get_values", { ...args, cursor: forge({ ...decoded, s: 2 }) });
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["S!A3:A3"]);
  });
});

describe("pages that can be delivered", () => {
  const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  /** Exactly what the QuickJS executor serializes to hand a host result to a program. */
  const bridged = (value: unknown) => utf8({ ok: true, value });

  /** A Big sheet of `count` rows, each `width` cells of 5,000 characters that need escaping. */
  function bigSheet(count: number, width: number) {
    const cell = (row: number) => `${row}é"`.padEnd(5_000, "é");
    return (request: ApiCall) => {
      const range = request.url.searchParams.get("ranges")!;
      const start = Number(/^Big!A(\d+):/.exec(range)?.[1] ?? 1);
      return {
        body: {
          valueRanges: [{
            range: `Big!A${start}:Z${count}`,
            values: Array.from({ length: count - start + 1 }, (_, index) =>
              Array.from({ length: width }, () => cell(start + index))),
          }],
        },
      };
    };
  }

  it("keeps every default page under the execute_code host bridge, and pages through all of it", async () => {
    // 3 × 5,000 two-byte characters is 30 KB a row: 40 rows overrun the bridge
    // many times over, while 2,000 cells would have let them all through.
    route = bigSheet(40, 3);
    const connector = connection();
    const args = { spreadsheetId: ID, ranges: ["Big!A1:Z40"] };
    let cursor: string | undefined;
    const seen: number[] = [];
    for (let page = 0; page < 40; page += 1) {
      const result = await call(connector, "get_values", cursor ? { ...args, cursor } : args);
      expect(bridged(result)).toBeLessThanOrEqual(MAX_QUICKJS_HOST_RPC_BYTES);
      for (const row of result.valueRanges[0].values) seen.push(Number(/^\d+/.exec(row[0])![0]));
      if (!result.page.hasMore) break;
      cursor = result.page.nextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  });

  /** Page through a whole read, asserting every page fits maxBytes as serialized. */
  async function pageAll(connector: Connector, args: Record<string, unknown>, maxBytes: number) {
    const pages: any[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 500; guard += 1) {
      const result = await call(connector, "get_values", cursor ? { ...args, cursor } : args);
      expect(utf8(result), `page ${pages.length}`).toBeLessThanOrEqual(maxBytes);
      pages.push(result);
      if (!result.page.hasMore) return pages;
      cursor = result.page.nextCursor;
    }
    throw new Error("paging did not terminate");
  }

  it("counts the page's own fields: a row that fills maxBytes alone is refused, then fits exactly where it says", async () => {
    route = () => ({ body: { spreadsheetId: ID, valueRanges: [{ range: "S!A1", values: [["x".repeat(1_019)]] }] } });
    const args = { spreadsheetId: ID, ranges: ["S!A1"] };
    const failure = await call(connection(), "get_values", { ...args, maxBytes: 1_024 }).catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid_args" });
    const needed = Number(/raise maxBytes to at least (\d+)/.exec(failure.message)![1]);
    expect(needed).toBeGreaterThan(1_024);
    const result = await call(connection(), "get_values", { ...args, maxBytes: needed });
    expect(result.valueRanges[0].values[0][0]).toHaveLength(1_019);
    expect(utf8(result)).toBeLessThanOrEqual(needed);
    await expect(call(connection(), "get_values", { ...args, maxBytes: needed - 1 })).rejects.toMatchObject({
      code: "invalid_args",
    });
  });

  it("charges empty ranges their fields, paging twenty of them under a small maxBytes", async () => {
    const ranges = Array.from({ length: 20 }, (_, index) => `'Long sheet title number ${index}'!A1:Z1000`);
    route = (request) => ({
      body: { spreadsheetId: ID, valueRanges: request.url.searchParams.getAll("ranges").map((range) => ({ range })) },
    });
    const pages = await pageAll(connection(), { spreadsheetId: ID, ranges, maxBytes: 1_024 }, 1_024);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.valueRanges.map((entry: any) => entry.range))).toEqual(ranges);
  });

  it("keeps a default twenty-range page of long cells under the advertised default", async () => {
    const ranges = Array.from({ length: 20 }, (_, index) => `'Quarterly ledger ${index} — "détail"'!A1:C10`);
    const cell = `é"\\`.repeat(1_250);
    route = (request) => ({
      body: {
        spreadsheetId: ID,
        valueRanges: request.url.searchParams.getAll("ranges").map((range) => {
          const start = Number(/!A(\d+):/.exec(range)![1]);
          return { range, values: Array.from({ length: 11 - start }, () => [cell, cell, cell]) };
        }),
      },
    });
    const pages = await pageAll(connection(), { spreadsheetId: ID, ranges }, 196_608);
    const rows = pages.flatMap((page) => page.valueRanges).reduce((sum: number, entry: any) => sum + entry.rowCount, 0);
    expect(rows).toBe(20 * 10);
    expect(Math.max(...pages.map(utf8))).toBeGreaterThan(150_000);
  });

  it.each([1_024, 1_500, 2_048, 4_096, 9_999])("never exceeds maxBytes %i across mixed rows, ranges, and markers", async (maxBytes) => {
    const ranges = ["A!A1:C30", "Empty!A1:B2", "'B b'!A1:A30", "C"];
    const value = (row: number, column: number) =>
      [row * 7 + column, `r${row}c${column}`, "é".repeat((row * 37 + column * 11) % 300), true, ""][(row + column) % 5];
    route = (request) => ({
      body: {
        spreadsheetId: ID,
        valueRanges: request.url.searchParams.getAll("ranges").map((range) => {
          if (range.startsWith("Empty")) return { range };
          const start = Number(/!A(\d+):/.exec(range)?.[1] ?? 1);
          const width = range.startsWith("A") ? 3 : 1;
          return {
            range: range === "C" ? "C!A1:B30" : range,
            values: Array.from({ length: 31 - start }, (_, index) =>
              Array.from({ length: width }, (_, column) => value(start + index, column))),
          };
        }),
      },
    });
    const pages = await pageAll(connection(), { spreadsheetId: ID, ranges, maxBytes, maxCellChars: 120 }, maxBytes);
    const seen = (prefix: string) =>
      pages.flatMap((page) => page.valueRanges).filter((entry: any) => entry.range.startsWith(prefix))
        .reduce((sum: number, entry: any) => sum + entry.rowCount, 0);
    expect([seen("A!"), seen("'B b'"), seen("C!")]).toEqual([30, 30, 30]);
  });

  it("refuses a single row too large for the page, naming every way out", async () => {
    // Sixty 5,000-character cells: well inside maxCells, far past the bridge.
    route = bigSheet(1, 60);
    const failure = await call(connection(), "get_values", { spreadsheetId: ID, ranges: ["Big!A1:Z1"] }).catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(failure.message).toMatch(/narrow the range's columns or lower maxCellChars, or raise maxBytes to at least \d+/);
    expect(failure.message).toContain("execute_code cannot receive it");
  });

  /** call_tool exactly as an MCP client reaches it, over a default result stash. */
  function metaTools() {
    return createMetaTools(
      new Registry([connection()], { storage: memoryStorage(), logger: silentLogger }),
      "https://connecta.example",
    );
  }

  const notice = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text.split("\n")[0]!);

  it("never hands call_tool a page the result stash cannot page", async () => {
    // A 10 MB row — 200 cells at Sheets' 50,000-character limit — fits under
    // the 16 MiB response cap but not in the stash. It is refused, not dropped.
    const huge = "x".repeat(50_000);
    route = () => ({ body: { valueRanges: [{ range: "W!A1:GR1", values: [Array.from({ length: 200 }, () => huge)] }] } });
    const refused = await metaTools().callTool({
      address: "sheets.get_values",
      args: { spreadsheetId: ID, ranges: ["W!A1:GR1"], maxCellChars: 50_000, maxBytes: 4 * 1024 * 1024 },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("invalid_args");
    expect(JSON.stringify(refused)).toContain("narrow the range's columns");

    // The largest page a caller may ask for still pages through get_result.
    route = bigSheet(200, 3);
    const mt = metaTools();
    const paged = await mt.callTool({
      address: "sheets.get_values",
      args: { spreadsheetId: ID, ranges: ["Big!A1:Z200"], maxBytes: 4 * 1024 * 1024 },
    });
    expect(paged.isError).toBeFalsy();
    const stashed = notice(paged);
    expect(stashed.truncated).toBe(true);
    expect(stashed.totalBytes).toBeGreaterThan(3 * 1024 * 1024);
    expect(stashed.resultId).toEqual(expect.any(String));
    expect(stashed.hint).not.toContain("Paging is unavailable");
    const page = await mt.getResult({ id: stashed.resultId, offset: 0 });
    expect(page.isError).toBeFalsy();
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

  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const hundred = Array.from({ length: 100 }, (_, index) => ({ duplicateSheet: { sourceSheetId: 0, newSheetName: `Copy ${index}` } }));

  it("keeps a large reply deliverable after the write applied: whole replies first, then kind, ids, and counts", async () => {
    // Each duplicateSheet reply carries the new sheet's full properties and
    // conditional formats: about 6 KB apiece, 600 KB in all — well past what
    // execute_code can receive, for a write that has already happened.
    const replies = Array.from({ length: 100 }, (_, index) => ({
      duplicateSheet: {
        properties: { sheetId: 1_000 + index, title: `Copy ${index}`, index, sheetType: "GRID", gridProperties: { rowCount: 1000, columnCount: 26 } },
        conditionalFormats: Array.from({ length: 40 }, () => ({ ranges: [{ sheetId: 1_000 + index }], booleanRule: { condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "100" }] } } })),
      },
    }));
    route = () => ({ body: { spreadsheetId: ID, replies } });
    const result = await call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests: hundred });
    expect(bytesOf(replies)).toBeGreaterThan(400_000);
    expect(bytesOf(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(bytesOf({ ok: true, value: result })).toBeLessThanOrEqual(MAX_QUICKJS_HOST_RPC_BYTES);
    expect(result.replies).toHaveLength(100);
    expect(result.replies[0]).toEqual(replies[0]);
    expect(result.repliesSummarized).toBeGreaterThan(0);
    expect(result.replies[99]).toEqual({
      kind: "duplicateSheet",
      properties: { sheetId: 1_099, title: "Copy 99", index: 99, sheetType: "GRID" },
    });
    expect(result.note).toContain("All 100 requests applied");
    expect(result.note).toContain("Do not send the requests again");
    expect(result.note).not.toMatch(/nothing was/i);
  });

  it("keeps findReplace's counts and a summarized chart's id", async () => {
    const replies = [
      { findReplace: { occurrencesChanged: 12, valuesChanged: 9, rowsChanged: 7, sheetsChanged: 2, formulasChanged: 1 } },
      ...Array.from({ length: 99 }, () => ({ addChart: { chart: { chartId: 5, spec: { title: "x".repeat(4_000) } } } })),
    ];
    route = () => ({ body: { spreadsheetId: ID, replies } });
    const result = await call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests: hundred });
    expect(bytesOf(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.replies[0]).toEqual(replies[0]);
    expect(result.replies[99]).toEqual({ kind: "addChart", chart: { chartId: 5 } });
  });

  it("returns counts and where to re-read when even the summaries cannot fit", async () => {
    const wide = Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`field${index}`, index]));
    route = () => ({ body: { spreadsheetId: ID, replies: Array.from({ length: 100 }, () => ({ updateEmbeddedObjectPosition: wide })) } });
    const result = await call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests: hundred });
    expect(bytesOf(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result).toEqual({
      spreadsheetId: ID,
      replies: [],
      repliesOmitted: 100,
      note: expect.stringContaining("All 100 requests applied"),
    });
    expect(result.note).toContain("get_spreadsheet");
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
  /** A 200 whose JSON body breaks off mid-stream. */
  const brokenReply = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"spreadsheetId":'));
          controller.error(new TypeError("other side closed"));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  /** A request that went out and got no answer at all. */
  const noReply = () => {
    throw new TypeError("fetch failed");
  };
  const writes: [string, Record<string, unknown>][] = [
    ["update_values", { spreadsheetId: ID, range: "A1", values: [["x"]], valueInputOption: "RAW" }],
    ["batch_update_values", { spreadsheetId: ID, data: [{ range: "A1", values: [["x"]] }], valueInputOption: "RAW" }],
    ["append_values", { spreadsheetId: ID, range: "Log!A:C", values: [["x"]], valueInputOption: "RAW" }],
    ["clear_values", { spreadsheetId: ID, ranges: ["A1"] }],
    ["create_spreadsheet", { title: "Attendance" }],
    ["add_sheet", { spreadsheetId: ID, title: "Q4" }],
    ["batch_update_spreadsheet", { spreadsheetId: ID, requests: [{ deleteSheet: { sheetId: 7 } }] }],
  ];

  it.each(writes)("never tells %s to retry when its 2xx reply breaks mid-stream", async (name, args) => {
    route = () => ({ raw: brokenReply });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("the change probably applied");
    expect(failure.message).not.toMatch(/nothing was (written|sent|applied)|safe to (retry|repeat)/i);
    // One attempt: an accepted write is never replayed.
    expect(calls).toHaveLength(1);
  });

  it.each(writes)("never tells %s to retry when no reply comes back", async (name, args) => {
    route = () => ({ raw: noReply });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("may or may not have been applied");
    expect(failure.message).not.toMatch(/nothing was (written|sent|applied)|safe to (retry|repeat)/i);
    expect(calls).toHaveLength(1);
  });

  const serverError = () => ({
    status: 503,
    body: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } },
  });
  const idempotent = new Set(["update_values", "batch_update_values", "clear_values"]);

  it.each(writes.filter(([name]) => !idempotent.has(name)))(
    "treats a 5xx answering %s as an unknown outcome, never retryable",
    async (name, args) => {
      route = serverError;
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("outcome is unknown");
      expect(failure.message).not.toMatch(/nothing was (written|sent|applied)|safe to (retry|repeat)/i);
      expect(calls).toHaveLength(1);
    },
  );

  it.each(writes.filter(([name]) => idempotent.has(name)))(
    "keeps a 5xx answering %s retryable: the same cells written twice are written once",
    async (name, args) => {
      route = serverError;
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "unavailable", retryable: true });
    },
  );

  /** A redirect, which the client never follows. */
  const redirect = () => ({
    raw: () => new Response(null, { status: 307, headers: { Location: "https://sheets.googleapis.com/elsewhere" } }),
  });
  const advice: Record<string, string> = {
    append_values: "Appending again would add the rows a second time",
    create_spreadsheet: "Search Drive for this title before creating it again",
  };

  it.each(writes)("treats a redirect answering %s as an unknown outcome, never as applied", async (name, args) => {
    route = redirect;
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("unknown");
    expect(failure.message).not.toMatch(/probably applied|nothing was (written|sent|applied)|safe to (retry|repeat)/i);
    if (advice[name]) expect(failure.message).toContain(advice[name]);
    expect(calls).toHaveLength(1);
  });

  it("keeps a 503 with a rate-limit reason on a non-idempotent write an unknown outcome, not a rate limit", async () => {
    route = () => ({
      status: 503,
      body: { error: { code: 503, message: "Quota exceeded.", status: "UNAVAILABLE", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } },
    });
    const failure = await call(connection(), "append_values", writes[2]![1]).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.code).not.toBe("rate_limited");
    expect(failure.message).toContain("outcome is unknown");
    expect(failure.message).toContain(advice["append_values"]);
    expect(calls).toHaveLength(1);
  });

  it("gives a 5xx append or create the same advice as one that got no answer", async () => {
    route = serverError;
    const append = await call(connection(), "append_values", writes[2]![1]).catch((error) => error);
    expect(append.message).toContain("Appending again would add the rows a second time");
    const create = await call(connection(), "create_spreadsheet", writes[4]![1]).catch((error) => error);
    expect(create.message).toContain("Search Drive for this title before creating it again");
  });

  it("tells an uncertain append to read the table, and an uncertain create to search Drive", async () => {
    route = () => ({ raw: noReply });
    const append = await call(connection(), "append_values", writes[2]![1]).catch((error) => error);
    expect(append.message).toContain("Appending again would add the rows a second time");
    expect(append.message).toContain("get_values");
    route = () => ({ raw: brokenReply });
    const create = await call(connection(), "create_spreadsheet", writes[4]![1]).catch((error) => error);
    expect(create.message).toContain("Search Drive for this title before creating it again");
  });

  it("passes an explicit refusal of an append through unchanged, and a dropped read stays retryable", async () => {
    route = () => ({ status: 400, body: { error: { code: 400, message: "Unable to parse range: Log!A:C", status: "INVALID_ARGUMENT" } } });
    const refused = await call(connection(), "append_values", writes[2]![1]).catch((error) => error);
    expect(refused.code).toBe("invalid_args");
    expect(refused.message).not.toContain("Appending again");
    route = () => ({ raw: noReply });
    const read = await call(connection(), "get_spreadsheet", { spreadsheetId: ID }).catch((error) => error);
    expect(read).toMatchObject({ code: "unavailable", retryable: true });
  });

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
