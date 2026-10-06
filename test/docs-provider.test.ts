// The Google Docs connection. Tests stub the network and pin the requests each
// tool sends, the rendering get_document returns, the edits it frames, and the
// failures it maps — H1, H9, H10, H11, and H14 for this provider. Delegation,
// subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCaller } from "../src/connector-caller.js";
import { DOCS_API_BASE_URL, DOCS_SCOPES, docs } from "../src/providers/docs.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { AuthenticatedIdentity, Connector, ConnectorContext, ConnectorUsageGuide } from "../src/types.js";

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

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

const path = (index: number) => calls[index]!.url.pathname.replace("/v1", "");

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
    paragraph: { elements: pieces, paragraphStyle: { namedStyleType: "NORMAL_TEXT", direction: "LEFT_TO_RIGHT" }, ...extra },
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
  return { startIndex, endIndex: startIndex + content.length + 1, content: [paragraph(startIndex + 1, [run(content, startIndex + 1)])] };
}

const FIRST_TAB_BODY = {
  content: [
    { endIndex: 1, sectionBreak: { sectionStyle: {} } },
    heading(1, "Elders meeting\n", "TITLE"),
    heading(16, "Agenda\n", "HEADING_2"),
    paragraph(23, [run("See the ", 23), run("plan", 31, "https://example.org/plan"), run(" doc", 35, "https://example.org/plan"), run(" now.\n", 39)]),
    paragraph(45, [run("Budget\n", 45)], { bullet: { listId: "kix.ol", nestingLevel: 0 } }),
    paragraph(52, [run("Q3 | Q4\n", 52)], { bullet: { listId: "kix.ol", nestingLevel: 1 } }),
    paragraph(60, [run("Prayer\n", 60)], { bullet: { listId: "kix.ul", nestingLevel: 0 } }),
    paragraph(67, [
      run("Footnoted", 67),
      { startIndex: 76, endIndex: 77, footnoteReference: { footnoteId: "kix.fn1", footnoteNumber: "1" } },
      { startIndex: 77, endIndex: 78, inlineObjectElement: { inlineObjectId: "kix.img" } },
      { startIndex: 78, endIndex: 79, person: { personProperties: { name: "Ann Elder", email: "ann@church.example" } } },
      { startIndex: 79, endIndex: 80, richLink: { richLinkProperties: { title: "Budget sheet", uri: "https://docs.google.com/spreadsheets/d/s1" } } },
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
          "kix.img": { inlineObjectProperties: { embeddedObject: { title: "Roof photo", imageProperties: { contentUri: "https://lh3.example/x" } } } },
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

describe("docs() identity and surface (H1, H14)", () => {
  it("requires a purpose and names the routing fact in title, description, and guide", () => {
    expect(() => connection({ purpose: "" })).toThrow(/purpose/);
    expect(() => connection({ subject: undefined })).toThrow(/subject/);
    const connector = connection({ instructions: "Sermon drafts live in the Preaching folder." });
    expect(connector.title).toBe("Google Docs");
    expect(connector.description).toContain("Staff meeting notes");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line && !line.startsWith("#"))).toMatch(/cannot search or list/);
    expect(content).toContain("## Connection instructions\n\nSermon drafts live in the Preaching folder.");
    expect(content).toContain("Google Drive connection");
    expect(guide(connector).required).toBe(true);
  });

  it("has exactly the six tools, and no search, list, delete, or share tool", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "append_text",
      "batch_update_document",
      "create_document",
      "get_document",
      "insert_text",
      "replace_all_text",
    ]);
    expect(tools.some((tool) => /search|list|delete|trash|share/.test(tool.name))).toBe(false);
  });

  it("classifies the read as read-only, additive edits as non-destructive, and the rest as destructive", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(tools.filter((tool) => isExplicitlyReadOnly(tool)).map((tool) => tool.name)).toEqual(["get_document"]);
    expect(byName["get_document"]).toEqual({ readOnlyHint: true });
    for (const additive of ["create_document", "append_text", "insert_text"]) {
      expect(byName[additive], additive).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    for (const destructive of ["replace_all_text", "batch_update_document"]) {
      expect(byName[destructive], destructive).toEqual({ readOnlyHint: false, destructiveHint: true });
    }
    // Never self-exempt; no operator slot and no OAuth: the key is deployment config.
    expect(connector.approval).toBeUndefined();
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly the documents scope", () => {
    expect([...DOCS_SCOPES]).toEqual(["https://www.googleapis.com/auth/documents"]);
    expect(DOCS_API_BASE_URL).toBe("https://docs.googleapis.com/v1");
  });
});

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
    expect(result.elementsTruncated).toBe(false);
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
      body: { documentId: "d", tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content: [paragraph(1, [run("a🙏b\n", 1)])] } } }] },
    });
    const emoji = await call(connection(), "get_document", { documentId: "d", maxChars: 2 });
    expect(emoji.tabs[0].text.startsWith("a\n[… 3 more")).toBe(true);
  });

  it("reads one tab by id, and says which tabs exist when the id is wrong", async () => {
    route = () => ({ body: DOCUMENT });
    const one = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.child" });
    expect(one.tabs.map((tab: any) => tab.tabId)).toEqual(["t.child"]);

    const failure = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.nope" }).catch((error) => error);
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
      body: { documentId: "doc-2", title: "Old", revisionId: "r", body: { content: [paragraph(1, [run("Hello\n", 1)])] } },
    });
    const result = await call(connection(), "get_document", { documentId: "doc-2" });
    expect(result.tabs).toEqual([{ endIndex: 7, text: "Hello", textTruncated: false }]);
  });

  it("caps index rows across tabs and says so", async () => {
    const content = Array.from({ length: 2_100 }, (_, index) => paragraph(index + 1, [run("x\n", index + 1)]));
    route = () => ({ body: { documentId: "big", tabs: [{ tabProperties: { tabId: "t.0" }, documentTab: { body: { content } } }] } });
    const result = await call(connection(), "get_document", { documentId: "big", withIndexes: true, maxChars: 0 });
    expect(result.tabs[0].elements).toHaveLength(2_000);
    expect(result.elementsTruncated).toBe(true);
    expect(result.tabs[0].textTruncated).toBe(true);
  });
});

describe("editing a document", () => {
  it("creates a document from a title alone in one request", async () => {
    route = () => ({ body: { documentId: "new-1", title: "Minutes", revisionId: "r0", body: {} } });
    const result = await call(connection(), "create_document", { title: "Minutes" });
    expect(calls.map((entry) => `${entry.method} ${path(calls.indexOf(entry))}`)).toEqual(["POST /documents"]);
    expect(calls[0]!.body).toEqual({ title: "Minutes" });
    expect(result).toEqual({
      documentId: "new-1",
      title: "Minutes",
      revisionId: "r0",
      url: "https://docs.google.com/document/d/new-1/edit",
    });
  });

  it("writes an initial body as a second, separate insert at the end of the body", async () => {
    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate")
        ? { body: { documentId: "new-1", replies: [{}], writeControl: { requiredRevisionId: "r1" } } }
        : { body: { documentId: "new-1", title: "Minutes", revisionId: "r0" } };
    const result = await call(connection(), "create_document", { title: "Minutes", text: "Opened in prayer.\nQuorum present." });
    expect(path(1)).toBe("/documents/new-1:batchUpdate");
    expect(calls[1]!.body).toEqual({
      requests: [{ insertText: { text: "Opened in prayer.\nQuorum present.", endOfSegmentLocation: {} } }],
    });
    expect(result.revisionId).toBe("r1");
  });

  it("names the created document, unretryably, when its initial text fails", async () => {
    route = (request) =>
      request.url.pathname.endsWith(":batchUpdate")
        ? { status: 503, body: { error: { code: 503, message: "Backend unavailable." } } }
        : { body: { documentId: "new-1", title: "Minutes" } };
    const failure = await call(connection(), "create_document", { title: "Minutes", text: "x" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("Created document new-1");
    expect(failure.message).toContain("append_text");
  });

  it("appends at the end of the body or a tab, under a required revision", async () => {
    route = () => ({ body: { documentId: "doc-1", replies: [{}], writeControl: { requiredRevisionId: "rev-2" } } });
    const result = await call(connection(), "append_text", {
      documentId: "doc-1",
      text: "\nAction items follow.",
      tabId: "t.child",
      requiredRevisionId: "rev-1",
    });
    expect(calls[0]!.method).toBe("POST");
    expect(`${calls[0]!.url.origin}${calls[0]!.url.pathname}`).toBe(`${DOCS_API_BASE_URL}/documents/doc-1:batchUpdate`);
    expect(calls[0]!.body).toEqual({
      requests: [{ insertText: { text: "\nAction items follow.", endOfSegmentLocation: { tabId: "t.child" } } }],
      writeControl: { requiredRevisionId: "rev-1" },
    });
    expect(result).toEqual({ documentId: "doc-1", revisionId: "rev-2" });
  });

  it("inserts at an index, in the first tab unless one is named", async () => {
    route = () => ({ body: { documentId: "doc-1", replies: [{}] } });
    const result = await call(connection(), "insert_text", { documentId: "doc-1", index: 23, text: "Note: " });
    expect(calls[0]!.body).toEqual({ requests: [{ insertText: { text: "Note: ", location: { index: 23 } } }] });
    expect(result).toEqual({ documentId: "doc-1" });

    await call(connection(), "insert_text", { documentId: "doc-1", index: 5, text: "x", tabId: "t.0" });
    expect(calls[1]!.body.requests[0].insertText.location).toEqual({ index: 5, tabId: "t.0" });
  });

  it("replaces all text with match options and tab criteria, reporting the count", async () => {
    route = () => ({
      body: { documentId: "doc-1", replies: [{ replaceAllText: { occurrencesChanged: 3 } }], writeControl: { requiredRevisionId: "rev-9" } },
    });
    const result = await call(connection(), "replace_all_text", {
      documentId: "doc-1",
      find: "\\bQ(\\d)\\b",
      replaceWith: "Quarter",
      matchCase: true,
      regex: true,
      tabIds: ["t.0"],
    });
    expect(calls[0]!.body).toEqual({
      requests: [
        {
          replaceAllText: {
            containsText: { text: "\\bQ(\\d)\\b", matchCase: true, searchByRegex: true },
            replaceText: "Quarter",
            tabsCriteria: { tabIds: ["t.0"] },
          },
        },
      ],
    });
    expect(result).toEqual({ documentId: "doc-1", occurrencesChanged: 3, revisionId: "rev-9" });

    // Google leaves a zero count out of the reply; the answer still has one.
    route = () => ({ body: { documentId: "doc-1", replies: [{ replaceAllText: {} }] } });
    const none = await call(connection(), "replace_all_text", { documentId: "doc-1", find: "absent", replaceWith: "" });
    expect(calls[1]!.body.requests[0].replaceAllText).toEqual({
      containsText: { text: "absent", matchCase: false },
      replaceText: "",
    });
    expect(none.occurrencesChanged).toBe(0);
  });

  it("passes raw batchUpdate requests through verbatim and returns their replies", async () => {
    const requests = [
      { deleteContentRange: { range: { startIndex: 5, endIndex: 9 } } },
      { createNamedRange: { name: "agenda", range: { startIndex: 1, endIndex: 4 } } },
    ];
    route = () => ({
      body: { documentId: "doc-1", replies: [{}, { createNamedRange: { namedRangeId: "kix.nr1" } }], writeControl: { requiredRevisionId: "rev-3" } },
    });
    const result = await call(connection(), "batch_update_document", {
      documentId: "doc-1",
      requests,
      requiredRevisionId: "rev-2",
    });
    expect(calls[0]!.body).toEqual({ requests, writeControl: { requiredRevisionId: "rev-2" } });
    expect(result).toEqual({
      documentId: "doc-1",
      revisionId: "rev-3",
      replies: [{}, { createNamedRange: { namedRangeId: "kix.nr1" } }],
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
      ["batch_update_document", { documentId: "doc-1", requests: [{ insertText: {}, deleteContentRange: {} }], requiredRevisionId: "r" }],
      // An unknown kind, and a Developer Preview one, are refused by name.
      ["batch_update_document", { documentId: "doc-1", requests: [{ deleteEverything: {} }], requiredRevisionId: "r" }],
      ["batch_update_document", { documentId: "doc-1", requests: [{ insertComment: {} }], requiredRevisionId: "r" }],
      ["batch_update_document", { documentId: "doc-1", requests: Array.from({ length: 101 }, () => ({ insertText: {} })), requiredRevisionId: "r" }],
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
  it("answers a stale requiredRevisionId with conflict, after one read of the current revision", async () => {
    route = (request) =>
      request.method === "POST"
        ? { status: 400, body: { error: { code: 400, message: "Precondition check failed.", status: "FAILED_PRECONDITION" } } }
        : { body: { revisionId: "rev-7" } };
    const failure = await call(connection(), "insert_text", {
      documentId: "doc-1",
      index: 5,
      text: "x",
      requiredRevisionId: "rev-1",
    }).catch((error) => error);
    expect(failure).toMatchObject({ code: "conflict", retryable: false });
    expect(failure.message).toContain("rev-7");
    expect(failure.message).toContain("Nothing was applied");
    expect(calls.map((entry) => `${entry.method} ${path(calls.indexOf(entry))}`)).toEqual([
      "POST /documents/doc-1:batchUpdate",
      "GET /documents/doc-1",
    ]);
    expect(calls[1]!.url.searchParams.get("fields")).toBe("revisionId");
  });

  it("keeps Google's refusal when the revision has not moved, and reads nothing without one", async () => {
    route = (request) =>
      request.method === "POST"
        ? { status: 400, body: { error: { code: 400, message: "Index 500 must be less than the end index.", status: "INVALID_ARGUMENT" } } }
        : { body: { revisionId: "rev-1" } };
    await expect(
      call(connection(), "insert_text", { documentId: "doc-1", index: 500, text: "x", requiredRevisionId: "rev-1" }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("Index 500") });
    expect(calls).toHaveLength(2);

    calls.length = 0;
    await expect(call(connection(), "insert_text", { documentId: "doc-1", index: 500, text: "x" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(1);
  });

  it("states the 404 ambiguity: a document id that is unknown or not shared look alike", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
    const failure = await call(connection(), "get_document", { documentId: "nope" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("not visible to this account");
  });

  it("maps a permission refusal, a missing scope, and a rate limit by their fix", async () => {
    route = () => ({ status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } });
    await expect(call(connection(), "get_document", { documentId: "d" })).rejects.toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("may lack access"),
    });

    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Insufficient scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    });
    await expect(call(connection(), "get_document", { documentId: "d" })).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("https://www.googleapis.com/auth/documents"),
    });

    route = () => ({ status: 429, body: { error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" } } });
    await expect(call(connection(), "append_text", { documentId: "d", text: "x" })).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});

describe("whose documents", () => {
  const identity = (id: string): AuthenticatedIdentity => ({
    actor: { kind: "test-users", id, namespace: "https://identity.test" },
    subject: { namespace: "https://identity.test", id },
    principal: { namespace: "https://identity.test", id },
    interactive: true,
  });

  it("fails closed with no admitted caller, before any network call", async () => {
    const connector = connection({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@church.example` });
    await expect(call(connector, "get_document", { documentId: "doc-1" })).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining("no admitted caller"),
    });
    expect(tokenCalls).toBe(0);
    expect(calls).toEqual([]);
  });

  it("acts as the mapped account for an admitted caller", async () => {
    route = () => ({ body: DOCUMENT });
    const connector = connection({ subject: (who: AuthenticatedIdentity) => `${who.principal?.id}@church.example` });
    const ctx = attachCaller(context(), { identity: identity("ann"), authenticated: true });
    const result = (await connector.callTool("get_document", { documentId: "doc-1" }, ctx)) as any;
    expect(result.documentId).toBe("doc-1");
    expect(tokenCalls).toBe(1);
    expect(calls[0]!.url.pathname).toBe("/v1/documents/doc-1");
  });
});
