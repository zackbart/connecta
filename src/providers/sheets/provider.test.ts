// The Google Sheets connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the pages and caps it reads
// under, and the safety class of every tool — H1, H9, H10, and H11 for this
// provider. Delegation, subjects, and tokens are
// test/google-workspace-delegation.test.ts; only the no-caller refusal is
// repeated here, because it is this connector's own front door.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { MAX_QUICKJS_HOST_RPC_BYTES } from "../../executors/quickjs-protocol.js";
import { requestSentSecrets } from "../../sent-secrets.js";
import { RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";

import { sheets } from "./index.js";
import { SHEETS_HATCH, sheetsIndex } from "./lib/hatch.js";
import { SHEETS_ADMITTED_KINDS, SHEETS_REQUEST_KINDS, SHEETS_REFUSED_KINDS } from "./lib/requests.js";

import { memoryStorage } from "../../storage/memory.js";
import { makeRegistry, silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

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
let storage = memoryStorage();

beforeEach(() => {
  storage = memoryStorage();
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
  return { storage, logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

describe("reading values (H9, H10)", () => {
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

  it("INV-2 INV-5: pages whole rows and admits only reviewed Sheets hatch reads", async () => {
    installOwnedTransport();
    route = sheetData;
    const connector = connection();
    const ranges = ["Data!A1:B10", "Other!A1:A2"];

    const first = await call(connector, "get_values", { spreadsheetId: ID, ranges, maxCells: 6 });
    expect(first.valueRanges).toEqual([{ range: "Data!A1:B10", values: rows(1, 3), rowCount: 3 }]);
    expect(first.cellCount).toBe(6);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);

    calls.length = 0;
    const second = await call(connector, "get_values", {
      spreadsheetId: ID,
      ranges,
      maxCells: 20,
      cursor: first.page.nextCursor,
    });
    // The caller's own range, rewritten to start past what was returned.
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["Data!A4:B10", "Other!A1:A2"]);
    expect(second.valueRanges).toEqual([
      { range: "Data!A4:B10", values: rows(4, 7), rowCount: 7 },
      { range: "Other!A1:A2", values: [["x"], ["y"]], rowCount: 2 },
    ]);
    expect(second.page).toEqual({ hasMore: false });
    route = () => ({ body: { valueRanges: [{ range: "Data!A1:A2", values: [["long cell"], ["other"]] }] } });
    const selected = await call(connector, "get_values", {
      spreadsheetId: ID,
      ranges: ["Data!A1:A2"],
      maxCells: 1,
      maxCellChars: 1,
      fields: ["valueRanges.values"],
    });
    expect(selected.truncated).toEqual(["valueRanges[].values"]);
    expect(selected.page.hasMore).toBe(true);
    expect(selected.page.nextCursor).toBeTypeOf("string");
    expect(selected).not.toHaveProperty("cellCount");
    route = () => ({
      body: {
        spreadsheetId: ID,
        properties: { title: "Review" },
        namedRanges: Array.from({ length: 201 }, (_, i) => ({
          name: `Range${i}`,
          range: { sheetId: 0, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: 0, endColumnIndex: 1 },
        })),
      },
    });
    expect(await call(connector, "get_spreadsheet", { spreadsheetId: ID, fields: ["title"] })).toEqual({
      title: "Review",
      truncated: ["namedRanges[]"],
    });

    expect(sheetsIndex.pathMatching).toBe("uri-template");
    expect(sheetsIndex.ops).toHaveLength(17);
    for (const op of sheetsIndex.ops) {
      expect(op.summary.length).toBeLessThanOrEqual(120);
      expect(op.summary).not.toContain("…");
    }
    expect(Object.keys(SHEETS_HATCH.verdicts).sort()).toEqual(
      sheetsIndex.ops.map((op) => `${op.method} ${op.path}`).sort(),
    );
    for (const [query, expected] of [
      ["append rows", "/spreadsheets/{spreadsheetId}/values/{range}:append"],
      ["write cell values", "/spreadsheets/{spreadsheetId}/values:batchUpdate"],
      ["format cells", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["make cells bold", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["sort range", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["sort rows", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["merge cells", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["delete rows", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["rename sheet", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["freeze header row", "/spreadsheets/{spreadsheetId}:batchUpdate"],
      ["append literal rows", "/spreadsheets/{spreadsheetId}/values/{range}:append"],
      ["create spreadsheet", "/spreadsheets"],
      ["find developer metadata", "/spreadsheets/{spreadsheetId}/developerMetadata:search"],
    ]) {
      const result = await call(connector, "sheets_api_search", { query });
      expect(
        result.operations.slice(0, 2).map((op: any) => op.path),
        query,
      ).toContain(expected);
    }

    expect(Object.values(SHEETS_HATCH.verdicts).filter((value) => value === "read")).toHaveLength(7);
    expect(SHEETS_REQUEST_KINDS).toHaveLength(74);
    expect(SHEETS_ADMITTED_KINDS).toHaveLength(64);
    route = () => ({
      body: {
        spreadsheetId: ID,
        values: [["visible", 3]],
        matchedDeveloperMetadata: [{ developerMetadata: { metadataId: 7, metadataKey: "review" } }],
      },
    });
    for (const path of ["Sheet1!A1%3AD7", "'Alice''s%20costs'!A1%3AD7", "Sheet1!A1:D7"]) {
      const result = await call(connector, "sheets_api_read", {
        method: "GET",
        path: `/spreadsheets/${ID}/values/${path}`,
        fields: ["values"],
      });
      expect(result).toEqual({ status: 200, data: { values: [["visible", 3]] } });
      expect(calls.at(-1)!.url.pathname).toContain("A1:D7");
    }
    const readOnlyConnector = connection({ readOnly: true });
    expect(readOnlyConnector.readOnly).toBe(true);
    for (const path of ["/developerMetadata:search", ":getByDataFilter", "/values:batchGetByDataFilter"]) {
      const result = await call(readOnlyConnector, "sheets_api_read", {
        method: "POST",
        path: `/spreadsheets/${ID}${path}`,
        body: { dataFilters: [{ a1Range: "Sheet1!A1:D7" }] },
      });
      expect(result.status).toBe(200);
      expect(calls.at(-1)!.method).toBe("POST");
    }
    const reads = calls.length;
    for (const args of [
      { method: "GET", path: `/spreadsheets/${ID}/values/%41%31` },
      { method: "POST", path: `/spreadsheets/${ID}/values/A1%3Aclear` },
      { method: "GET", path: `/spreadsheets/${ID}`, fields: ["unknownRoot"] },
      { method: "GET", path: `/spreadsheets/${ID}`, query: { userId: "bob@example.com" } },
      { method: "GET", path: `/spreadsheets/${ID}`, query: { access_token: "x" } },
      { method: "GET", path: `/spreadsheets/${ID}`, headers: { authorization: "Bearer x" } },
      { method: "GET", path: `/spreadsheets/${ID}`, query: { ranges: Array(21).fill("A1") } },
    ])
      await expect(call(connector, "sheets_api_read", args)).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(reads);
    await expect(call(connector, "get_spreadsheet", { spreadsheetId: ID, raw: true })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      call(connector, "sheets_api_read", {
        method: "POST",
        path: `/spreadsheets/${ID}:batchUpdate`,
        body: { requests: [{ repeatCell: {} }] },
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });

    {
      const wideRow = Array.from({ length: 18_278 }, () => 1);
      route = (request) => {
        const range = request.url.searchParams.get("ranges")!;
        return { body: { valueRanges: [{ range, values: range === "W!A2:ZZZ2" ? [wideRow] : [[1, 2, 3], wideRow] }] } };
      };
      const narrow = await call(connection(), "get_values", {
        spreadsheetId: ID,
        ranges: ["W!A1:ZZZ2"],
        maxCells: 1,
      }).catch((error) => error);
      expect(narrow).toMatchObject({ code: "invalid_args" });
      expect(narrow.message).toContain("raise maxCells to at least 3");

      // The first row fits; the page stops before the one that cannot.
      const first = await call(connection(), "get_values", {
        spreadsheetId: ID,
        ranges: ["W!A1:ZZZ2"],
        maxCells: 10_000,
      });
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
    }
  });

  it("INV-4 INV-5: signed value cursors refuse tampering and delegated caller changes without sending", async () => {
    route = (request) => {
      const range = request.url.searchParams.get("ranges") ?? "S!A1:A3";
      const start = Number(/S!A(\d+)/.exec(range)?.[1] ?? 1);
      return { body: { valueRanges: [{ range, values: [1, 2, 3].slice(start - 1).map((value) => [value]) }] } };
    };
    const args = { spreadsheetId: ID, ranges: ["S!A1:A3"], valueRenderOption: "FORMULA" };
    const connector = connection();
    const first = await call(connector, "get_values", { ...args, maxCells: 1 });
    const cursor = first.page.nextCursor;
    const forge = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, " ").trim();
    const decoded = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    calls.length = 0;
    const mints = tokenRequests;
    for (const attempt of [
      { ...args, ranges: ["Private!Z1:Z3"], cursor },
      { ...args, spreadsheetId: "another-spreadsheet", cursor },
      { ...args, valueRenderOption: "FORMATTED_VALUE", cursor },
      { ...args, cursor: forge({ d: "legacy", i: 0, s: 2 }) },
      { ...args, cursor: forge({ ...decoded, c: JSON.stringify({ i: 0, s: 2 }) }) },
      { ...args, cursor: forge({ ...decoded, d: "AAAAAAAAAAAAAAAAAAAAAA" }) },
      { ...args, cursor: "not-a-cursor" },
    ])
      await expect(call(connector, "get_values", attempt)).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
    expect(tokenRequests).toBe(mints);
    await call(connector, "get_values", { ...args, cursor });
    expect(calls[0]!.url.searchParams.getAll("ranges")).toEqual(["S!A2:A3"]);

    const mapped = connection({
      subject: (identity: { principal?: { id: string } }) => `${identity.principal?.id}@example.com`,
    });
    const registry = makeRegistry([mapped], { storage: memoryStorage() });
    const callerContext = (id: string) =>
      registry
        .scoped({
          connectorIds: "all",
          caller: {
            authenticated: true,
            identity: {
              actor: { kind: "test-users", namespace: "https://identity.test", id },
              subject: { namespace: "https://identity.test", id },
              principal: { namespace: "https://identity.test", id },
              interactive: true,
            },
          },
        })
        .contextFor("sheets", "https://connecta.example");
    const issued = (await mapped.callTool("get_values", { ...args, maxCells: 1 }, callerContext("alice"))) as any;
    const before = { api: calls.length, tokens: tokenRequests };
    await expect(
      mapped.callTool("get_values", { ...args, cursor: issued.page.nextCursor }, callerContext("bob")),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(before.api);
    expect(tokenRequests).toBe(before.tokens);
    const continued = (await mapped.callTool(
      "get_values",
      { ...args, cursor: issued.page.nextCursor },
      callerContext("alice"),
    )) as any;
    expect(continued.valueRanges[0].values).toEqual([[2], [3]]);
    expect(continued.page).toEqual({ hasMore: false });
    expect(calls).toHaveLength(before.api + 1);
  });
});

// Worst-case sheets of 5,000-character cells paged through whole calls:
// CPU-bound, with no timing behavior, and on a loaded host past vitest's 5s
// default. This is a hang guard, not a speed assertion.
describe("pages that can be delivered", { timeout: 60_000 }, () => {
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
          valueRanges: [
            {
              range: `Big!A${start}:Z${count}`,
              values: Array.from({ length: count - start + 1 }, (_, index) =>
                Array.from({ length: width }, () => cell(start + index)),
              ),
            },
          ],
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
});

describe("the raw batchUpdate hatch", () => {
  // Kit writes on Node use the owned transport that listen() installs.
  beforeEach(() => {
    installOwnedTransport();
  });

  const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const hundred = Array.from({ length: 100 }, (_, index) => ({
    duplicateSheet: { sourceSheetId: 0, newSheetName: `Copy ${index}` },
  }));

  it("keeps a large reply deliverable after the write applied: whole replies first, then kind, ids, and counts", async () => {
    // Each duplicateSheet reply carries the new sheet's full properties and
    // conditional formats: about 6 KB apiece, 600 KB in all — well past what
    // execute_code can receive, for a write that has already happened.
    const replies = Array.from({ length: 100 }, (_, index) => ({
      duplicateSheet: {
        properties: {
          sheetId: 1_000 + index,
          title: `Copy ${index}`,
          index,
          sheetType: "GRID",
          gridProperties: { rowCount: 1000, columnCount: 26 },
        },
        conditionalFormats: Array.from({ length: 40 }, () => ({
          ranges: [{ sheetId: 1_000 + index }],
          booleanRule: { condition: { type: "NUMBER_GREATER", values: [{ userEnteredValue: "100" }] } },
        })),
      },
    }));
    route = () => ({ body: { spreadsheetId: ID, replies } });
    const result = await call(connection(), "batch_update_spreadsheet", { spreadsheetId: ID, requests: hundred });
    expect(bytesOf(replies)).toBeGreaterThan(400_000);
    expect(bytesOf(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(bytesOf({ ok: true, value: result })).toBeLessThanOrEqual(MAX_QUICKJS_HOST_RPC_BYTES);
    expect(result.replies).toHaveLength(100);
    expect(result.replies[0]).toEqual(replies[0]);
    expect(result.truncated).toEqual(["replies[]"]);
    expect(result.replies[99]).toEqual({
      kind: "duplicateSheet",
      properties: { sheetId: 1_099, title: "Copy 99", index: 99, sheetType: "GRID" },
    });
    expect(result.note).toContain("All 100 requests applied");
    expect(result.note).toContain("Do not send the requests again");
    expect(result.note).not.toMatch(/nothing was/i);
    const connector = connection();
    const sent = calls.length;
    const mints = tokenRequests;
    for (const kind of Object.keys(SHEETS_REFUSED_KINDS)) {
      for (const [tool, args] of [
        ["batch_update_spreadsheet", { spreadsheetId: ID, requests: [{ [kind]: {} }] }],
        [
          "sheets_api_write",
          { method: "POST", path: `/spreadsheets/${ID}:batchUpdate`, body: { requests: [{ [kind]: {} }] } },
        ],
      ] as const)
        await expect(call(connector, tool, args)).rejects.toMatchObject({
          code: "invalid_args",
          message: expect.stringContaining(SHEETS_REFUSED_KINDS[kind]!),
        });
    }
    for (const body of [
      { requests: [] },
      { requests: Array(101).fill({ repeatCell: {} }) },
      { requests: [{ repeatCell: {}, deleteSheet: {} }] },
      { requests: [{ futureKind: {} }] },
    ]) {
      await expect(
        call(connector, "sheets_api_write", { method: "POST", path: `/spreadsheets/${ID}:batchUpdate`, body }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
    for (const values of [
      [[{ nested: true }]],
      [["x".repeat(50001)]],
      Array.from({ length: 6 }, () => Array(10000).fill(1)),
    ]) {
      await expect(
        call(connector, "sheets_api_write", {
          method: "POST",
          path: `/spreadsheets/${ID}/values:batchUpdateByDataFilter`,
          body: { valueInputOption: "RAW", data: [{ dataFilter: { a1Range: "A1" }, values }] },
        }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toHaveLength(sent);
    expect(tokenRequests).toBe(mints);
    await expect(
      call(connector, "sheets_api_write", {
        method: "PUT",
        path: `/spreadsheets/${ID}/values/A1`,
        query: { valueInputOption: "RAW" },
        body: { values: [["x"]] },
        fields: ["unknownRoot"],
      }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(sent);
    expect(tokenRequests).toBe(mints);
    route = () => ({ body: { spreadsheetId: ID, updatedCells: 1 } });
    const updated = await call(connector, "sheets_api_write", {
      method: "PUT",
      path: `/spreadsheets/${ID}/values/Sheet1!A1%3AB1`,
      query: { valueInputOption: "RAW" },
      body: { values: [[null, ""]] },
    });
    expect(updated.status).toBe(200);
    expect(calls.at(-1)!.body.values).toEqual([[null, ""]]);
  });
});

describe("errors (H11)", () => {
  // Kit writes on Node use the owned transport that listen() installs.
  beforeEach(() => {
    installOwnedTransport();
  });

  /** A 200 whose JSON body breaks off mid-stream. */

  /** A request that went out and got no answer at all. */

  const writes: [string, Record<string, unknown>][] = [
    ["update_values", { spreadsheetId: ID, range: "A1", values: [["x"]], valueInputOption: "RAW" }],
    ["append_values", { spreadsheetId: ID, range: "Log!A:C", values: [["x"]], valueInputOption: "RAW" }],
    ["create_spreadsheet", { title: "Attendance" }],
  ];

  const serverError = () => ({
    status: 503,
    body: { error: { code: 503, message: "The service is currently unavailable.", status: "UNAVAILABLE" } },
  });

  // Writing fixed cells is an operation hint, not an idempotency key, and
  // grants no retry credit (#902 round 11).
  it.each(writes.filter(([name]) => name === "update_values"))(
    "INV-5 INV-9: %s preserves unknown writes and private error-key classification",
    async (name, args) => {
      route = serverError;
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false, writeOutcome: "unknown" });
      const connector = connection();
      // Error-envelope keys feed classification before the final boundary.
      // Private key collisions must keep rate-limit, precondition and scope advice.
      for (const row of [
        ...["reason", "errors", "error"].map((privateValue) => ({
          privateValue,
          error: { code: 403, message: "Quota exceeded", errors: [{ reason: "userRateLimitExceeded" }] },
          expected: {
            code: "rate_limited",
            retryable: true,
            message: expect.stringContaining("Google meters this API"),
          },
        })),
        {
          privateValue: "status",
          error: { code: 400, message: "Precondition", status: "FAILED_PRECONDITION" },
          expected: { code: "connector_call_failed", message: expect.stringContaining("precondition") },
        },
        {
          privateValue: "reason",
          error: { code: 403, message: "Scope refused", errors: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
          expected: {
            code: "provider_permission_denied",
            message: expect.stringContaining("lacks a scope this call needs"),
          },
        },
      ]) {
        const ctx = context();
        requestSentSecrets(ctx).arguments(
          { private: row.privateValue },
          { type: "object", properties: { private: { type: "string", writeOnly: true } } },
        );
        route = () => ({ body: { error: row.error }, status: row.error.code });
        await expect(
          connector.callTool("get_values", { spreadsheetId: ID, ranges: ["Sheet1!A1"] }, ctx),
        ).rejects.toMatchObject(row.expected);
      }
    },
  );

  /** A redirect, which the client never follows. */
});
