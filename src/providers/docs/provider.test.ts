// The Google Docs connection. test/goldens/docs pins each tool's catalog entry,
// requests, results and failure ladder; these tests stub the network for what
// the goldens do not reach: rendering every element kind, index paging, result
// and hatch ceilings, refusals before dispatch, and write outcomes. Delegation,
// subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { docs } from "./index.js";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { memoryStorage } from "../../storage/memory.js";
import { usesCallerIdentity } from "../../connector-caller.js";
import { createExecuteTool } from "../../execute.js";
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

let sharedContext = context();
beforeEach(() => {
  sharedContext = context();
});

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, sharedContext) as Promise<any>;
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

describe("reading a document (H9)", () => {
  it("returns the start and end index of every paragraph, table, and table of contents on withIndexes", async () => {
    route = () => ({ body: DOCUMENT });
    const result = await call(connection(), "get_document", { documentId: "doc-1", tabId: "t.0", withIndexes: true });
    expect(result.tabs).toHaveLength(1);
    expect(result.page).toEqual({ hasMore: false });
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
    // Field selection cannot turn a shortened rendering into a complete-looking result.
    expect(
      await call(connection(), "get_document", {
        documentId: "doc-1",
        tabId: "t.0",
        maxChars: 0,
        fields: ["documentId"],
      }),
    ).toEqual({ documentId: "doc-1", truncated: ["tabs[0].text"] });
    expect(await call(connection(), "get_document", { documentId: "doc-1", fields: ["documentId"] })).toEqual({
      documentId: "doc-1",
    });
    const indexed = await call(connection(), "get_document", {
      documentId: "doc-1",
      tabId: "t.0",
      withIndexes: true,
      maxChars: 0,
      fields: ["tabs.elements"],
    });
    expect(indexed.page).toEqual({ hasMore: false });
    expect(indexed.truncated).toContain("tabs[0].text");
    expect(indexed.documentId).toBeUndefined();
    const beforeInvalidFields = calls.length;
    await expect(
      call(connection(), "get_document", { documentId: "doc-1", fields: ["invented"] }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(beforeInvalidFields);
  });

  it("INV-3 INV-4: pages index rows once and binds continuation to the delegated caller", async () => {
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
    let firstCursor: string | undefined;
    do {
      const result: any = await call(connection(), "get_document", {
        documentId: "big",
        withIndexes: true,
        maxChars: 0,
        ...(cursor ? { cursor } : {}),
      });
      pages += 1;
      firstCursor ??= result.page.nextCursor;
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(96 * 1024);
      for (const each of result.tabs) for (const row of each.elements) seen.push(row.text);
      expect(result.page.hasMore).toBe(result.page.nextCursor !== undefined);
      cursor = result.page.nextCursor ?? undefined;
    } while (cursor && pages < 50);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(3_000);
    expect(new Set(seen).size).toBe(3_000);
    expect(seen[0]).toBe("t.0 row 0");
    expect(seen[2_999]).toBe("t.1 row 1499");
    expect(firstCursor).toBeTruthy();
    const connector = connection();
    const before = calls.length;
    for (const args of [
      { documentId: "other", withIndexes: true, maxChars: 0, cursor: firstCursor },
      { documentId: "big", withIndexes: true, maxChars: 1, cursor: firstCursor },
      { documentId: "big", withIndexes: true, maxChars: 0, cursor: "e:500" },
      { documentId: "big", withIndexes: true, maxChars: 0, cursor: firstCursor!.slice(0, -5) + "aaaaa" },
    ])
      await expect(call(connector, "get_document", args)).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(before);
    // A real mapped provider carries the identity tag through its public factory.
    // Both callers share the same root store and can reach the same document.
    const mapped = connection({ subject: (who: { principal?: { id: string } }) => `${who.principal?.id}@example.com` });
    expect(usesCallerIdentity(mapped)).toBe(true);
    const registry = makeRegistry([mapped]);
    const callerContext = (id: string) =>
      registry
        .scoped({
          connectorIds: "all",
          caller: {
            authenticated: true,
            identity: {
              actor: { kind: "test-users", id },
              subject: { namespace: "https://identity.test", id },
              principal: { namespace: "https://identity.test", id },
              interactive: true,
            },
          },
        })
        .contextFor("docs", "https://connecta.example");
    const pagingArgs = { documentId: "big", withIndexes: true, maxChars: 0 };
    const alicePage = (await mapped.callTool("get_document", pagingArgs, callerContext("alice"))) as any;
    const continuation = { ...pagingArgs, cursor: alicePage.page.nextCursor };
    const sentBeforeBob = calls.length,
      mintedBeforeBob = tokenCalls;
    await expect(mapped.callTool("get_document", continuation, callerContext("bob"))).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(sentBeforeBob);
    expect(tokenCalls).toBe(mintedBeforeBob);
    const aliceNext = (await mapped.callTool("get_document", continuation, callerContext("alice"))) as any;
    expect(calls).toHaveLength(sentBeforeBob + 1);
    expect(aliceNext.tabs.flatMap((tab: any) => tab.elements)[0].text).not.toBe(alicePage.tabs[0].elements[0].text);
    route = () => ({ body: { documentId: "big", revisionId: "new", tabs: [tab("t.0", 1500)] } });
    await expect(
      call(connector, "get_document", { documentId: "big", withIndexes: true, maxChars: 0, cursor: firstCursor }),
    ).rejects.toMatchObject({ code: "conflict" });
  }, 10_000);
});

describe("editing a document", () => {
  beforeEach(() => {
    installOwnedTransport();
  });
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
    expect(projected).toMatchObject({ documentId: "doc-1", revisionId: "r2", truncated: ["replies[]"] });
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
    expect(cut.truncated).toEqual(["replies[]"]);
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
    });
  });
});

describe("failures, mapped to what the caller does next (H11)", () => {
  beforeEach(() => {
    installOwnedTransport();
  });
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

  it("keeps the kit's uncertain-write advice after a 2xx body breaks", async () => {
    route = () => ({ brokenBody: true });
    const failure = await call(connection(), "append_text", { documentId: "d", text: "x" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure).toMatchObject({ writeOutcome: "unknown" });
    expect(failure.message).toContain("check the target before repeating it");
    expect(failure.message).not.toContain("The outcome of this edit is unknown");
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
    const registry = makeRegistry([connection()]);
    const sentBeforeProgram = calls.length;
    const program = await createExecuteTool(
      registry,
      "https://connecta.example",
      {
        async execute(_code, providers) {
          try {
            await providers.find((provider) => provider.name === "connecta")!.fns["call"]!("docs.create_document", {
              title: "Minutes",
              text: "x",
            });
          } catch {
            /* A caught partial create must retain its reconciliation fact. */
          }
          return { result: "caught" };
        },
      },
      silentLogger,
      undefined,
      { readOnly: false },
    )({ code: "async () => null" });
    expect(program.structuredContent).toMatchObject({
      error: { code: "write_outcome_unknown", uncertainCall: { recovery: { documentId: "new-1" } } },
    });
    expect(calls).toHaveLength(sentBeforeProgram + 2);
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

describe("indexed Docs surface", () => {
  it("INV-1 INV-2 INV-9: admits full JSON reads and guarded batches without widening preview or credential access", async () => {
    installOwnedTransport();
    const connector = connection();
    route = () => ({
      body: {
        ...DOCUMENT,
        headers: { h1: { content: [] } },
        namedRanges: { agenda: { namedRanges: [] } },
        inlineObjects: {
          image: {
            inlineObjectProperties: {
              embeddedObject: {
                imageProperties: {
                  contentUri: "https://images.example/private",
                  sourceUri: "https://example.com/image",
                },
              },
            },
          },
        },
      },
    });
    const reply = await call(connector, "docs_api_read", {
      path: "/documents/doc-1",
      query: { includeTabsContent: true },
      fields: ["documentId", "headers", "namedRanges", "inlineObjects"],
    });
    expect(reply).toMatchObject({ status: 200, data: { documentId: "doc-1", headers: { h1: { content: [] } } } });
    expect(reply.data.inlineObjects.image.inlineObjectProperties.embeddedObject.imageProperties).toEqual({
      contentUri: "[redacted]",
      sourceUri: "https://example.com/image",
    });
    const { DOCS_INDEX, DOCS_VERDICTS } = await import("./lib/discovery.js");
    expect(DOCS_INDEX.pathMatching).toBe("uri-template");
    expect(DOCS_INDEX.ops.map((op) => `${op.method} ${op.path}`).sort()).toEqual(Object.keys(DOCS_VERDICTS).sort());
    for (const query of [
      "append paragraph",
      "insert text at index",
      "replace all text",
      "format document text",
      "delete text range",
      "bold",
      "add header",
      "create table",
    ]) {
      const found = await call(connector, "docs_api_search", { query });
      expect(found.operations.slice(0, 2).some((op: { path: string }) => op.path.endsWith(":batchUpdate"))).toBe(true);
    }
    for (const query of ["create a document", "add blank document"]) {
      const found = await call(connector, "docs_api_search", { query });
      expect(found.operations.slice(0, 2).some((op: { path: string }) => op.path === "/documents")).toBe(true);
    }
    expect(DOCS_INDEX.ops.every((op) => op.summary.length <= 120)).toBe(true);
    for (const query of ["document named ranges", "document styles", "read document tabs"]) {
      const found = await call(connector, "docs_api_search", { query });
      expect(found.operations.slice(0, 2).some((op: { method: string }) => op.method === "GET")).toBe(true);
    }
    expect(calls.at(-1)?.url.pathname).toBe("/v1/documents/doc-1");
    expect(calls.at(-1)?.url.searchParams.get("includeTabsContent")).toBe("true");
    const sent = calls.length;
    const mints = tokenCalls;
    for (const args of [
      { path: "/documents/doc-1", fields: ["invented"] },
      { path: "/documents/doc-1", query: { access_token: "caller-token" } },
      { path: "/documents/doc-1", query: { alt: "media" } },
      { path: "/documents/doc-1", headers: { Authorization: "Bearer caller-token" } },
      { path: "/v1/documents/doc-1" },
    ])
      await expect(call(connection(), "docs_api_read", args)).rejects.toMatchObject({ code: "invalid_args" });
    for (const body of [
      { requests: [{ insertText: { text: "x" } }] },
      { requests: [], writeControl: { requiredRevisionId: "r1" } },
      { requests: [{ createComment: {} }], writeControl: { requiredRevisionId: "r1" } },
      { requests: [{ insertText: {}, deleteContentRange: {} }], writeControl: { requiredRevisionId: "r1" } },
      { requests: Array.from({ length: 101 }, () => ({ insertText: {} })), writeControl: { requiredRevisionId: "r1" } },
      { requests: [{ insertText: {} }], writeControl: { requiredRevisionId: " " } },
    ]) {
      await expect(
        call(connection(), "docs_api_write", { method: "POST", path: "/documents/doc-1:batchUpdate", body }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      await expect(
        call(connection(), "batch_update_document", {
          documentId: "doc-1",
          requests: body.requests,
          requiredRevisionId: body.writeControl?.requiredRevisionId,
        }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toHaveLength(sent);
    expect(tokenCalls).toBe(mints);
    route = () => ({ body: { documentId: "doc-1", replies: [{}], writeControl: { requiredRevisionId: "r2" } } });
    const body = {
      requests: [
        { updateTextStyle: { range: { startIndex: 1, endIndex: 4 }, textStyle: { bold: true }, fields: "bold" } },
      ],
      writeControl: { requiredRevisionId: "r1" },
    };
    expect(
      await call(connector, "docs_api_write", { method: "POST", path: "/documents/doc-1:batchUpdate", body }),
    ).toMatchObject({ status: 200, data: { documentId: "doc-1" } });
    expect(calls).toHaveLength(sent + 1);
    expect(calls.at(-1)?.body).toEqual(body);
    route = () => ({ status: 400, body: { error: { status: "FAILED_PRECONDITION" } } });
    await expect(
      call(connector, "docs_api_write", { method: "POST", path: "/documents/doc-1:batchUpdate", body }),
    ).rejects.toMatchObject({ code: "conflict", retryable: false });
    expect(calls).toHaveLength(sent + 2);
    expect(connection({ readOnly: true }).readOnly).toBe(true);
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
});

// Cases here push 9 MiB fields and replies near the 192 KiB budget through
// whole calls: CPU-bound, with no timing behavior,
// and seconds long even on an idle machine. A loaded one ran them past
// vitest's 5s default, so this is a hang guard, not a speed assertion.
describe("round-3 review: outcomes by observed status, bounded copies, one final guard", { timeout: 60_000 }, () => {
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
