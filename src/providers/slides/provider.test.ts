// The Google Slides connection. test/goldens/slides pins each tool's catalog
// entry, requests, results and failure ladder; these tests stub the network
// for what the goldens do not reach: paging, cursor binding, result bounds,
// request translation, refusals before dispatch, and write outcomes.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slides } from "./index.js";
import { configureGuardedTransport } from "../../guarded-transport.js";
import { memoryStorage } from "../../storage/memory.js";
import { validateToolInput } from "../../validate.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

// Existing write cases use the same owned transport as a Node deployment.
function ownedTransport(): void {
  let restore: ReturnType<typeof configureGuardedTransport>;
  beforeEach(() => {
    restore = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  });
  afterEach(() => {
    configureGuardedTransport(restore);
  });
}

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

/** A reply: a JSON body and status, or a whole Response, or a dropped connection. */
type Route = (call: ApiCall) => { status?: number; body?: unknown; response?: () => Response } | undefined;

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
    if (reply.response) return reply.response();
    return Response.json(reply.body ?? {}, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

let accounts = 0;
function connection(overrides: Record<string, unknown> = {}): Connector {
  accounts += 1;
  return slides("decks", {
    purpose: "Sermon slides",
    serviceAccount: { clientEmail: `slides-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "pastor@church.example",
    ...overrides,
  } as Parameters<typeof slides>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

/** Text as Slides returns it: runs, an auto-text slide number, a paragraph end. */
function textContent(...runs: string[]) {
  return {
    textElements: [
      { startIndex: 0, endIndex: 1, paragraphMarker: { style: {} } },
      ...runs.map((content) => ({ textRun: { content, style: { bold: true } } })),
    ],
  };
}

function at(x: number, y: number, unit = "EMU") {
  return { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit };
}

/** The second slide as pages.get returns it. */

/** A layout as pages.get returns it: placeholders with their indexes. */

/**
 * A Post as Slides sends it, from the comments guide's sample response:
 * `contentHtml` beside `content`, and a PostAuthor whose `user` is the
 * stable `users/{id}`.
 */
function slidesPost(
  postId: string,
  content: string,
  author: Record<string, unknown> = { displayName: "Pat Pastor", me: true, user: "users/1001" },
  extra: Record<string, unknown> = {},
) {
  return {
    postId,
    content,
    contentHtml: `<span>${content}</span>`,
    author,
    createTime: "2026-10-01T10:13:12Z",
    updateTime: "2026-10-01T10:13:12Z",
    ...extra,
  };
}

const SAM = { displayName: "Sam Staff", me: false, user: "users/2002" };

/** CommentThreads as Slides sends them: open with replies, resolved, anonymous, imported, deleted. */
const THREADS = [
  {
    commentId: "c1",
    anchorId: "a1",
    status: "OPEN",
    plainTextQuote: "He is risen",
    headPost: slidesPost("p1", "Should this be bigger?"),
    replies: [
      slidesPost("p2", "Agreed.", SAM),
      slidesPost("p3", "", SAM, { commentAction: "RESOLVE", contentHtml: "" }),
    ],
  },
  {
    commentId: "c2",
    anchorId: "a2",
    status: "RESOLVED",
    headPost: slidesPost("p4", "Typo in the notes", { anonymous: true }),
  },
  {
    commentId: "c3",
    anchorId: "a3",
    status: "OPEN",
    headPost: slidesPost("p5", "From the old deck", { displayName: "Old Author" }, { fromImportedPresentation: true }),
    // A deleted post keeps its id; Slides empties its content and author.
    replies: [{ postId: "p6", deleted: true, createTime: "2026-10-02T09:00:00Z", updateTime: "2026-10-02T09:00:00Z" }],
  },
];

/** presentations.get with commentsViewMode=COMMENTS_VIEW_MODE_INCLUDED, under list_comments' mask. */
const COMMENT_DECK = {
  presentationId: "deck1",
  revisionId: "rev-1",
  commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
  comments: THREADS,
  slides: [
    {
      objectId: "p",
      commentAnchors: [
        {
          anchorId: "a1",
          objectAnchors: [{ objectId: "body", shapeTextAnchors: { ranges: [{ startIndex: 0, endIndex: 11 }] } }],
        },
      ],
      slideProperties: {
        notesPage: { objectId: "p_notes", commentAnchors: [{ anchorId: "a2", objectAnchors: [{ objectId: "n1" }] }] },
      },
    },
    // Anchored to the slide itself: the page, and no element.
    { objectId: "s2", commentAnchors: [{ anchorId: "a3", objectAnchors: [{ objectId: "s2" }] }] },
  ],
};

/** The first thread as list_comments projects it. */

/** A batchUpdate answer to one insertComment: the new thread, and the comment saved. */
function insertedComment(thread: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    presentationId: "deck1",
    replies: [
      {
        insertComment: {
          commentThread: {
            commentId: "c9",
            anchorId: "a9",
            status: "OPEN",
            headPost: slidesPost("p9", "Bigger?"),
            ...thread,
          },
        },
      },
    ],
    writeControl: { requiredRevisionId: "rev-2" },
    commentUpdateState: "ALL_SAVED",
    ...extra,
  };
}

describe("reading a deck (H9, H10)", () => {
  it("orders rotated and nested groups by their absolute positions", async () => {
    // ProtoJSON omits zero coefficients: a group turned 90° has no scale at
    // all, and reading its omissions as 1 would put A first.
    const turned = { shearX: -1, shearY: 1, translateY: 100, unit: "PT" };
    const shape = (objectId: string, x: number, y: number) => ({
      objectId,
      transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: "PT" },
      shape: { shapeType: "TEXT_BOX", text: textContent(objectId) },
    });
    route = () => ({
      body: {
        presentationId: "deck1",
        slides: [
          {
            objectId: "p",
            pageElements: [
              {
                objectId: "outer",
                transform: turned,
                elementGroup: { children: [shape("A", 10, 0), shape("B", 0, 20)] },
              },
              {
                objectId: "wrapper",
                // No transform at all is the identity, not a collapse to 0.
                elementGroup: {
                  children: [
                    {
                      objectId: "inner",
                      transform: turned,
                      elementGroup: { children: [shape("C", 200, 0), shape("D", 0, 300)] },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    const result = await call(connection(), "get_presentation", { presentationId: "deck1" });
    // Turned: (x, y) -> (-y, x + 100). B (-20, 100), A (0, 110), D (-300, 100), C (0, 300).
    expect(result.slides[0].elements.map((element: any) => element.objectId)).toEqual(["D", "B", "A", "C"]);
  });
});

/**
 * Replies larger than Slides' own — each kind's reply is an id or a count —
 * with ids nested beside long fields, to drive the summarizer that bounds
 * whatever Google sends.
 */
function bulkyReplies(count: number) {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? {
          duplicateObject: {
            objectId: `dup-${index}`,
            detail: {
              sourceId: `src-${index}`,
              status: "OK",
              note: "n".repeat(2_048),
              parts: [{ partId: `part-${index}-a`, body: "b".repeat(2_048) }],
            },
          },
        }
      : { createShape: { objectId: `shape-${index}`, blob: "x".repeat(2_048) } },
  );
}

/** Every kind of reply Slides' batchUpdate sends, from Discovery's `Response` schema. */

// The suites below walk megabytes of worst-case text to the end, so they
// get room past the default timeout on a loaded runner.
describe("every result is deliverable, in a program and directly", { timeout: 60_000 }, () => {
  /**
   * A program's host call carries at most 256 KiB of serialized JSON
   * (`MAX_HOST_RESULT_BYTES`); a direct call stashes more for connecta.result, up
   * to 8 MiB by default. A page under the first is under both.
   */
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  /**
   * The worst text for serialized size: a control character JSON escapes to
   * six bytes, and a four-byte emoji, alternating.
   */
  const heavy = (chars: number) => "\u0001😀".repeat(Math.ceil(chars / 3)).slice(0, chars);

  /**
   * A deck that overflows every bound connecta sets, while staying under the
   * 16 MiB the connector reads from Google: long escape-heavy text in every
   * element, alt text, notes, title, and a layout list of thousands.
   */
  function worstDeck(slideCount: number, elementsPerSlide: number, chars: number, altChars = 2_000) {
    return {
      presentationId: "big1",
      title: heavy(100_000),
      revisionId: "rev-1",
      layouts: Array.from({ length: 2_000 }, (_, index) => ({
        objectId: `layout_${index}`,
        layoutProperties: { name: "CUSTOM", displayName: heavy(200) },
      })),
      slides: Array.from({ length: slideCount }, (_, slide) => ({
        objectId: `s${slide}`,
        slideProperties: {
          notesPage: {
            notesProperties: { speakerNotesObjectId: `n${slide}` },
            pageElements: [{ objectId: `n${slide}`, shape: { text: textContent(heavy(chars)) } }],
          },
        },
        pageElements: Array.from({ length: elementsPerSlide }, (_, element) => ({
          objectId: `s${slide}_e${element}`,
          transform: at(element, element),
          ...(altChars > 0 ? { title: heavy(altChars) } : {}),
          shape: {
            shapeType: "TEXT_BOX",
            placeholder: { type: element === 0 ? "TITLE" : "BODY" },
            text: textContent(heavy(chars)),
          },
        })),
      })),
    };
  }

  it("cuts a slide too large for one result to fit, and says the result's size was why", async () => {
    route = () => ({ body: worstDeck(2, 4, 60_000) });
    const result = await call(connection(), "get_presentation", { presentationId: "big1", maxCharsPerSlide: 50_000 });
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    const [first] = result.slides;
    expect(first.truncated).toBe(true);
    expect(JSON.stringify(first)).toContain("this slide is larger than one result can carry");
    // The next slide starts the next page whole rather than being cut too.
    expect(result.slides).toHaveLength(1);
    expect(result.page.nextCursor).toBeTruthy();
    // The layout list is bounded and counts what it left out.
    expect(result.layoutsNotShown).toBeGreaterThan(0);
    expect(result.layouts.length + result.layoutsNotShown).toBe(2_000);
  });

  it("names a raw slide no result can carry instead of returning it", async () => {
    route = () => ({ body: worstDeck(2, 4, 60_000) });
    const result = await call(connection(), "get_presentation", { presentationId: "big1", raw: true });
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    expect(result.slides).toEqual([
      {
        objectId: "s0",
        rawNotShown: expect.stringMatching(/^This slide's raw JSON is \d+ bytes, more than one result can carry/),
      },
    ]);
    expect(result.page.nextCursor).toBeTruthy();
  });
});

describe("get_page and list_layouts: every page, element, and layout is reachable", { timeout: 60_000 }, () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  /** Long text whose every position is distinct, with emoji to test surrogate-safe cuts. */
  const long = (length: number) =>
    Array.from({ length }, (_, index) => (index % 997 === 0 ? "😀" : String.fromCharCode(97 + (index % 26))))
      .join("")
      .slice(0, length);
  const CONTINUES = /\n\[… \d+ more characters continue on the next page\]$/;

  /** Routes the deck to presentations.get and each page to pages.get. */
  function serve(deck: any, pages: Record<string, any> = {}) {
    route = (request) => {
      const match = /\/pages\/([^/]+)$/.exec(request.url.pathname);
      if (!match) return { body: deck };
      const id = decodeURIComponent(match[1]!);
      const page = pages[id] ?? deck.slides?.find((slide: any) => slide.objectId === id);
      return page
        ? { body: { revisionId: deck.revisionId, ...page } }
        : { status: 404, body: { error: { code: 404, message: "Not found", status: "NOT_FOUND" } } };
    };
  }

  /** Follow get_page from `cursor` to the end, gathering each page. */
  async function follow(connector: Connector, args: Record<string, unknown>, cursor?: string) {
    const pages: any[] = [];
    do {
      const page = await call(connector, "get_page", {
        presentationId: "deck1",
        ...args,
        ...(cursor ? { cursor } : {}),
      });
      expect(bytes(page)).toBeLessThan(BRIDGE_BYTES);
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && pages.length < 200);
    return pages;
  }

  it("continues text cut on a slide from its textCursor until the last character", async () => {
    const full = long(300_000);
    const deck = {
      presentationId: "deck1",
      revisionId: "rev-1",
      slides: [
        {
          objectId: "p",
          pageElements: [{ objectId: "essay", shape: { shapeType: "TEXT_BOX", text: textContent(full) } }],
        },
      ],
    };
    serve(deck);
    const connector = connection();
    const read = await call(connector, "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 50_000 });
    const [element] = read.slides[0].elements;
    let gathered = element.text.replace(/\n\[… \d+ more characters truncated; [^\]]*\]$/, "");
    expect(gathered.length).toBe(50_000);
    const pages = await follow(connector, { pageObjectId: "p" }, element.textCursor);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      for (const row of page.elements) {
        expect(row.textOffset).toBe(gathered.length);
        gathered += row.truncated ? row.text.replace(CONTINUES, "") : row.text;
      }
    }
    expect(gathered).toBe(full);
  });

  it("sends a raw element too large for one result in JSON chunks that parse back to it", async () => {
    const huge = {
      objectId: "essay",
      transform: at(0, 0),
      shape: {
        shapeType: "TEXT_BOX",
        text: { textElements: [{ textRun: { content: long(400_000), style: { bold: true } } }] },
      },
    };
    const small = { objectId: "small", transform: at(0, 0), shape: { shapeType: "TEXT_BOX" } };
    const page = { objectId: "p", pageType: "SLIDE", revisionId: "rev-1", pageElements: [small, huge, small] };
    route = () => ({ body: page });
    const pages = await follow(connection(), { pageObjectId: "p", raw: true });
    expect(calls[0]!.url.searchParams.get("fields")).toBeNull();
    expect(pages[0].properties).toEqual({ objectId: "p", pageType: "SLIDE", revisionId: "rev-1" });
    const entries = pages.flatMap((entry) => entry.elements);
    expect(entries[0]).toEqual(small);
    const chunks = entries.filter((entry: any) => entry.rawJson);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((entry: any) => entry.objectId === "essay")).toBe(true);
    let json = "";
    for (const { rawJson } of chunks) {
      expect(rawJson.offset).toBe(json.length);
      json += rawJson.json;
    }
    expect(JSON.parse(json)).toEqual(huge);
    expect(entries[entries.length - 1]).toEqual(small);
  });
});

describe("round three: content-bound cursors, the notes master, bounded replies and links", { timeout: 60_000 }, () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const letters = (length: number, from = 0) =>
    Array.from({ length }, (_, index) => String.fromCharCode(97 + ((index + from) % 26))).join("");

  it("binds a viewer's text cursor to the text, so a same-length edit is a conflict", async () => {
    // Ten characters inserted before the boundary and ten deleted after it:
    // the length is unchanged, and continuing would repeat ten characters.
    const before = letters(300_000);
    const after = `INSERTED!!${before.slice(0, 250_000)}${before.slice(250_010)}`;
    expect(after.length).toBe(before.length);
    const page = (content: string) => ({
      objectId: "p",
      pageElements: [{ objectId: "essay", shape: { shapeType: "TEXT_BOX", text: textContent(content) } }],
    });
    const connector = connection();
    route = () => ({ body: page(before) });
    const first = await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p" });
    expect(first.page.hasMore).toBe(true);
    route = () => ({ body: page(after) });
    await expect(
      call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p", cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("binds a viewer's raw cursor to the exact JSON, so an equal-byte edit is a conflict", async () => {
    // An emoji (four UTF-8 bytes) swapped for four ASCII letters: the same
    // serialized size, and chunks stitched from both would parse to neither.
    const content = (swap: string) => `${letters(200_000)}${swap}${letters(200_000, 3)}`;
    const page = (swap: string) => ({
      objectId: "p",
      pageElements: [
        { objectId: "essay", shape: { text: { textElements: [{ textRun: { content: content(swap) } }] } } },
      ],
    });
    expect(bytes(page("😀"))).toBe(bytes(page("abcd")));
    const connector = connection();
    route = () => ({ body: page("😀") });
    const first = await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p", raw: true });
    expect(first.page.hasMore).toBe(true);
    route = () => ({ body: page("abcd") });
    await expect(
      call(connector, "get_page", {
        presentationId: "deck1",
        pageObjectId: "p",
        raw: true,
        cursor: first.page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("round four: nested reply ids, and every write result bounded", () => {
  ownedTransport();
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const batch = (count: number) => ({
    presentationId: "deck1",
    requiredRevisionId: "rev-1",
    requests: Array.from({ length: count }, () => ({ createShape: {} })),
  });

  it("keeps every nested id while cutting long fields, and names what it cut", async () => {
    route = () => ({
      body: { presentationId: "deck1", replies: bulkyReplies(100), writeControl: { requiredRevisionId: "rev-2" } },
    });
    const result = await call(connection(), "batch_update_presentation", batch(100));
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    expect(result.replies).toHaveLength(100);
    expect(result.repliesNotShown).toBeUndefined();
    expect(result.replies[0]).toEqual({
      duplicateObject: {
        objectId: "dup-0",
        detail: { sourceId: "src-0", status: "OK", parts: [{ partId: "part-0-a" }] },
      },
      cut: ["duplicateObject.detail.note", "duplicateObject.detail.parts[0].body"],
    });
    expect(result.replies[1]).toEqual({ createShape: { objectId: "shape-1" }, cut: ["createShape.blob"] });
    expect(result.note).toMatch(/^Large reply fields are named in cut; every id is kept\./);
  });
});

describe("comments: the read path (#696)", { timeout: 60_000 }, () => {
  it("refuses a reply in any other view mode rather than pass off a list that may be missing threads", async () => {
    route = () => ({ body: { ...COMMENT_DECK, commentsViewMode: "COMMENTS_VIEW_MODE_OMITTED", comments: [] } });
    const failure = await call(connection(), "list_comments", { presentationId: "deck1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("COMMENTS_VIEW_MODE_OMITTED");
    expect(failure.message).toContain("may be incomplete");
  });

  it("pages threads by limit with one opaque cursor, each thread once and in order", async () => {
    route = () => ({ body: COMMENT_DECK });
    const connector = connection();
    const first = await call(connector, "list_comments", { presentationId: "deck1", limit: 2 });
    expect(first.threads.map((thread: any) => thread.commentId)).toEqual(["c1", "c2"]);
    expect(first.page.hasMore).toBe(true);
    const second = await call(connector, "list_comments", {
      presentationId: "deck1",
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.threads.map((thread: any) => thread.commentId)).toEqual(["c3"]);
    expect(second.page).toEqual({ hasMore: false, nextCursor: null });
  });

  describe("cursors are bound to the deck, the page, the revision, and the threads", () => {
    async function firstPage(connector: Connector, deck: any, args: Record<string, unknown> = {}) {
      route = () => ({ body: deck });
      const page = await call(connector, "list_comments", { presentationId: "deck1", limit: 1, ...args });
      expect(page.page.hasMore).toBe(true);
      return page.page.nextCursor as string;
    }

    it("is a conflict when an anchor moves to another element, with no revision and the threads unchanged", async () => {
      const deck = (objectId: string) => ({
        ...COMMENT_DECK,
        revisionId: undefined,
        slides: [{ objectId: "p", commentAnchors: [{ anchorId: "a2", objectAnchors: [{ objectId }] }] }],
      });
      const connector = connection();
      const cursor = await firstPage(connector, deck("shapeA"));
      route = () => ({ body: deck("shapeB") });
      await expect(
        call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor }),
      ).rejects.toMatchObject({
        code: "conflict",
      });
      // Unmoved, it continues, and places the thread where the anchor is.
      const fresh = await firstPage(connector, deck("shapeA"));
      const next = await call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor: fresh });
      expect(next.threads[0]).toMatchObject({ commentId: "c2", objectIds: ["shapeA"] });
    });
  });
});

describe("comments: writes (#696)", () => {
  ownedTransport();
  const sent = (index = 0) => calls[index]!.body.requests;

  it("comments on a page, an element, a range of text, a cell's text, or a whole cell, each as Slides' one anchor", async () => {
    route = () => ({ body: insertedComment() });
    const range = (startIndex: number, endIndex: number) => ({ type: "FIXED_RANGE", startIndex, endIndex });
    const cases = [
      [{ objectId: "p" }, { objectId: "p" }],
      [
        { objectId: "table", cell: { rowIndex: 1, columnIndex: 2 }, textRange: { startIndex: 0, endIndex: 3 } },
        {
          tableCellTextAnchor: {
            objectId: "table",
            cellLocation: { rowIndex: 1, columnIndex: 2 },
            textRange: range(0, 3),
          },
        },
      ],
      [
        { objectId: "table", cell: { rowIndex: 0, columnIndex: 0 } },
        {
          tableAnchor: {
            objectId: "table",
            tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 },
          },
        },
      ],
    ] as const;
    for (const [args, anchor] of cases) {
      calls.length = 0;
      await call(connection(), "create_comment", {
        presentationId: "deck1",
        content: "Bigger?",
        assigneeEmail: "sam@church.example",
        ...args,
      });
      expect(sent()).toEqual([
        { insertComment: { ...anchor, content: "Bigger?", assigneeEmailAddress: "sam@church.example" } },
      ]);
      expect(calls[0]!.body.writeControl).toBeUndefined();
    }
    calls.length = 0;
    await call(connection(), "create_comment", {
      presentationId: "deck1",
      objectId: "p",
      content: "Bigger?",
      requiredRevisionId: "rev-1",
    });
    expect(calls[0]!.body.writeControl).toEqual({ requiredRevisionId: "rev-1" });
  });
});

describe("comments: partial saves are reported, not hidden (#696)", () => {
  ownedTransport();
  const unsaved = {
    presentationId: "deck1",
    replies: [{}],
    writeControl: { requiredRevisionId: "rev-2" },
    commentUpdateState: "ALL_FAILED_UNKNOWN_REASON",
  };

  function expectReported(result: any, state: string) {
    expect(result.commentUpdateState).toBe(state);
    expect(result.note).toContain("not all or none");
    expect(result.note).toContain("other changes may have applied");
    expect(result.note).toContain("Do not repeat it");
    expect(result.note).toContain("list_comments");
    expect(result.note).not.toMatch(/nothing (was|is) (applied|changed)/i);
  }

  it.each([
    ["create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" }],
    ["create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done" }],
    ["delete_comment", { presentationId: "deck1", commentId: "c1" }],
  ])("%s reports a 2xx whose comment change did not save, as a result rather than a failure", async (name, args) => {
    route = () => ({ body: unsaved });
    const result = await call(connection(), name, args);
    expect(result.presentationId).toBe("deck1");
    expect(result.revisionId).toBe("rev-2");
    expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
  });

  it("reports a comment write Slides gave no state for as unspecified, since nothing said it saved", async () => {
    route = () => ({ body: { presentationId: "deck1", replies: [{}] } });
    const result = await call(connection(), "delete_comment", { presentationId: "deck1", commentId: "c1" });
    expectReported(result, "COMMENT_UPDATE_STATE_UNSPECIFIED");
  });

  describe("in the raw hatch", () => {
    const batch = (...requests: Record<string, unknown>[]) => ({
      presentationId: "deck1",
      requiredRevisionId: "rev-1",
      requests,
    });

    it("cuts text before ids even when every reply is small: 100 replies of about 2 KB each stay under the budget", async () => {
      const posts = Array.from({ length: 100 }, (_, index) =>
        slidesPost(`p${index}`, "w".repeat(890), SAM, { contentHtml: "h".repeat(890) }),
      );
      route = () => ({
        body: {
          presentationId: "deck1",
          replies: posts.map((post) => ({ addCommentReply: { post } })),
          commentUpdateState: "ALL_SAVED",
        },
      });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch(...posts.map(() => ({ addCommentReply: { commentId: "c1", post: { content: "w" } } }))),
      );
      const size = new TextEncoder().encode(JSON.stringify(result)).length;
      expect(size).toBeLessThanOrEqual(192 * 1024);
      expect(result.replies.map((reply: any) => reply.addCommentReply.post.postId)).toEqual(
        posts.map((post) => post.postId),
      );
      expect(result.replies.map((reply: any) => reply.addCommentReply.post.author.user)).toEqual(
        posts.map(() => "users/2002"),
      );
      // The later replies gave up their text so every one keeps its ids.
      expect(result.replies.at(-1).cut).toEqual([expect.stringContaining("ids only")]);
      expect(result.note).toContain("every id is kept");
      expect(result.note).not.toContain("execute_code");
    });

    it("keeps the save state and the way back when even the ids pass any result, and never says applied", async () => {
      const longId = (prefix: string, index: number) => `${prefix}${index}_${"i".repeat(1_000)}`;
      const threads = Array.from({ length: 100 }, (_, index) => ({
        commentId: longId("c", index),
        anchorId: longId("a", index),
        status: "OPEN",
        headPost: { postId: longId("p", index), author: { user: `users/${longId("u", index)}` } },
        replies: Array.from({ length: 21 }, (_, reply) => ({
          postId: longId(`r${reply}_`, index),
          author: { user: `users/${longId(`v${reply}_`, index)}` },
        })),
      }));
      route = () => ({
        body: {
          presentationId: "deck1",
          replies: threads.map((commentThread) => ({ insertComment: { commentThread } })),
          commentUpdateState: "ALL_FAILED_UNKNOWN_REASON",
          writeControl: { requiredRevisionId: "rev-2" },
        },
      });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch(...threads.map(() => ({ insertComment: { objectId: "p", content: "x" } }))),
      );
      expect(result.revisionId).toBe("rev-2");

      expect(result.replies).toEqual([]);
      expect(result.repliesNotShown).toBe(100);
      expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
      expect(result.note).toContain("Slides accepted the batch");
      expect(result.note).toContain("Do not send it again");
      expect(result.note).toContain("list_comments has the comments and posts it created");
      expect(result.note).not.toMatch(/(batch|write) applied|applied —/i);
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(4 * 1024);
    });

    it("reports a batch with comment requests and no state as unspecified, and one without them as settled", async () => {
      route = () => ({ body: { presentationId: "deck1", replies: [{}] } });
      expectReported(
        await call(connection(), "batch_update_presentation", batch({ deleteComment: { commentId: "c1" } })),
        "COMMENT_UPDATE_STATE_UNSPECIFIED",
      );
      for (const state of [undefined, "NO_UPDATES_REQUESTED", "ALL_SAVED"]) {
        route = () => ({
          body: { presentationId: "deck1", replies: [{}], ...(state ? { commentUpdateState: state } : {}) },
        });
        const result = await call(
          connection(),
          "batch_update_presentation",
          batch({ deleteObject: { objectId: "x" } }),
        );
        expect(result.commentUpdateState, state).toBeUndefined();
        expect(result.note, state).toBeUndefined();
      }
      // A failure Slides reports for a batch with no comments is still said.
      route = () => ({ body: unsaved });
      expectReported(
        await call(connection(), "batch_update_presentation", batch({ deleteObject: { objectId: "x" } })),
        "ALL_FAILED_UNKNOWN_REASON",
      );
    });

    it("reports a batch whose deck changes applied and whose comments did not", async () => {
      route = () => ({ body: { ...unsaved, replies: [{}, {}] } });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch({ insertText: { objectId: "t", text: "x" } }, { insertComment: { objectId: "p", content: "c" } }),
      );
      expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
      expect(result.note).toContain(
        "re-read with get_presentation or get_page for deck changes, and list_comments for comments",
      );
    });

    it("never says a comment-only batch applied when Slides did not confirm its comments, even with a summarized reply", async () => {
      const content = "c".repeat(2_048);
      route = () => ({
        body: insertedComment(
          { plainTextQuote: content, headPost: slidesPost("p9", content) },
          { commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" },
        ),
      });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch({ insertComment: { objectId: "p", content } }),
      );
      expect(result.replies[0].cut.length).toBeGreaterThan(0);
      expect(result.replies[0].insertComment.commentThread.commentId).toBe("c9");
      expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
      expect(result.note).not.toMatch(/(write|batch) applied/i);
      expect(result.note).toContain("Slides accepted the write but did not report its comment changes saved");
    });
  });
});

describe("comments: raw: true (#696)", { timeout: 60_000 }, () => {
  it("returns each thread as Slides sends it, with the anchors and fields the projection drops", async () => {
    const copied = { ...THREADS[1], headPost: { ...THREADS[1]!.headPost, fromCopiedPresentation: true } };
    route = () => ({ body: { ...COMMENT_DECK, comments: [THREADS[0], copied, THREADS[2]] } });
    const connector = connection();
    const tool = (await connector.listTools(context())).find((entry) => entry.name === "list_comments")!;
    const result = await call(connector, "list_comments", { presentationId: "deck1", raw: true });
    expect(calls[0]!.url.searchParams.get("commentsViewMode")).toBe("COMMENTS_VIEW_MODE_INCLUDED");
    expect(result.total).toBe(3);
    expect(result.threads[0]).toEqual({
      ...THREADS[0],
      commentAnchors: [{ pageObjectId: "p", ...COMMENT_DECK.slides[0]!.commentAnchors[0] }],
    });
    // contentHtml, fromCopiedPresentation, and the anchor's text ranges.
    expect(result.threads[0].headPost.contentHtml).toBe("<span>Should this be bigger?</span>");
    expect(result.threads[0].commentAnchors[0].objectAnchors[0].shapeTextAnchors.ranges).toEqual([
      { startIndex: 0, endIndex: 11 },
    ]);
    expect(result.threads[1].headPost.fromCopiedPresentation).toBe(true);
    expect(result.threads[1].commentAnchors).toEqual([
      { pageObjectId: "p_notes", anchorId: "a2", objectAnchors: [{ objectId: "n1" }] },
    ]);
    expect(
      validateToolInput(tool.outputSchema!, result, {
        address: "decks.list_comments",
        logger: silentLogger,
        failClosed: true,
      })?.message,
    ).toBeUndefined();
  });

  it("sends a thread too large for one result in JSON chunks that parse back to it, under the same budget and binding", async () => {
    const replies = Array.from({ length: 40 }, (_, index) => slidesPost(`r${index}`, "z".repeat(10_000), SAM));
    const big = { ...THREADS[0], replies };
    route = () => ({ body: { ...COMMENT_DECK, comments: [THREADS[1], big, THREADS[2]] } });
    const connector = connection();
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "list_comments", {
        presentationId: "deck1",
        raw: true,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && pages.length < 50);
    for (const page of pages) expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThan(256 * 1024);
    const rows = pages.flatMap((page) => page.threads);
    expect(rows[0].commentId).toBe("c2");
    const chunks = rows.filter((row: any) => row.rawJson);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((row: any) => row.commentId === "c1")).toBe(true);
    const whole = JSON.parse(chunks.map((row: any) => row.rawJson.json).join(""));
    expect(whole.replies.map((reply: any) => reply.postId)).toEqual(replies.map((reply) => reply.postId));
    expect(whole.commentAnchors[0].pageObjectId).toBe("p");
    expect(rows.at(-1).commentId).toBe("c3");
    // A raw cursor does not continue a projected read, nor the other way.
    route = () => ({ body: { ...COMMENT_DECK, comments: [THREADS[1], big, THREADS[2]] } });
    const projected = await call(connector, "list_comments", { presentationId: "deck1", limit: 1 });
    calls.length = 0;
    await expect(
      call(connector, "list_comments", { presentationId: "deck1", raw: true, cursor: projected.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("raw: false") });
    await expect(
      call(connector, "list_comments", { presentationId: "deck1", cursor: pages[0].page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("raw: true") });
    expect(calls).toEqual([]);
  });
});

describe("comments: a thread whose anchors alone pass one result (#696)", () => {
  it("says raw: true pages it, and raw: true does", async () => {
    const objectAnchors = Array.from({ length: 300 }, (_, index) => ({ objectId: `e${index}_${"o".repeat(900)}` }));
    route = () => ({
      body: {
        ...COMMENT_DECK,
        comments: THREADS.slice(0, 1),
        slides: [{ objectId: "p", commentAnchors: [{ anchorId: "a1", objectAnchors }] }],
      },
    });
    const failure = await call(connection(), "list_comments", { presentationId: "deck1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed" });
    expect(failure.message).toContain("raw: true pages it in JSON chunks");
    const connector = connection();
    const rows: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "list_comments", {
        presentationId: "deck1",
        raw: true,
        ...(cursor ? { cursor } : {}),
      });
      rows.push(...page.threads);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && rows.length < 50);
    const whole = JSON.parse(rows.map((row) => row.rawJson.json).join(""));
    expect(whole.commentAnchors[0].objectAnchors).toHaveLength(300);
  });
});
