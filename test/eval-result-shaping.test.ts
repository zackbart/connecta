// Eval-only result presentation arms: the invariants any shipped rule must keep.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/connectors/api.js";
import {
  installResultPresenter,
  leanValue,
  presentLean,
  presentPreview,
  PREVIEW_ROW_BYTES,
  PREVIEW_ROW_THRESHOLD,
} from "../eval/result-shaping/shape.js";
import { mcpRpc, readJsonRpc } from "./fixtures/http.js";
import { createTestConnecta, silentLogger } from "./helpers.js";
import { memoryStorage } from "../src/storage/memory.js";
import { classifyResult } from "../eval/result-shaping/noise.js";

const rows = (count: number) =>
  Array.from({ length: count }, (_, id) => ({ id: `row_${id}`, email: `person${id}@example.com`, amount: id * 100 }));

/** Every leaf the view shows exists at the same path in the original. */
function assertSubset(view: unknown, original: unknown, path = "$"): void {
  if (Array.isArray(view)) {
    expect(Array.isArray(original), path).toBe(true);
    view.forEach((item, index) => assertSubset(item, (original as unknown[])[index], `${path}[${index}]`));
  } else if (view && typeof view === "object") {
    for (const [key, child] of Object.entries(view))
      assertSubset(child, (original as Record<string, unknown>)[key], `${path}.${key}`);
  } else expect(view, path).toBe(original);
}

describe("lean presentation", () => {
  it("drops null properties in rows and leaves continuation, list and failure facts", () => {
    const value = {
      items: [{ id: "a", archivedAt: null, note: "", tags: [], extra: {}, zero: 0, off: false }],
      page: { hasMore: false, nextCursor: null },
      total: null,
      warnings: [],
    };
    const { value: lean, dropped } = leanValue(value);
    expect(lean).toEqual({
      items: [{ id: "a", zero: 0, off: false }],
      page: { hasMore: false, nextCursor: null },
      total: null,
      warnings: [],
    });
    expect(dropped).toBe(4);
    assertSubset(lean, value);
  });

  it("keeps an empty result visible at every envelope depth", () => {
    for (const value of [
      { items: [] },
      { status: 200, data: { object: "list", data: [], has_more: false } },
      { data: null },
      [],
    ])
      expect(leanValue(value).value).toEqual(value);
  });

  it("never removes array positions", () => {
    const value = {
      values: [
        ["a", "", null, "d"],
        ["", "", "", "h"],
      ],
    };
    expect(leanValue(value).value).toEqual(value);
  });

  it("refuses text it cannot reserialize exactly", () => {
    expect(presentLean(`{"id":12345678901234567890,"a":null,"b":null,"c":null,"d":null,"e":null}`)).toBeUndefined();
    expect(presentLean("plain log line")).toBeUndefined();
    expect(presentLean("42")).toBeUndefined();
  });

  it("removes whitespace from pretty-printed text and says so", () => {
    const shaped = presentLean(JSON.stringify({ a: 1, b: { c: 2 }, d: "x".repeat(40) }, null, 8));
    expect(shaped?.note).toContain("whitespace");
    expect(JSON.parse(shaped!.text)).toEqual({ a: 1, b: { c: 2 }, d: "x".repeat(40) });
  });
});

describe("schema-aware preview", () => {
  it("returns valid JSON in the result's own shape with whole rows and every outside value", () => {
    const value = { items: rows(200), page: { hasMore: true, nextCursor: "c200" }, total: 900 };
    const preview = presentPreview(JSON.stringify(value))!;
    const body = JSON.parse(preview.body);
    assertSubset(body, value);
    expect(body.page).toEqual(value.page);
    expect(body.total).toBe(900);
    expect(preview.fields).toMatchObject({ rows: { path: "items", count: 200, keys: ["id", "email", "amount"] } });
    expect(new TextEncoder().encode(JSON.stringify(body.items)).length).toBeLessThanOrEqual(PREVIEW_ROW_BYTES + 2);
  });

  it("finds rows inside a hatch envelope and its program reads the same path", () => {
    const value = { status: 200, data: { object: "list", data: rows(200), has_more: true } };
    const preview = presentPreview(JSON.stringify(value))!;
    expect(preview.fields).toMatchObject({ rows: { path: "data.data", count: 200 } });
    expect(preview.program("id-1")).toContain("JSON.parse(text).data.data;");
    expect(preview.program("id-1")).toContain('connecta.result("id-1"');
  });

  it("leaves small lists, single records and documents whole", () => {
    expect(presentPreview(JSON.stringify({ items: rows(3) }))).toBeUndefined();
    expect(presentPreview(JSON.stringify({ id: "x", body: "y".repeat(PREVIEW_ROW_THRESHOLD * 2) }))).toBeUndefined();
    expect(presentPreview(JSON.stringify({ items: rows(5), body: "y".repeat(PREVIEW_ROW_THRESHOLD * 2) }))).toBe(
      undefined,
    );
  });

  it("shows head and tail of long text and keeps numbers it cannot round trip whole", () => {
    const log = Array.from({ length: 2_000 }, (_, line) => `line ${line}`).join("\n");
    const preview = presentPreview(log)!;
    expect(preview.body).toContain("line 0\n");
    expect(preview.body).toContain("line 1999");
    expect(preview.body).toContain("bytes omitted");
    expect(presentPreview(`{"items":[${`{"id":12345678901234567890},`.repeat(400)}{"id":1}]}`)).toBeUndefined();
  });
});

describe("the eval-only seam", () => {
  afterEach(() => installResultPresenter("control"));

  async function call(value: unknown, write: boolean, extra: Record<string, unknown> = {}) {
    const handler = vi.fn(async () => value);
    const connector = api("down", {
      tools: [
        {
          name: "run",
          description: "Run",
          annotations: { readOnlyHint: !write },
          inputSchema: { type: "object" as const },
          handler,
        },
      ],
    });
    const app = createTestConnecta({
      connectors: [connector],
      storage: memoryStorage(),
      readOnly: false,
      logger: silentLogger,
    });
    try {
      const response = await readJsonRpc(
        await mcpRpc(app, "tools/call", {
          name: write ? "call_destructive_tool" : "call_tool",
          arguments: { address: "down.run", ...(write ? { reason: "test" } : {}), ...extra },
        }),
      );
      expect(response.error).toBeUndefined();
      expect(handler).toHaveBeenCalledOnce();
      return response.result;
    } finally {
      await app.close();
    }
  }

  it("is off by default, and a write keeps its only copy under every arm", async () => {
    const value = { items: rows(400).map((row) => ({ ...row, archivedAt: null })) };
    for (const arm of ["control", "lean", "preview", "lean-preview"] as const) {
      installResultPresenter(arm);
      const result = await call(value, true);
      const text = result.content[0].text as string;
      const [notice, ...rest] = text.split("\n");
      expect(JSON.parse(notice!)).toMatchObject({ truncated: true, nextOffset: 24_000 });
      expect(JSON.parse(notice!).hint).toContain("This write already ran");
      expect(rest.join("\n")).toContain('"archivedAt":null');
    }
  });

  it("previews a read with a retained handle, truthful totals and its format", async () => {
    installResultPresenter("preview");
    const value = { items: rows(400).map((row) => ({ ...row, archivedAt: null })), total: 400 };
    const result = await call(value, false);
    const text = result.content[0].text as string;
    const newline = text.indexOf("\n");
    const notice = JSON.parse(text.slice(0, newline));
    expect(notice).toMatchObject({
      truncated: true,
      nextOffset: 0,
      totalBytes: new TextEncoder().encode(JSON.stringify(value)).length,
      rows: { path: "items", count: 400 },
    });
    expect(notice.resultId).toEqual(expect.any(String));
    expect(notice.nextAction.tool).toBe("execute_code");
    expect(new TextEncoder().encode(text).length).toBeLessThan(4_000);
    assertSubset(JSON.parse(text.slice(newline + 1)), value);
    expect(result._meta).toEqual({ "dev.connecta/format": "json" });
    expect(result.structuredContent).toBeUndefined();
  });

  it("lean adds a disclosure block and keeps the first block parseable", async () => {
    installResultPresenter("lean");
    const value = { items: rows(3).map((row) => ({ ...row, archivedAt: null })) };
    const result = await call(value, false);
    const [first, note] = result.content as { text: string }[];
    assertSubset(JSON.parse(first!.text), value);
    expect(first!.text).not.toContain("archivedAt");
    expect(note!.text).toContain("omitted");
  });

  it("value mode returns the exact value under every arm", async () => {
    for (const arm of ["lean", "preview", "lean-preview"] as const) {
      installResultPresenter(arm);
      const value = { items: rows(3).map((row) => ({ ...row, archivedAt: null })) };
      const result = await call(value, false, { resultMode: "value" });
      expect(result.structuredContent.data).toEqual(value);
    }
  });
});

describe("byte classes", () => {
  it("adds up to the compact size", () => {
    const report = classifyResult(
      JSON.stringify({
        items: [{ id: "a", url: "https://x.example/a", created_at: "2026-01-01", none: null, off: false }],
        _links: { self: "/x" },
      }),
    );
    expect(Object.values(report.classes).reduce((a, b) => a + b, 0)).toBe(report.compactBytes);
    expect(report.classes.nullsEmpties).toBeGreaterThan(0);
    expect(report.classes.linkBlocks).toBeGreaterThan(0);
  });
});
