// The Google Docs connection. test/goldens/docs pins each tool's catalog entry,
// requests, results and failure ladder; these tests stub the network for what
// the goldens do not reach: rendering every element kind, index paging, result
// and raw ceilings, refusals before dispatch, and write outcomes. Delegation,
// subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Validator } from "@cfworker/json-schema";
import { DOCS_API_BASE_URL, docs } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { AuthenticatedIdentity, Connector, ConnectorContext } from "../../types.js";

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

type Route = (
  call: ApiCall,
) =>
  | { status?: number; body?: unknown; raw?: string; unreachable?: boolean; brokenBody?: boolean; oversized?: boolean }
  | undefined;

const calls: ApiCall[] = [];
let tokenCalls = 0;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  tokenCalls = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      tokenCalls += 1;
      return Response.json({ access_token: "token", expires_in: 3599 });
    }
    const call: ApiCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = route(call) ?? {};
    if (reply.unreachable) throw new TypeError("fetch failed: connection reset");
    if (reply.oversized) {
      // A 2xx that declares more than the 24 MiB response ceiling.
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(25 * 1024 * 1024) },
      });
    }
    if (reply.brokenBody) {
      // The status arrives; the body stream then dies, as a reset socket does.
      const body = new ReadableStream({
        pull(controller) {
          controller.error(Object.assign(new TypeError("terminated"), { code: "UND_ERR_SOCKET" }));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (reply.status !== undefined && reply.status >= 300 && reply.status < 400) {
      return new Response(null, { status: reply.status, headers: { location: "https://elsewhere.example/" } });
    }
    if (reply.raw !== undefined) {
      return new Response(reply.raw, { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return docs("docs", {
    purpose: "Staff meeting notes",
    serviceAccount: { clientEmail: `docs-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "pastor@church.example",
    ...overrides,
  } as Parameters<typeof docs>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

// --- A document, as documents.get returns it with includeTabsContent ----------------

function run(content: string, startIndex: number, link?: string) {
  return {
    startIndex,
    endIndex: startIndex + content.length,
    textRun: { content, textStyle: link ? { link: { url: link }, underline: true } : { bold: false } },
  };
}

function paragraph(startIndex: number, pieces: unknown[], extra: Record<string, unknown> = {}) {
  const last = pieces[pieces.length - 1] as { endIndex: number };
  return {
    startIndex,
    endIndex: last.endIndex,
    paragraph: {
      elements: pieces,
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" },
      ...extra,
    },
  };
}

function heading(startIndex: number, content: string, style: string) {
  return {
    ...paragraph(startIndex, [run(content, startIndex)]),
    paragraph: {
      elements: [run(content, startIndex)],
      paragraphStyle: { namedStyleType: style, headingId: "h.1" },
    },
  };
}

function cell(startIndex: number, content: string) {
  return {
    startIndex,
    endIndex: startIndex + content.length + 1,
    content: [paragraph(startIndex + 1, [run(content, startIndex + 1)])],
  };
}

const FIRST_TAB_BODY = {
  content: [
    { endIndex: 1, sectionBreak: { sectionStyle: {} } },
    heading(1, "Elders meeting\n", "TITLE"),
    heading(16, "Agenda\n", "HEADING_2"),
    paragraph(23, [
      run("See the ", 23),
      run("plan", 31, "https://example.org/plan"),
      run(" doc", 35, "https://example.org/plan"),
      run(" now.\n", 39),
    ]),
    paragraph(45, [run("Budget\n", 45)], { bullet: { listId: "kix.ol", nestingLevel: 0 } }),
    paragraph(52, [run("Q3 | Q4\n", 52)], { bullet: { listId: "kix.ol", nestingLevel: 1 } }),
    paragraph(60, [run("Prayer\n", 60)], { bullet: { listId: "kix.ul", nestingLevel: 0 } }),
    paragraph(67, [
      run("Footnoted", 67),
      { startIndex: 76, endIndex: 77, footnoteReference: { footnoteId: "kix.fn1", footnoteNumber: "1" } },
      { startIndex: 77, endIndex: 78, inlineObjectElement: { inlineObjectId: "kix.img" } },
      {
        startIndex: 78,
        endIndex: 79,
        person: { personProperties: { name: "Ann Elder", email: "ann@church.example" } },
      },
      {
        startIndex: 79,
        endIndex: 80,
        richLink: { richLinkProperties: { title: "Budget sheet", uri: "https://docs.google.com/spreadsheets/d/s1" } },
      },
      run("\n", 80),
    ]),
    {
      startIndex: 81,
      endIndex: 100,
      table: {
        rows: 2,
        columns: 2,
        tableRows: [
          { startIndex: 82, endIndex: 90, tableCells: [cell(82, "Item\n"), cell(86, "Owner\n")] },
          { startIndex: 90, endIndex: 99, tableCells: [cell(90, "Roof\n"), cell(94, "Bo\n")] },
        ],
      },
    },
    { startIndex: 100, endIndex: 102, tableOfContents: { content: [paragraph(101, [run("Agenda\n", 101)])] } },
    paragraph(102, [run("Line one\u000bline two\n", 102)]),
  ],
};

const DOCUMENT = {
  documentId: "doc-1",
  title: "Elders meeting",
  revisionId: "rev-1",
  suggestionsViewMode: "SUGGESTIONS_INLINE",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Notes", index: 0 },
      documentTab: {
        body: FIRST_TAB_BODY,
        documentStyle: { pageSize: { height: { magnitude: 792, unit: "PT" } } },
        namedStyles: { styles: [{ namedStyleType: "NORMAL_TEXT" }] },
        lists: {
          "kix.ol": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }, { glyphType: "ALPHA" }] } },
          "kix.ul": { listProperties: { nestingLevels: [{ glyphSymbol: "●", glyphType: "GLYPH_TYPE_UNSPECIFIED" }] } },
        },
        footnotes: { "kix.fn1": { footnoteId: "kix.fn1", content: [paragraph(0, [run(" Per the bylaws.\n", 0)])] } },
        inlineObjects: {
          "kix.img": {
            inlineObjectProperties: {
              embeddedObject: { title: "Roof photo", imageProperties: { contentUri: "https://lh3.example/x" } },
            },
          },
        },
      },
      childTabs: [
        {
          tabProperties: { tabId: "t.child", title: "Minutes", parentTabId: "t.0", index: 0, nestingLevel: 1 },
          documentTab: {
            body: { content: [{ endIndex: 1, sectionBreak: {} }, paragraph(1, [run("Approved.\n", 1)])] },
          },
        },
      ],
    },
  ],
};

const RENDERED_FIRST_TAB = [
  "# Elders meeting",
  "## Agenda",
  "See the [plan doc](https://example.org/plan) now.",
  "1. Budget",
  "  1. Q3 | Q4",
  "- Prayer",
  "Footnoted[^1][image: Roof photo]Ann Elder[Budget sheet](https://docs.google.com/spreadsheets/d/s1)",
  "| Item | Owner |",
  "| --- | --- |",
  "| Roof | Bo |",
  "[Table of contents]",
  "Line one",
  "line two",
  "",
  "[^1]: Per the bylaws.",
].join("\n");

describe("reading a document (H9)", () => {
  it("asks for every tab and renders each as markdown-ish text, dropping styles", async () => {
    route = () => ({ body: DOCUMENT });
    const result = await call(connection(), "get_document", { documentId: "doc-1" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(`${DOCS_API_BASE_URL}/documents/doc-1`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ includeTabsContent: "true" });

    expect(result).toEqual({
      documentId: "doc-1",
      title: "Elders meeting",
      revisionId: "rev-1",
      url: "https://docs.google.com/document/d/doc-1/edit",
      tabs: [
        { tabId: "t.0", title: "Notes", endIndex: 120, text: RENDERED_FIRST_TAB, textTruncated: false },
        {
          tabId: "t.child",
          title: "Minutes",
          parentTabId: "t.0",
          nestingLevel: 1,
          endIndex: 11,
          text: "Approved.",
          textTruncated: false,
        },
      ],
    });
    const serialized = JSON.stringify(result);
    for (const noise of ["pageSize", "namedStyles", "LEFT_TO_RIGHT", "contentUri", "kix."]) {
      expect(serialized).not.toContain(noise);
    }
  });

  it("returns the start and end index of every paragraph, table, and table of contents on withIndexes", async () => {
    route = () => ({ body: DOCUMENT });
    const result = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.0", withIndexes: true });
    expect(result.tabs).toHaveLength(1);
    expect(result.page).toEqual({ hasMore: false, nextCursor: null });
    const elements = result.tabs[0].elements;
    expect(elements.slice(0, 3)).toEqual([
      { type: "paragraph", startIndex: 1, endIndex: 16, style: "TITLE", text: "Elders meeting" },
      { type: "paragraph", startIndex: 16, endIndex: 23, style: "HEADING_2", text: "Agenda" },
      { type: "paragraph", startIndex: 23, endIndex: 45, text: "See the [plan doc](https://example.org/plan) now." },
    ]);
    expect(elements).toContainEqual({ type: "table", startIndex: 81, endIndex: 100 });
    expect(elements).toContainEqual({ type: "paragraph", startIndex: 95, endIndex: 98, row: 1, column: 1, text: "Bo" });
    expect(elements).toContainEqual({ type: "table_of_contents", startIndex: 100, endIndex: 102 });
    // The section break is no edit target; the footnote is its own segment.
    expect(elements.some((element: any) => element.startIndex === 0)).toBe(false);
    expect(elements.some((element: any) => /bylaws/.test(element.text ?? ""))).toBe(false);
  });

  it("caps text across tabs with explicit markers, never inside a surrogate pair", async () => {
    route = () => ({ body: DOCUMENT });
    const result = await call(connection(), "get_document", { documentId: "doc-1", maxChars: 14 });
    expect(result.tabs[0]).toMatchObject({
      text: `# Elders meeti\n[… ${RENDERED_FIRST_TAB.length - 14} more characters truncated; raise maxChars or pass tabId to read them]`,
      textTruncated: true,
    });
    // The budget is spent, so the next tab says what it holds rather than nothing.
    expect(result.tabs[1]).toMatchObject({
      text: "[… 9 more characters truncated; raise maxChars or pass tabId to read them]",
      textTruncated: true,
    });

    route = () => ({
      body: {
        documentId: "d",
        tabs: [
          { tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [paragraph(1, [run("a🙏b\n", 1)])] } } },
        ],
      },
    });
    const emoji = await call(connection(), "get_document", { documentId: "d", maxChars: 2 });
    expect(emoji.tabs[0].text.startsWith("a\n[… 3 more")).toBe(true);
  });

  it("reads one tab by id, and says which tabs exist when the id is wrong", async () => {
    route = () => ({ body: DOCUMENT });
    const one = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.child" });
    expect(one.tabs.map((tab: any) => tab.tabId)).toEqual(["t.child"]);

    const failure = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.nope" }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "not_found" });
    expect(failure.message).toContain("t.0, t.child");
  });

  it("maps suggestion previews to Google's view modes", async () => {
    route = () => ({ body: DOCUMENT });
    await call(connection(), "get_document", { documentId: "doc-1", suggestions: "accepted" });
    await call(connection(), "get_document", { documentId: "doc-1", suggestions: "rejected" });
    await call(connection(), "get_document", { documentId: "doc-1", suggestions: "inline" });
    expect(calls.map((entry) => entry.url.searchParams.get("suggestionsViewMode"))).toEqual([
      "PREVIEW_SUGGESTIONS_ACCEPTED",
      "PREVIEW_WITHOUT_SUGGESTIONS",
      "SUGGESTIONS_INLINE",
    ]);
  });

  it("reads a response without tabs as one tab holding the legacy body", async () => {
    route = () => ({
      body: {
        documentId: "doc-2",
        title: "Old",
        revisionId: "r",
        body: { content: [paragraph(1, [run("Hello\n", 1)])] },
      },
    });
    const result = await call(connection(), "get_document", { documentId: "doc-2" });
    expect(result.tabs).toEqual([{ endIndex: 7, text: "Hello", textTruncated: false }]);
  });

  it("pages index rows across tabs by cursor, every row exactly once", async () => {
    const tab = (id: string, count: number) => ({
      tabProperties: { tabId: id },
      documentTab: {
        body: {
          content: Array.from({ length: count }, (_, index) =>
            paragraph(index + 1, [run(`${id} row ${index}\n`, index + 1)]),
          ),
        },
      },
    });
    route = () => ({ body: { documentId: "big", revisionId: "r", tabs: [tab("t.0", 1_500), tab("t.1", 1_500)] } });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result: any = await call(connection(), "get_document", {
        documentId: "big",
        withIndexes: true,
        maxChars: 0,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(96 * 1024);
      for (const each of result.tabs) for (const row of each.elements) seen.push(row.text);
      expect(result.page.hasMore).toBe(result.page.nextCursor !== null);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor && pages < 50);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(3_000);
    expect(new Set(seen).size).toBe(3_000);
    expect(seen[0]).toBe("t.0 row 0");
    expect(seen[2_999]).toBe("t.1 row 1499");
  });

  it("refuses a cursor without withIndexes, and an undeclared cursor shape, before any request", async () => {
    await expect(call(connection(), "get_document", { documentId: "d", cursor: "e:5" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      call(connection(), "get_document", { documentId: "d", withIndexes: true, cursor: "page-2" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("delivers a worst-case default read across the 256 KiB execute_code bridge", async () => {
    // Three-byte characters, JSON-escaped quotes, a hundred titled tabs, and
    // more index rows than one page holds: every default limit at once.
    const heavy = '中"'.repeat(10_000);
    const tabs = Array.from({ length: 100 }, (_, index) => ({
      tabProperties: { tabId: `t.${index}`, title: "題".repeat(100), parentTabId: "t.0", nestingLevel: 1 },
      documentTab: {
        body: {
          content: Array.from({ length: 60 }, (_, row) =>
            paragraph(row * 200 + 1, [run(`${"題".repeat(40)}${heavy.slice(0, 120)}\n`, row * 200 + 1)], {
              paragraphStyle: { namedStyleType: "HEADING_6" },
            }),
          ),
        },
      },
    }));
    tabs[0]!.documentTab.body.content.unshift(paragraph(1, [run(`${heavy}\n`, 1)]));
    route = () => ({ body: { documentId: "worst", title: "題".repeat(200), revisionId: "r", tabs } });
    const result = await call(connection(), "get_document", { documentId: "worst", withIndexes: true });
    expect(result.page.hasMore).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(256 * 1024);
  });

  it("keeps the explicit maximum inside what a direct call can stash and page", async () => {
    const text = "中".repeat(1_100_000);
    route = () => ({
      body: {
        documentId: "max",
        tabs: [
          {
            tabProperties: { tabId: "t.0" },
            documentTab: { body: { content: [paragraph(1, [run(`${text}\n`, 1)])] } },
          },
        ],
      },
    });
    const result = await call(connection(), "get_document", {
      documentId: "max",
      maxChars: 1_000_000,
      withIndexes: true,
    });
    expect(result.tabs[0].textTruncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(8 * 1024 * 1024);
  });
});

describe("editing a document", () => {
  it("keeps a large reply inside the result budget, still saying the batch applied", async () => {
    const BUDGET = 192 * 1024;
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const requests = Array.from({ length: 100 }, () => ({ insertText: {} }));
    const send = () =>
      call(connection(), "batch_update_document", { documentId: "doc-1", requests, requiredRevisionId: "r1" });

    // Ids and counts under bulky echoes: projection alone fits.
    route = () => ({
      body: {
        documentId: "doc-1",
        writeControl: { requiredRevisionId: "r2" },
        replies: Array.from({ length: 100 }, (_, index) => ({
          addDocumentTab: {
            tabProperties: { tabId: `t.${index}`, title: "題".repeat(2_000), index },
            echo: ["x".repeat(5_000)],
          },
        })),
      },
    });
    const projected = await send();
    expect(bytes(projected)).toBeLessThanOrEqual(BUDGET);
    expect(projected).toMatchObject({ documentId: "doc-1", revisionId: "r2", replyCount: 100, repliesTruncated: true });
    expect(projected.replies).toHaveLength(100);
    expect(projected.replies[42].addDocumentTab.tabProperties).toMatchObject({ tabId: "t.42", index: 42 });
    expect(projected.replies[42].addDocumentTab.echo).toBeUndefined();
    expect(projected.notice).toContain("The batch applied");
    expect(projected.notice).not.toMatch(/nothing was (applied|changed)/i);

    // Too many even projected: the longest prefix that fits, counted.
    route = () => ({
      body: {
        documentId: "doc-1",
        replies: Array.from({ length: 100 }, (_, index) => ({
          createNamedRange: Object.fromEntries(
            Array.from({ length: 10 }, (_, key) => [`id${key}`, `${index}-${"n".repeat(480)}`]),
          ),
        })),
      },
    });
    const cut = await send();
    expect(bytes(cut)).toBeLessThanOrEqual(BUDGET);
    expect(cut.replyCount).toBe(100);
    expect(cut.replies.length).toBeGreaterThan(0);
    expect(cut.replies.length).toBeLessThan(100);
    expect(cut.replies[0].createNamedRange.id0.startsWith("0-")).toBe(true);
    expect(cut.notice).toContain(`${cut.replies.length} of 100 replies`);
    expect(cut.notice).toContain("Do not repeat it");

    // Small replies come back whole, with nothing added.
    route = () => ({ body: { documentId: "doc-1", replies: [{}, { createNamedRange: { namedRangeId: "kix.1" } }] } });
    const small = await send();
    expect(small).toEqual({
      documentId: "doc-1",
      replies: [{}, { createNamedRange: { namedRangeId: "kix.1" } }],
      replyCount: 2,
    });
  });

  it("refuses malformed ids, indexes, and requests before any request", async () => {
    const connector = connection();
    for (const [name, args] of [
      ["get_document", { documentId: "../drive/v3/files" }],
      ["get_document", { documentId: "doc-1", tabId: "t 0" }],
      ["get_document", { documentId: "doc-1", maxChars: 2_000_000 }],
      ["insert_text", { documentId: "doc-1", index: 0, text: "x" }],
      ["append_text", { documentId: "doc-1", text: "" }],
      ["create_document", { title: "Two\nlines" }],
      ["batch_update_document", { documentId: "doc-1", requests: [], requiredRevisionId: "r" }],
      [
        "batch_update_document",
        { documentId: "doc-1", requests: [{ insertText: {}, deleteContentRange: {} }], requiredRevisionId: "r" },
      ],
      // An unknown kind, and a Developer Preview one, are refused by name.
      ["batch_update_document", { documentId: "doc-1", requests: [{ deleteEverything: {} }], requiredRevisionId: "r" }],
      ["batch_update_document", { documentId: "doc-1", requests: [{ insertComment: {} }], requiredRevisionId: "r" }],
      [
        "batch_update_document",
        {
          documentId: "doc-1",
          requests: Array.from({ length: 101 }, () => ({ insertText: {} })),
          requiredRevisionId: "r",
        },
      ],
      // Raw edits are planned against a read: the revision is required.
      ["batch_update_document", { documentId: "doc-1", requests: [{ insertText: {} }] }],
      ["replace_all_text", { documentId: "doc-1", find: "x" }],
      ["append_text", { documentId: "doc-1", text: "x", requiredRevisionId: "has space" }],
    ] as const) {
      await expect(connector.callTool(name, args, context()), `${name} ${JSON.stringify(args)}`).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
    expect(tokenCalls).toBe(0);
  });
});

describe("failures, mapped to what the caller does next (H11)", () => {
  it.each([["a 400 FAILED_PRECONDITION", 400, "FAILED_PRECONDITION"]])(
    "answers a stale requiredRevisionId (%s) with conflict, reading nothing more",
    async (_kind, status, reason) => {
      route = () => ({ status, body: { error: { code: status, message: "The document changed.", status: reason } } });
      const failure = await call(connection(), "insert_text", {
        documentId: "doc-1",
        index: 5,
        text: "x",
        requiredRevisionId: "rev-1",
      }).catch((error) => error);
      expect(failure).toMatchObject({ code: "conflict", retryable: false });
      expect(failure.message).toContain("changed after the revision it named");
      expect(calls.map((entry) => entry.method)).toEqual(["POST"]);
    },
  );

  it("passes other refusals through as mapped, and a precondition without a revision is no conflict", async () => {
    // A bad index is a refusal, not a conflict, revision or not.
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Index 500 must be less than the end index.", status: "INVALID_ARGUMENT" } },
    });
    for (const revision of [{ requiredRevisionId: "rev-1" }, {}]) {
      calls.length = 0;
      await expect(
        call(connection(), "insert_text", { documentId: "doc-1", index: 500, text: "x", ...revision }),
      ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("Index 500") });
      expect(calls.map((entry) => entry.method)).toEqual(["POST"]);
    }
    // Unguarded, FAILED_PRECONDITION means something else and is not relabeled.
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Precondition check failed.", status: "FAILED_PRECONDITION" } },
    });
    const unguarded = await call(connection(), "insert_text", { documentId: "doc-1", index: 5, text: "x" }).catch(
      (error) => error,
    );
    expect(unguarded.code).toBe("connector_call_failed");
  });

  it("calls an edit applied after a 2xx body breaks, and never invites a repeat", async () => {
    route = () => ({ brokenBody: true });
    const failure = await call(connection(), "append_text", { documentId: "d", text: "x" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("so it was applied");
    expect(failure.message).toContain("Do not repeat it");
    expect(calls.map((entry) => entry.method)).toEqual(["POST"]);
  });

  it.each([
    ["no answer", { unreachable: true }, "whether its initial text was written is unknown", "only if it is missing"],
    [
      "an explicit 4xx refusal",
      { status: 400, body: { error: { code: 400, message: "Invalid text.", status: "INVALID_ARGUMENT" } } },
      "Google refused its initial text",
      "add the text with append_text on new-1",
    ],
  ])("after creating, advises on its initial text by outcome: %s", async (_kind, reply, says, advice) => {
    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate") ? reply : { body: { documentId: "new-1", title: "Minutes" } };
    const failure = await call(connection(), "create_document", { title: "Minutes", text: "x" }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({
      code: _kind === "an explicit 4xx refusal" ? "invalid_args" : "connector_call_failed",
      retryable: false,
      writeOutcome: "unknown",
    });
    expect(failure.message).toContain(`Created document new-1, but ${says}`);
    expect(failure.message).toContain(advice);
    expect(failure.message).toContain("Do not create it again");
  });

  it.each([
    ["an unreadable reply", { raw: "{oops" }],
    ["a reply without an id", { body: { title: "Minutes" } }],
  ])("acknowledges a create Google answered 2xx with %s", async (_kind, reply) => {
    route = () => reply;
    const failure = await call(connection(), "create_document", { title: "Minutes" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("created the document (HTTP 2xx)");
    expect(failure.message).toContain('find "Minutes" in Drive');
  });
});

describe("whose documents", () => {
  it("fails closed with no admitted caller, before any network call", async () => {
    const connector = connection({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@church.example` });
    await expect(call(connector, "get_document", { documentId: "doc-1" })).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no admitted caller"),
    });
    expect(tokenCalls).toBe(0);
    expect(calls).toEqual([]);
  });
});

/** Keys a value emits that its schema does not declare, at every depth. */
function undeclared(schema: any, value: unknown, at: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => undeclared(schema?.items, item, `${at}[${index}]`, found));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    const declared = schema?.properties?.[key];
    if (!declared) {
      // An opaque object (a raw batchUpdate reply) declares no properties on purpose.
      if (schema?.properties) found.push(`${at}.${key}`);
      continue;
    }
    undeclared(declared, entry, `${at}.${key}`, found);
  }
}

async function check(connector: Connector, name: string, result: unknown): Promise<void> {
  const tool = (await connector.listTools(context())).find((candidate) => candidate.name === name)!;
  const found: string[] = [];
  undeclared(tool.outputSchema, result, name, found);
  expect(found).toEqual([]);
  const verdict = new Validator(tool.outputSchema as any, "2020-12", false).validate(result);
  expect(verdict.errors, name).toEqual([]);
}

describe("every output is declared (H8, H9)", () => {
  it("accepts ProtoJSON omissions in documents and batch replies", async () => {
    const connector = connection();
    // ProtoJSON drops empty fields: an empty document is very nearly `{}`.
    route = () => ({ body: {} });
    const empty = await call(connector, "get_document", { documentId: "doc-0", withIndexes: true });
    expect(empty).toEqual({
      documentId: "doc-0",
      url: "https://docs.google.com/document/d/doc-0/edit",
      tabs: [{ text: "", textTruncated: false, elements: [] }],
      page: { hasMore: false, nextCursor: null },
    });
    await check(connector, "get_document", empty);
    route = () => ({ body: { documentId: "doc-0", tabs: [{ tabProperties: { tabId: "t.0" } }] } });
    await check(connector, "get_document", await call(connector, "get_document", { documentId: "doc-0" }));

    // An empty batchUpdate answer still satisfies every required key.
    route = () => ({ body: {} });
    await check(connector, "append_text", await call(connector, "append_text", { documentId: "d", text: "x" }));
    await check(
      connector,
      "replace_all_text",
      await call(connector, "replace_all_text", { documentId: "d", find: "a", replaceWith: "b" }),
    );
    await check(
      connector,
      "batch_update_document",
      await call(connector, "batch_update_document", {
        documentId: "d",
        requests: [{ insertText: {} }],
        requiredRevisionId: "r1",
      }),
    );
  });

  it("names what a tab holds that its text leaves out, rather than dropping it silently", async () => {
    route = () => ({
      body: {
        documentId: "d",
        tabs: [
          {
            tabProperties: { tabId: "t.0" },
            documentTab: {
              body: {
                content: [
                  paragraph(1, [
                    { startIndex: 1, endIndex: 5, textRun: { content: "Old ", suggestedDeletionIds: ["suggest.1"] } },
                    run("text\n", 5),
                  ]),
                ],
              },
              headers: { "kix.h": { headerId: "kix.h", content: [] } },
              footers: { "kix.f": { footerId: "kix.f", content: [] } },
              positionedObjects: { "kix.p": {} },
            },
          },
          { tabProperties: { tabId: "t.1" }, documentTab: { body: { content: [paragraph(1, [run("Plain\n", 1)])] } } },
        ],
      },
    });
    const result = await call(connection(), "get_document", { documentId: "d" });
    expect(result.tabs[0].notRendered).toEqual(["headers", "footers", "positioned_objects", "suggestion_marks"]);
    expect(result.tabs[0].text).toBe("Old text");
    expect(result.tabs[1].notRendered).toBeUndefined();
  });
});

describe("raw reads (H9)", () => {
  it("measures the raw ceiling on the whole result, to the byte", async () => {
    const LIMIT = 4 * 1024 * 1024;
    const documentWith = (padding: number) => ({
      documentId: "edge",
      title: "Edge",
      revisionId: "r",
      tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [{ note: "x".repeat(padding) }] } } }],
    });
    route = () => ({ body: documentWith(0) });
    const base = new TextEncoder().encode(
      JSON.stringify(await call(connection(), "get_document", { documentId: "edge", raw: true })),
    ).length;

    route = () => ({ body: documentWith(LIMIT - base) });
    const exact = await call(connection(), "get_document", { documentId: "edge", raw: true });
    expect(new TextEncoder().encode(JSON.stringify(exact)).length).toBe(LIMIT);

    route = () => ({ body: documentWith(LIMIT - base + 1) });
    const over = await call(connection(), "get_document", { documentId: "edge", raw: true }).catch((error) => error);
    expect(over).toMatchObject({ code: "invalid_args" });
    expect(over.message).toContain(`${LIMIT + 1} bytes`);
  });

  it("returns Google's resource untouched, all tabs or one, with nothing the rendering adds", async () => {
    route = () => ({ body: DOCUMENT });
    const all = await call(connection(), "get_document", { documentId: "doc-1", raw: true });
    expect(all).toEqual({
      documentId: "doc-1",
      title: "Elders meeting",
      revisionId: "rev-1",
      url: "https://docs.google.com/document/d/doc-1/edit",
      raw: DOCUMENT,
    });
    expect(all.tabs).toBeUndefined();

    const child = await call(connection(), "get_document", { documentId: "doc-1", raw: true, tabId: "t.child" });
    expect(child.raw.tabs).toEqual([DOCUMENT.tabs[0]!.childTabs[0]]);
    expect(child.raw.title).toBe("Elders meeting");
  });
});

describe("every inline element renders as something, or is named (H9)", () => {
  /**
   * One of each ParagraphElement kind in the Docs v1 Discovery document. The
   * drift manifest digests documents.get's response schema, so a kind Google
   * adds surfaces there before it can vanish here unnoticed.
   */
  const KINDS: Readonly<Record<string, Record<string, unknown>>> = {
    textRun: { textRun: { content: "words" } },
    autoText: { autoText: { type: "PAGE_NUMBER" } },
    pageBreak: { pageBreak: {} },
    columnBreak: { columnBreak: {} },
    footnoteReference: { footnoteReference: { footnoteId: "f", footnoteNumber: "1" } },
    horizontalRule: { horizontalRule: {} },
    equation: { equation: {} },
    inlineObjectElement: { inlineObjectElement: { inlineObjectId: "kix.none" } },
    person: { person: { personProperties: { email: "ann@church.example" } } },
    richLink: { richLink: { richLinkProperties: { uri: "https://example.org" } } },
    dateElement: { dateElement: { dateElementProperties: { displayText: "Oct 6, 2026" } } },
    dropdown: { dropdown: { dropdownProperties: { displayValue: "Approved" } } },
  };

  async function renderOne(element: Record<string, unknown>) {
    route = () => ({
      body: {
        documentId: "d",
        tabs: [
          {
            tabProperties: { tabId: "t.0" },
            documentTab: {
              body: { content: [paragraph(1, [{ startIndex: 1, endIndex: 2, ...element }, run("!\n", 2)])] },
            },
          },
        ],
      },
    });
    return (await call(connection(), "get_document", { documentId: "d" })).tabs[0];
  }

  it.each(Object.entries(KINDS))("renders %s as visible text", async (_kind, element) => {
    const tab = await renderOne(element);
    expect(tab.text.split("\n")[0]!.length).toBeGreaterThan(1);
    expect(tab.notRendered).toBeUndefined();
  });

  it("renders a dropdown chip's selected value, and chips by what they show", async () => {
    expect((await renderOne(KINDS["dropdown"]!)).text).toBe("Approved!");
    expect((await renderOne({ dropdown: { dropdownProperties: {} } })).text).toBe("[dropdown: no selection]!");
    expect((await renderOne(KINDS["autoText"]!)).text).toBe("[page number]!");
    expect((await renderOne(KINDS["dateElement"]!)).text).toBe("Oct 6, 2026!");
  });

  it("names an element kind it does not know instead of dropping it silently", async () => {
    const tab = await renderOne({ futureChip: { value: "?" } });
    expect(tab.text).toBe("!");
    expect(tab.notRendered).toEqual(["unknown_elements"]);
  });

  it("cuts an index preview without splitting a surrogate pair", async () => {
    const body = `${"a".repeat(79)}🙏中`;
    route = () => ({
      body: {
        documentId: "d",
        tabs: [
          {
            tabProperties: { tabId: "t.0" },
            documentTab: { body: { content: [paragraph(1, [run(`${body}\n`, 1)])] } },
          },
        ],
      },
    });
    const result = await call(connection(), "get_document", { documentId: "d", withIndexes: true });
    const preview: string = result.tabs[0].elements[0].text;
    expect(preview).toBe(`${"a".repeat(79)}…`);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(preview)).toBe(false);
  });
});

// Cases here push 9 MiB fields and replies near the 192 KiB budget through
// whole calls: CPU-bound, with no timing behavior,
// and seconds long even on an idle machine. A loaded one ran them past
// vitest's 5s default, so this is a hang guard, not a speed assertion.
describe("round-3 review: outcomes by observed status, bounded copies, one final guard", { timeout: 60_000 }, () => {
  const BUDGET = 192 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const EDITS: Record<string, Record<string, unknown>> = {
    append_text: { documentId: "d", text: "x" },
    insert_text: { documentId: "d", index: 1, text: "x" },
    replace_all_text: { documentId: "d", find: "a", replaceWith: "b" },
    batch_update_document: { documentId: "d", requests: [{ insertText: {} }], requiredRevisionId: "r" },
  };
  const RATE_LIMITED_503 = {
    status: 503,
    body: {
      error: {
        code: 503,
        message: "Quota exceeded.",
        status: "UNAVAILABLE",
        details: [{ reason: "RATE_LIMIT_EXCEEDED" }],
      },
    },
  };

  const SURPRISES: [string, { status: number; body?: unknown }][] = [
    ["a 503 carrying a rate-limit reason", RATE_LIMITED_503],
    ...[303].map((status): [string, { status: number }] => [`a ${status} redirect`, { status }]),
  ];

  it.each(SURPRISES)("never calls a write refused or applied after %s", async (_kind, reply) => {
    route = () => reply;
    for (const [name, values] of Object.entries(EDITS)) {
      const failure = await call(connection(), name, values).catch((error) => error);
      expect(failure, name).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message, name).toContain("outcome of this edit is unknown");
      expect(failure.message, name).not.toMatch(/so it was applied|nothing was applied/i);
    }
    const create = await call(connection(), "create_document", { title: "Minutes" }).catch((error) => error);
    expect(create).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(create.message).toContain("Whether the document was created is unknown");
    expect(create.message).not.toContain("HTTP 2xx");

    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate") ? reply : { body: { documentId: "new-1", title: "Minutes" } };
    const text = await call(connection(), "create_document", { title: "Minutes", text: "x" }).catch((error) => error);
    expect(text.message).toContain("whether its initial text was written is unknown");
    expect(text.message).toContain("only if it is missing");
    expect(text.message).not.toContain("add the text with append_text on new-1");
  });

  it("drops, never cuts, a 9 MiB revisionId or a malformed id, on all six tools", async () => {
    const huge = "r".repeat(9 * 1024 * 1024);
    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate")
        ? {
            body: {
              documentId: "d",
              replies: [{ replaceAllText: { occurrencesChanged: 1 } }],
              writeControl: { requiredRevisionId: huge },
            },
          }
        : request.method === "POST"
          ? { body: { documentId: "new-1", title: huge, revisionId: huge } }
          : {
              body: {
                documentId: "d",
                title: "T".repeat(3 * 1024 * 1024),
                revisionId: huge,
                tabs: [
                  {
                    tabProperties: { tabId: "t 0 has spaces", title: "題".repeat(5_000), parentTabId: "p".repeat(200) },
                    documentTab: {},
                  },
                ],
              },
            };
    const connector = connection();
    for (const [name, values] of Object.entries({ ...EDITS, create_document: { title: "Minutes", text: "x" } })) {
      const result = await call(connector, name, values);
      expect(bytes(result), name).toBeLessThan(BUDGET);
      expect(result.revisionId, name).toBeUndefined();
      expect(result.dropped, name).toEqual(["revisionId"]);
      await check(connector, name, result);
    }
    const read = await call(connector, "get_document", { documentId: "d" });
    await check(connector, "get_document", read);
    expect(bytes(read)).toBeLessThan(BUDGET);
    expect(read.revisionId).toBeUndefined();
    expect(read.dropped).toEqual(["tabs[0].tabId", "tabs[0].parentTabId", "revisionId"]);
    expect(read.title.length).toBeLessThan(5_000);
    expect(read.title).toMatch(/more characters\]$/);
    expect(read.tabs[0].tabId).toBeUndefined();

    // A created document whose id could not be passed back has no usable id.
    route = () => ({ body: { documentId: "x".repeat(300) } });
    const create = await call(connection(), "create_document", { title: "Minutes" }).catch((error) => error);
    expect(create.message).toContain("created the document (HTTP 2xx)");
    expect(bytes(create.message)).toBeLessThan(2_000);
  });

  it.each([
    [20, 2],
    [21, 2],
    [22, 1],
  ])("measures the reply notice at the boundary with a %i-byte tail", async (tail, shown) => {
    // Two replies, including their notice, are one byte under, at, and one
    // byte over the budget. Dropping every reply is not a valid way to fit.
    const big = {
      createNamedRange: {
        ...Object.fromEntries(Array.from({ length: 385 }, (_, key) => [`k${key}`, "n".repeat(500)])),
        tail: "t".repeat(tail),
      },
    };
    const small = Array.from({ length: 99 }, (_, index) => ({ createNamedRange: { namedRangeId: `kix.${index}` } }));
    route = () => ({ body: { documentId: "d", replies: [big, ...small] } });
    const result = await call(connection(), "batch_update_document", {
      documentId: "d",
      requests: [{ insertText: {} }],
      requiredRevisionId: "r",
    });
    expect(bytes(result)).toBeLessThanOrEqual(BUDGET);
    if (tail <= 21) expect(bytes(result)).toBe(BUDGET + tail - 21);
    expect(result.replies).toEqual([big, ...small.slice(0, shown - 1)]);
    expect(result.notice).toContain(`${shown} of 100 replies`);
  });

  it("refuses a default read past the bridge budget, and lets an explicit one through", async () => {
    const tabs = Array.from({ length: 2_000 }, (_, index) => ({
      tabProperties: { tabId: `t.${index}`, title: "題".repeat(100) },
      documentTab: { body: { content: [] } },
    }));
    route = () => ({ body: { documentId: "d", tabs } });
    const failure = await call(connection(), "get_document", { documentId: "d" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(failure.message).toContain("Pass tabId");
    const explicit = await call(connection(), "get_document", { documentId: "d", maxChars: 100 });
    expect(explicit.tabs).toHaveLength(2_000);
  });
});
