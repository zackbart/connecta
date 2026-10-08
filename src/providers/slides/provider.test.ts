// The Google Slides connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, and the classifications it
// declares — H1, H9, H10, and H11 for this provider. Delegation, subjects, and
// tokens are test/google-workspace-delegation.test.ts; the one subject check
// here proves this provider rides the same fail-closed path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLIDES_API_BASE_URL, SLIDES_SCOPES, slides } from "./index.js";
import { memoryStorage } from "../../storage/memory.js";
import { classifyTool } from "../../tool-safety.js";
import { validateToolInput } from "../../validate.js";
import { compactDiscoverySchema, MAX_COMPACT_DISCOVERY_SCHEMA_BYTES, typescriptSignature } from "../../catalog.js";
import { buildSandboxProviders } from "../../execute.js";
import { createMetaTools } from "../../meta-tools.js";
import { makeRegistry, required, silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide, JsonSchema } from "../../types.js";

const isRead = (tool: import("../../types.js").ToolDef) => classifyTool(tool) === "read";

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

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
}

const path = (index: number) => calls[index]!.url.pathname.replace("/v1", "");

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

const PRESENTATION = {
  presentationId: "deck1",
  title: "Easter Sunday",
  revisionId: "rev-1",
  locale: "en",
  pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
  layouts: [
    { objectId: "L1", layoutProperties: { name: "TITLE", displayName: "Title slide" } },
    { objectId: "L2", layoutProperties: { name: "TITLE_AND_BODY", displayName: "Title and body" } },
  ],
  slides: [
    {
      objectId: "p",
      slideProperties: {
        layoutObjectId: "L1",
        notesPage: {
          objectId: "p_notes",
          notesProperties: { speakerNotesObjectId: "n1" },
          pageElements: [
            { objectId: "slideImage", image: { contentUrl: "https://x" } },
            { objectId: "n1", shape: { shapeType: "TEXT_BOX", text: textContent("Welcome everyone.\n") } },
          ],
        },
      },
      pageElements: [
        // Listed out of reading order: z-order is not position.
        { objectId: "body", transform: at(311700, 2000000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "SUBTITLE" }, text: textContent("He is risen\u000bindeed\n") } },
        { objectId: "title", transform: at(311700, 744575), shape: { shapeType: "TEXT_BOX", placeholder: { type: "CENTERED_TITLE" }, text: textContent("Easter ", "Sunday\n") } },
        { objectId: "rule", transform: at(0, 1500000), line: { lineType: "STRAIGHT_LINE" } },
        { objectId: "box", transform: at(0, 1600000), shape: { shapeType: "RECTANGLE" } },
      ],
    },
    {
      objectId: "s2",
      slideProperties: { layoutObjectId: "L2", isSkipped: true },
      pageElements: [
        {
          // A group moved right by 100 pt: its children sit after the photo.
          objectId: "group",
          transform: { scaleX: 1, scaleY: 1, translateX: 100, translateY: 0, unit: "PT" },
          elementGroup: {
            children: [
              { objectId: "g-table", transform: at(0, 1270000), table: { rows: 2, columns: 2, tableRows: [
                { tableCells: [{ text: textContent("Time\n") }, { text: textContent("Service\n") }] },
                { tableCells: [{ text: textContent("9:00\n") }, { text: textContent("Sunrise\nservice\n") }] },
              ] } },
            ],
          },
        },
        { objectId: "photo", transform: at(0, 1270000), title: "Empty tomb", description: "Sunrise photo", image: { contentUrl: "https://lh3/x" } },
        { objectId: "chart", transform: at(0, 3000000), sheetsChart: { spreadsheetId: "sheet1" } },
      ],
    },
    { objectId: "s3", slideProperties: { layoutObjectId: "L2" }, pageElements: [] },
  ],
};

/** The second slide as pages.get returns it. */
const SLIDE_PAGE = {
  ...PRESENTATION.slides[1]!,
  pageType: "SLIDE",
  revisionId: "rev-1",
  slideProperties: { layoutObjectId: "L2", masterObjectId: "M1", isSkipped: true, notesPage: { objectId: "s2_notes" } },
};

/** A layout as pages.get returns it: placeholders with their indexes. */
const LAYOUT_PAGE = {
  objectId: "L2",
  pageType: "LAYOUT",
  revisionId: "rev-1",
  layoutProperties: { name: "TITLE_AND_BODY", displayName: "Title and body", masterObjectId: "M1" },
  pageProperties: { pageBackgroundFill: { solidFill: { color: { themeColor: "LIGHT1" } } } },
  pageElements: [
    { objectId: "L2_body", transform: at(0, 2000000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY", index: 0, parentObjectId: "M1_body" } } },
    { objectId: "L2_title", transform: at(0, 400000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE", parentObjectId: "M1_title" } } },
  ],
};

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
  { commentId: "c2", anchorId: "a2", status: "RESOLVED", headPost: slidesPost("p4", "Typo in the notes", { anonymous: true }) },
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
        { anchorId: "a1", objectAnchors: [{ objectId: "body", shapeTextAnchors: { ranges: [{ startIndex: 0, endIndex: 11 }] } }] },
      ],
      slideProperties: { notesPage: { objectId: "p_notes", commentAnchors: [{ anchorId: "a2", objectAnchors: [{ objectId: "n1" }] }] } },
    },
    // Anchored to the slide itself: the page, and no element.
    { objectId: "s2", commentAnchors: [{ anchorId: "a3", objectAnchors: [{ objectId: "s2" }] }] },
  ],
};

/** The first thread as list_comments projects it. */
const C1 = {
  commentId: "c1",
  anchorId: "a1",
  status: "OPEN",
  pageObjectIds: ["p"],
  objectIds: ["body"],
  replyCount: 2,
  quote: "He is risen",
  headPost: {
    postId: "p1",
    author: { user: "users/1001", displayName: "Pat Pastor", me: true },
    content: "Should this be bigger?",
    createTime: "2026-10-01T10:13:12Z",
    updateTime: "2026-10-01T10:13:12Z",
  },
  replies: [
    {
      postId: "p2",
      author: { user: "users/2002", displayName: "Sam Staff" },
      content: "Agreed.",
      createTime: "2026-10-01T10:13:12Z",
      updateTime: "2026-10-01T10:13:12Z",
    },
    {
      postId: "p3",
      author: { user: "users/2002", displayName: "Sam Staff" },
      commentAction: "RESOLVE",
      createTime: "2026-10-01T10:13:12Z",
      updateTime: "2026-10-01T10:13:12Z",
    },
  ],
};

/** A batchUpdate answer to one insertComment: the new thread, and the comment saved. */
function insertedComment(thread: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    presentationId: "deck1",
    replies: [{ insertComment: { commentThread: { commentId: "c9", anchorId: "a9", status: "OPEN", headPost: slidesPost("p9", "Bigger?"), ...thread } } }],
    writeControl: { requiredRevisionId: "rev-2" },
    commentUpdateState: "ALL_SAVED",
    ...extra,
  };
}

describe("slides() identity and surface (H1, H14)", () => {
  it("requires a purpose and names what it does in title, description, and guide", () => {
    expect(() => connection({ purpose: " " })).toThrow(/purpose/);
    expect(() => connection({ subject: undefined })).toThrow(/subject/);
    const connector = connection({ instructions: "Sermon decks live in the Worship shared drive." });
    expect(connector.title).toBe("Google Slides");
    expect(connector.description).toContain("Sermon slides");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line && !line.startsWith("#"))).toMatch(/signed-in person/);
    expect(content).toContain("Slides cannot list or search decks; that is Google Drive's job.");
    expect(content).toContain("## Connection instructions\n\nSermon decks live in the Worship shared drive.");
    expect(guide(connector).required).toBe(true);
  });

  it("has exactly fifteen tools, and none that shares, moves, or deletes a deck", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "batch_update_presentation",
      "create_comment",
      "create_comment_reply",
      "create_presentation",
      "create_slide",
      "delete_comment",
      "delete_comment_reply",
      "get_page",
      "get_presentation",
      "get_slide_thumbnail",
      "list_comments",
      "list_layouts",
      "replace_all_text",
      "update_comment_post",
      "update_comment_thread",
    ]);
  });

  it("classifies reads as read-only, creates and replies as additive, and what overwrites or deletes as destructive", async () => {
    const connector = connection();
    const byName = Object.fromEntries((await connector.listTools(context())).map((tool) => [tool.name, tool]));
    for (const name of ["get_presentation", "get_page", "list_layouts", "list_comments", "get_slide_thumbnail"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: true });
      expect(isRead(byName[name]!)).toBe(true);
    }
    for (const name of ["create_presentation", "create_slide", "create_comment", "create_comment_reply"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
      expect(isRead(byName[name]!)).toBe(false);
    }
    for (const name of [
      "replace_all_text",
      "update_comment_thread",
      "update_comment_post",
      "delete_comment",
      "delete_comment_reply",
      "batch_update_presentation",
    ]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
      expect(isRead(byName[name]!)).toBe(false);
    }
    // The provider has no slot or OAuth of its own.
    expect(connector).not.toHaveProperty("approval");
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly the presentations scope", () => {
    expect([...SLIDES_SCOPES]).toEqual(["https://www.googleapis.com/auth/presentations"]);
  });

  it("fails closed with a function subject and no caller, before any network call", async () => {
    const mapping = vi.fn(() => "alice@church.example");
    await expect(
      call(connection({ subject: mapping }), "get_presentation", { presentationId: "deck1" }),
    ).rejects.toMatchObject({ code: "auth_required", message: expect.stringContaining("no admitted caller") });
    expect(mapping).not.toHaveBeenCalled();
    expect(tokenCalls).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("reading a deck (H9, H10)", () => {
  it("asks for text only and projects each slide in reading order with notes", async () => {
    route = () => ({ body: PRESENTATION });
    const result = await call(connection(), "get_presentation", { presentationId: "deck1" });

    const request = calls[0]!.url;
    expect(calls[0]!.method).toBe("GET");
    expect(`${request.origin}${request.pathname}`).toBe(`${SLIDES_API_BASE_URL}/presentations/deck1`);
    const fields = request.searchParams.get("fields")!;
    expect(fields).toContain("textRun(content)");
    expect(fields).toContain("notesPage(objectId,notesProperties");
    expect(fields).not.toContain("style");
    // A malformed mask is a 400 for every call; keep it balanced.
    let depth = 0;
    for (const character of fields) {
      depth += character === "(" ? 1 : character === ")" ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);

    expect(result).toEqual({
      presentationId: "deck1",
      title: "Easter Sunday",
      revisionId: "rev-1",
      url: "https://docs.google.com/presentation/d/deck1/edit",
      locale: "en",
      pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
      slideCount: 3,
      layouts: [
        { objectId: "L1", kind: "layout", name: "TITLE", displayName: "Title slide" },
        { objectId: "L2", kind: "layout", name: "TITLE_AND_BODY", displayName: "Title and body" },
      ],
      slides: [
        {
          objectId: "p",
          index: 0,
          layout: "Title slide",
          layoutId: "L1",
          title: "Easter Sunday",
          elements: [
            { objectId: "title", kind: "shape", placeholder: "CENTERED_TITLE", text: "Easter Sunday" },
            { objectId: "body", kind: "shape", placeholder: "SUBTITLE", text: "He is risen\nindeed" },
          ],
          omittedElements: 2,
          notesPageId: "p_notes",
          notes: "Welcome everyone.",
        },
        {
          objectId: "s2",
          index: 1,
          layout: "Title and body",
          layoutId: "L2",
          skipped: true,
          elements: [
            { objectId: "photo", kind: "image", altText: "Empty tomb: Sunrise photo" },
            { objectId: "g-table", kind: "table", text: "Time\tService\n9:00\tSunrise service" },
            { objectId: "chart", kind: "chart", spreadsheetId: "sheet1" },
          ],
        },
        { objectId: "s3", index: 2, layout: "Title and body", layoutId: "L2", elements: [] },
      ],
      page: { hasMore: false, nextCursor: null },
    });
    expect(JSON.stringify(result)).not.toContain("lh3");
  });

  it("pages slides with one opaque cursor and lists layouts on the first page only", async () => {
    route = () => ({ body: PRESENTATION });
    const first = await call(connection(), "get_presentation", { presentationId: "deck1", limit: 2 });
    expect(first.slides.map((slide: any) => slide.objectId)).toEqual(["p", "s2"]);
    expect(first.page).toEqual({ hasMore: true, nextCursor: expect.any(String) });
    expect(first.layouts).toHaveLength(2);

    const second = await call(connection(), "get_presentation", {
      presentationId: "deck1",
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.slides.map((slide: any) => [slide.objectId, slide.index])).toEqual([["s3", 2]]);
    expect(second.page).toEqual({ hasMore: false, nextCursor: null });
    expect(second.layouts).toBeUndefined();
    expect(second.slideCount).toBe(3);
  });

  it("refuses a cursor it did not issue, before any request", async () => {
    await expect(
      call(connection(), "get_presentation", { presentationId: "deck1", cursor: "page-2" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("caps each slide's text with explicit markers", async () => {
    route = () => ({ body: PRESENTATION });
    const result = await call(connection(), "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 10 });
    const [first] = result.slides;
    expect(first.truncated).toBe(true);
    expect(first.elements[0]).toEqual({
      objectId: "title",
      kind: "shape",
      placeholder: "CENTERED_TITLE",
      text: "Easter Sun\n[… 3 more characters truncated; raise maxCharsPerSlide, or continue with get_page from textCursor]",
      truncated: true,
      textCursor: expect.any(String),
    });
    // The budget is spent: the next element says so rather than vanishing.
    expect(first.elements[1].text).toBe(
      "\n[… 18 more characters truncated; raise maxCharsPerSlide, or continue with get_page from textCursor]",
    );
    expect(first.notes).toBe(
      "Welcome ev\n[… 7 more characters truncated; raise maxCharsPerSlide, or continue with get_page from notesCursor]",
    );
    expect(first.notesCursor).toEqual(expect.any(String));
    // The title is bounded by the same cap, and says where the rest is.
    expect(first.title).toBe("Easter Sun\n[… 3 more characters; the title element's text has them]");
  });

  it("never lets a slide title escape the cap, however long", async () => {
    const long = "T".repeat(100_000);
    route = () => ({
      body: {
        presentationId: "deck1",
        slides: [{ objectId: "p", pageElements: [{ objectId: "t", shape: { placeholder: { type: "TITLE" }, text: textContent(long) } }] }],
      },
    });
    const zero = await call(connection(), "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 0 });
    expect(zero.slides[0].title).toBe("\n[… 100000 more characters; the title element's text has them]");
    const most = await call(connection(), "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 50_000 });
    expect(most.slides[0].title).toMatch(/^T{500}\n\[… 99500 more characters; the title/);
  });

  it("keeps empty placeholders, with id and type, so a new slide can be filled", async () => {
    route = () => ({
      body: {
        presentationId: "deck1",
        slides: [
          {
            objectId: "gNew",
            pageElements: [
              { objectId: "gNew_body", transform: at(0, 2000000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" } } },
              { objectId: "gNew_title", transform: at(0, 500000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "TITLE" } } },
              { objectId: "deco", transform: at(0, 0), shape: { shapeType: "RECTANGLE" } },
            ],
          },
        ],
      },
    });
    const result = await call(connection(), "get_presentation", { presentationId: "deck1" });
    expect(result.slides[0]).toEqual({
      objectId: "gNew",
      index: 0,
      elements: [
        { objectId: "gNew_title", kind: "shape", placeholder: "TITLE" },
        { objectId: "gNew_body", kind: "shape", placeholder: "BODY" },
      ],
      omittedElements: 1,
    });
  });

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
              { objectId: "outer", transform: turned, elementGroup: { children: [shape("A", 10, 0), shape("B", 0, 20)] } },
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

  it("returns this page's slides untouched on raw: true, unmasked and without layouts", async () => {
    route = () => ({ body: PRESENTATION });
    const result = await call(connection(), "get_presentation", { presentationId: "deck1", raw: true, limit: 2 });
    expect(calls[0]!.url.search).toBe("");
    expect(result.slides).toEqual(PRESENTATION.slides.slice(0, 2));
    expect(result.layouts).toBeUndefined();
    expect(result).toMatchObject({ presentationId: "deck1", revisionId: "rev-1", slideCount: 3 });
    expect(result.page).toEqual({ hasMore: true, nextCursor: expect.any(String) });
  });

  it("returns a thumbnail's short-lived link and size, never the image", async () => {
    route = () => ({ body: { contentUrl: "https://lh7.googleusercontent.com/thumb", width: 800, height: 450 } });
    const result = await call(connection(), "get_slide_thumbnail", {
      presentationId: "deck1",
      slideObjectId: "g1a2b3c_0:4",
      size: "MEDIUM",
    });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url.pathname).toBe("/v1/presentations/deck1/pages/g1a2b3c_0%3A4/thumbnail");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      "thumbnailProperties.mimeType": "PNG",
      "thumbnailProperties.thumbnailSize": "MEDIUM",
    });
    expect(result).toEqual({ contentUrl: "https://lh7.googleusercontent.com/thumb", width: 800, height: 450 });
  });

  it("validates ids at the schema, before any request", async () => {
    await expect(
      call(connection(), "get_presentation", { presentationId: "../drive/v3/files" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "get_slide_thumbnail", { presentationId: "deck1", slideObjectId: "a/b" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "get_presentation", { presentationId: "deck1", folder: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });
});

describe("errors (H11)", () => {
  it("says a 404 may be absence or a permission gap: a deck is a Drive file", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } } });
    const failure = await call(connection(), "get_presentation", { presentationId: "nope" }).catch((error) => error);
    expect(failure.code).toBe("connector_call_failed");
    expect(failure.message).toContain("not visible to this account");
  });

  it("names the scope when the delegated token lacks it", async () => {
    route = () => ({
      status: 403,
      body: { error: { code: 403, message: "Insufficient scopes.", status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } },
    });
    const failure = await call(connection(), "get_presentation", { presentationId: "deck1" }).catch((error) => error);
    expect(failure.code).toBe("provider_permission_denied");
    expect(failure.message).toContain("https://www.googleapis.com/auth/presentations");
  });

  it.each([
    ["batch_update_presentation", { requests: [{ deleteObject: { objectId: "title" } }] }],
    ["replace_all_text", { replacements: [{ find: "a", replace: "b" }] }],
  ])("maps a stale revision on %s to conflict", async (name, args) => {
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "The required revision does not match.", status: "FAILED_PRECONDITION" } },
    });
    const failure = await call(connection(), name, {
      presentationId: "deck1",
      requiredRevisionId: "rev-old",
      ...args,
    }).catch((error) => error);
    expect(failure.code).toBe("conflict");
    expect(failure.retryable).toBe(false);
    expect(failure.message).toContain("Re-read it for the current revision");
  });

  it("leaves other refusals of a revision-checked write as they are", async () => {
    route = () => ({ status: 400, body: { error: { code: 400, message: "Invalid requests[0].deleteObject.", status: "INVALID_ARGUMENT" } } });
    const failure = await call(connection(), "batch_update_presentation", {
      presentationId: "deck1",
      requiredRevisionId: "rev-1",
      requests: [{ deleteObject: { objectId: "nope" } }],
    }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).toContain("Invalid requests[0].deleteObject.");
  });

  it("never reads a precondition refusal as a conflict when no revision was named", async () => {
    route = () => ({
      status: 400,
      body: { error: { code: 400, message: "Precondition check failed.", status: "FAILED_PRECONDITION" } },
    });
    const failure = await call(connection(), "create_slide", { presentationId: "deck1", layout: "BIG_NUMBER" }).catch(
      (error) => error,
    );
    expect(failure.code).not.toBe("conflict");
    expect(failure.message).toContain("Precondition check failed.");
  });
});

describe("writes whose outcome is unknown", () => {
  /** A 2xx whose body breaks off mid-stream: accepted, answer unreadable. */
  const broken = () => ({
    response: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"presentationId":'));
            controller.error(new TypeError("other side closed"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  });
  /** Sent, and no answer at all. */
  const dropped = () => ({
    response: () => {
      throw new TypeError("fetch failed");
    },
  });

  it.each([
    ["create_presentation", { title: "Easter" }, "Search Drive for a deck with this title"],
    ["create_slide", { presentationId: "deck1" }, "look for the new slide before adding another"],
  ])("%s says the create probably applied, and what to look for, when its 2xx body breaks", async (name, args, advice) => {
    route = broken;
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("the change probably applied");
    expect(failure.message).toContain(advice);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["create_presentation", { title: "Easter" }, "Search Drive for a deck with this title"],
    ["create_slide", { presentationId: "deck1" }, "look for the new slide before adding another"],
  ])("%s says the create may or may not have applied, and what to look for, with no answer", async (name, args, advice) => {
    route = dropped;
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("may or may not have been applied");
    expect(failure.message).toContain(advice);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["replace_all_text", { presentationId: "deck1", replacements: [{ find: "a", replace: "b" }] }],
    ["batch_update_presentation", { presentationId: "deck1", requiredRevisionId: "rev-1", requests: [{ deleteObject: { objectId: "x" } }] }],
  ])("%s keeps the shared verdict, never retryable, never 'nothing was applied'", async (name, args) => {
    for (const [reply, verdict] of [
      [broken, "the change probably applied"],
      [dropped, "may or may not have been applied"],
    ] as const) {
      route = reply;
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain(verdict);
      expect(failure.message).not.toMatch(/nothing was (applied|changed)/i);
    }
  });

  it.each([
    ["create_presentation", { title: "Easter" }, "Search Drive for a deck with this title"],
    ["create_slide", { presentationId: "deck1" }, "look for the new slide before adding another"],
    ["replace_all_text", { presentationId: "deck1", replacements: [{ find: "a", replace: "aa" }] }, undefined],
    ["batch_update_presentation", { presentationId: "deck1", requiredRevisionId: "rev-1", requests: [{ deleteObject: { objectId: "x" } }] }, undefined],
  ])("%s treats a 5xx after sending as an unknown outcome, never retryable", async (name, args, advice) => {
    // No Slides write is safe to send twice — a create makes another, and
    // replacing "a" with "aa" again doubles it — so none is marked idempotent.
    route = () => ({ status: 503, body: { error: { code: 503, message: "Backend Error", status: "UNAVAILABLE" } } });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("its outcome is unknown");
    if (advice) expect(failure.message).toContain(advice);
    else expect(failure.message).not.toMatch(/look for|Search Drive/);
    expect(failure.message).not.toMatch(/nothing (was|is) (applied|changed)/i);
    expect(calls).toHaveLength(1);
  });

  const everyWrite = [
    ["create_presentation", { title: "Easter" }, "Search Drive for a deck with this title"],
    ["create_slide", { presentationId: "deck1" }, "look for the new slide before adding another"],
    ["replace_all_text", { presentationId: "deck1", replacements: [{ find: "a", replace: "aa" }] }, undefined],
    ["batch_update_presentation", { presentationId: "deck1", requiredRevisionId: "rev-1", requests: [{ deleteObject: { objectId: "x" } }] }, undefined],
  ] as const;

  it.each(everyWrite)("%s treats a redirect after sending as uncertain, never as applied", async (name, args, advice) => {
    route = () => ({ response: () => new Response(null, { status: 303, headers: { Location: "https://elsewhere.example/" } }) });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("unknown");
    expect(failure.message).not.toMatch(/probably applied|\bapplied —|nothing (was|is) (applied|changed)/i);
    if (advice) expect(failure.message).toContain(advice);
    // Never followed: the one request is all that left.
    expect(calls).toHaveLength(1);
  });

  it.each(everyWrite)("%s treats a 503 with a rate-limit reason as an unknown outcome, not a rate limit", async (name, args, advice) => {
    route = () => ({
      status: 503,
      body: { error: { code: 503, message: "Quota exceeded.", status: "UNAVAILABLE", details: [{ reason: "RATE_LIMIT_EXCEEDED" }] } },
    });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("its outcome is unknown");
    if (advice) expect(failure.message).toContain(advice);
  });

  it("keeps a 429 on a write a rate limit: Google refused it", async () => {
    route = () => ({ status: 429, body: { error: { code: 429, message: "Slow down.", status: "RESOURCE_EXHAUSTED" } } });
    const failure = await call(connection(), "create_slide", { presentationId: "deck1" }).catch((error) => error);
    expect(failure.code).toBe("rate_limited");
    expect(failure.message).not.toContain("look for the new slide");
  });

  it("keeps a 5xx on a read retryable: reading again is safe", async () => {
    route = () => ({ status: 503, body: { error: { code: 503, message: "Backend Error", status: "UNAVAILABLE" } } });
    for (const [name, args] of [
      ["get_presentation", { presentationId: "deck1" }],
      ["get_page", { presentationId: "deck1", pageObjectId: "p" }],
      ["list_layouts", { presentationId: "deck1" }],
      ["get_slide_thumbnail", { presentationId: "deck1", slideObjectId: "p" }],
    ] as const) {
      await expect(call(connection(), name, args)).rejects.toMatchObject({ code: "unavailable", retryable: true });
    }
  });

  it("leaves a refusal of a create as Google stated it", async () => {
    route = () => ({ status: 400, body: { error: { code: 400, message: "Invalid layout.", status: "INVALID_ARGUMENT" } } });
    const failure = await call(connection(), "create_slide", { presentationId: "deck1", layout: "BIG_NUMBER" }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).not.toContain("look for the new slide");
  });
});

describe("writing", () => {
  it("creates a deck with only a title and returns its id, link, and first slide", async () => {
    route = () => ({ body: { ...PRESENTATION, presentationId: "new1", title: "Staff meeting", slides: [{ objectId: "p" }] } });
    const result = await call(connection(), "create_presentation", { title: "Staff meeting" });
    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe("/presentations");
    expect(calls[0]!.body).toEqual({ title: "Staff meeting" });
    expect(result).toEqual({
      presentationId: "new1",
      revisionId: "rev-1",
      title: "Staff meeting",
      url: "https://docs.google.com/presentation/d/new1/edit",
      slideObjectIds: ["p"],
    });
  });

  it("creates a slide from a predefined layout at an index", async () => {
    route = () => ({
      body: { presentationId: "deck1", replies: [{ createSlide: { objectId: "gNew" } }], writeControl: { requiredRevisionId: "rev-2" } },
    });
    const result = await call(connection(), "create_slide", {
      presentationId: "deck1",
      layout: "TITLE_AND_BODY",
      insertionIndex: 1,
    });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/v1/presentations/deck1:batchUpdate");
    expect(calls[0]!.body).toEqual({
      requests: [{ createSlide: { insertionIndex: 1, slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" } } }],
    });
    expect(result).toEqual({ presentationId: "deck1", revisionId: "rev-2", slideObjectId: "gNew" });
  });

  it("creates a slide from the deck's own layout, or appends a blank one", async () => {
    route = () => ({ body: { presentationId: "deck1", replies: [{ createSlide: { objectId: "gNew" } }] } });
    await call(connection(), "create_slide", { presentationId: "deck1", layoutId: "L2" });
    expect(calls[0]!.body.requests).toEqual([{ createSlide: { slideLayoutReference: { layoutId: "L2" } } }]);
    await call(connection(), "create_slide", { presentationId: "deck1" });
    expect(calls[1]!.body.requests).toEqual([{ createSlide: {} }]);
  });

  it("refuses both layout and layoutId before any request", async () => {
    await expect(
      call(connection(), "create_slide", { presentationId: "deck1", layout: "BLANK", layoutId: "L2" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
  });

  it("replaces text in one atomic batch, case-sensitive by default, and counts every replacement", async () => {
    route = () => ({
      body: {
        presentationId: "deck1",
        // Proto3 omits a zero count.
        replies: [{ replaceAllText: { occurrencesChanged: 3 } }, { replaceAllText: {} }],
        writeControl: { requiredRevisionId: "rev-2" },
      },
    });
    const result = await call(connection(), "replace_all_text", {
      presentationId: "deck1",
      replacements: [
        { find: "{{date}}", replace: "April 20" },
        { find: "easter", replace: "Easter", matchCase: false },
      ],
      slideObjectIds: ["p", "s2"],
      requiredRevisionId: "rev-1",
    });
    expect(calls[0]!.url.pathname).toBe("/v1/presentations/deck1:batchUpdate");
    expect(calls[0]!.body).toEqual({
      requests: [
        { replaceAllText: { containsText: { text: "{{date}}", matchCase: true }, replaceText: "April 20", pageObjectIds: ["p", "s2"] } },
        { replaceAllText: { containsText: { text: "easter", matchCase: false }, replaceText: "Easter", pageObjectIds: ["p", "s2"] } },
      ],
      writeControl: { requiredRevisionId: "rev-1" },
    });
    expect(result).toEqual({
      presentationId: "deck1",
      revisionId: "rev-2",
      occurrencesChanged: 3,
      replacements: [
        { find: "{{date}}", occurrencesChanged: 3 },
        { find: "easter", occurrencesChanged: 0 },
      ],
    });
  });

  it("passes raw requests through at the required revision and returns every reply", async () => {
    route = () => ({
      body: {
        presentationId: "deck1",
        replies: [{}, { createShape: { objectId: "box2" } }],
        writeControl: { requiredRevisionId: "rev-3" },
      },
    });
    const requests = [
      { insertText: { objectId: "title", text: "Hello", insertionIndex: 0 } },
      { createShape: { shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "p" } } },
    ];
    const result = await call(connection(), "batch_update_presentation", {
      presentationId: "deck1",
      requiredRevisionId: "rev-2",
      requests,
    });
    expect(calls[0]!.body).toEqual({ requests, writeControl: { requiredRevisionId: "rev-2" } });
    expect(result).toEqual({
      presentationId: "deck1",
      revisionId: "rev-3",
      replies: [{}, { createShape: { objectId: "box2" } }],
    });
  });

  it("refuses a raw batch with no revision, no requests, or a request with two kinds", async () => {
    for (const args of [
      { presentationId: "deck1", requests: [{ deleteObject: { objectId: "p" } }] },
      { presentationId: "deck1", requiredRevisionId: "rev-1", requests: [] },
      { presentationId: "deck1", requiredRevisionId: "rev-1", requests: [{ deleteObject: {}, insertText: {} }] },
      { presentationId: "deck1", requiredRevisionId: "rev-1", requests: Array.from({ length: 101 }, () => ({ deleteObject: {} })) },
    ]) {
      await expect(call(connection(), "batch_update_presentation", args)).rejects.toMatchObject({
        code: "invalid_args",
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a request kind Slides does not define, naming it, before any request", async () => {
    const failure = await call(connection(), "batch_update_presentation", {
      presentationId: "deck1",
      requiredRevisionId: "rev-1",
      requests: [{ insertText: { objectId: "title", text: "x" } }, { deleteFile: { id: "deck1" } }],
    }).catch((error) => error);
    expect(failure.code).toBe("invalid_args");
    expect(failure.message).toContain('requests[1] "deleteFile"');
    expect(failure.message).toContain("nothing was sent");
    expect(calls).toEqual([]);
    expect(tokenCalls).toBe(0);
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
            detail: { sourceId: `src-${index}`, status: "OK", note: "n".repeat(2_048), parts: [{ partId: `part-${index}-a`, body: "b".repeat(2_048) }] },
          },
        }
      : { createShape: { objectId: `shape-${index}`, blob: "x".repeat(2_048) } },
  );
}

/** Every kind of reply Slides' batchUpdate sends, from Discovery's `Response` schema. */
const RESPONSE_KINDS: ReadonlySet<string> = new Set([
  "addCommentReply",
  "createImage",
  "createLine",
  "createSheetsChart",
  "createShape",
  "createSlide",
  "createTable",
  "createVideo",
  "duplicateObject",
  "groupObjects",
  "insertComment",
  "replaceAllShapesWithImage",
  "replaceAllShapesWithSheetsChart",
  "replaceAllText",
]);

describe("output schemas declare what the tools return (H8)", () => {
  /**
   * Every key a projection emits, walked against the declared schema. An
   * object node with no `properties` is opaque, and an opaque node hides an
   * omission, so each one is reported unless it is listed as a passthrough.
   */
  function undeclared(schema: any, value: unknown, at: string, out: string[]): void {
    if (Array.isArray(value)) {
      for (const item of value) undeclared(schema?.items, item, `${at}[]`, out);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (!schema?.properties) {
      out.push(`${at} (opaque)`);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      // A batch reply is Slides' own Response, one kind per reply, beside
      // the `cut` connecta declares: the kinds are checked against Slides'
      // list rather than declared, and what is inside them is Google's.
      if (at.endsWith("replies[]") && !(key in schema.properties)) {
        if (!RESPONSE_KINDS.has(key)) out.push(`${at}.${key} (not a Slides reply kind)`);
        continue;
      }
      if (!(key in schema.properties)) out.push(`${at}.${key}`);
      else undeclared(schema.properties[key], item, `${at}.${key}`, out);
    }
  }

  function validates(schema: JsonSchema, value: unknown, address: string): string | undefined {
    return validateToolInput(schema, value, { address, logger: silentLogger, failClosed: true })?.message;
  }

  /** A deck as ProtoJSON sends an empty one: no slides, no layouts, no arrays at all. */
  const EMPTY = { presentationId: "empty1", title: "Untitled presentation", revisionId: "rev-0" };

  it("declares every key each projection emits, at every depth", async () => {
    const connector = connection();
    const schemas = Object.fromEntries(
      (await connector.listTools(context())).map((tool) => [tool.name, tool.outputSchema]),
    );
    const outputs: [string, unknown][] = [];
    route = () => ({ body: PRESENTATION });
    outputs.push(["get_presentation", await call(connector, "get_presentation", { presentationId: "deck1" })]);
    outputs.push([
      "get_presentation",
      await call(connector, "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 5, limit: 1 }),
    ]);
    route = () => ({ body: EMPTY });
    outputs.push(["get_presentation", await call(connector, "get_presentation", { presentationId: "empty1" })]);
    route = () => ({ body: LAYOUT_PAGE });
    outputs.push(["get_page", await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "L2" })]);
    route = () => ({ body: { ...SLIDE_PAGE, revisionId: undefined } });
    outputs.push(["get_page", await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "s2" })]);
    route = () => ({ body: PRESENTATION });
    outputs.push(["list_layouts", await call(connector, "list_layouts", { presentationId: "deck1", limit: 1 })]);
    route = () => ({ body: EMPTY });
    outputs.push(["list_layouts", await call(connector, "list_layouts", { presentationId: "empty1" })]);
    route = () => ({ body: { contentUrl: "https://lh7/x", width: 200, height: 113 } });
    outputs.push([
      "get_slide_thumbnail",
      await call(connector, "get_slide_thumbnail", { presentationId: "deck1", slideObjectId: "p" }),
    ]);
    route = () => ({ body: { ...EMPTY, slides: [{ objectId: "p" }] } });
    outputs.push(["create_presentation", await call(connector, "create_presentation", { title: "Untitled" })]);
    route = () => ({
      body: { presentationId: "deck1", replies: [{ createSlide: { objectId: "g1" } }], writeControl: { requiredRevisionId: "r" } },
    });
    outputs.push(["create_slide", await call(connector, "create_slide", { presentationId: "deck1" })]);
    route = () => ({ body: { presentationId: "deck1", replies: [{ replaceAllText: { occurrencesChanged: 1 } }] } });
    outputs.push([
      "replace_all_text",
      await call(connector, "replace_all_text", { presentationId: "deck1", replacements: [{ find: "a", replace: "b" }] }),
    ]);
    route = () => ({
      body: { presentationId: "deck1", replies: [{ createShape: { objectId: "s" } }], writeControl: { requiredRevisionId: "r" } },
    });
    outputs.push([
      "batch_update_presentation",
      await call(connector, "batch_update_presentation", {
        presentationId: "deck1",
        requiredRevisionId: "rev-1",
        requests: [{ createShape: { shapeType: "TEXT_BOX" } }],
      }),
    ]);
    // Summarized replies too, whose `cut` the walk must find declared.
    route = () => ({ body: { presentationId: "deck1", replies: bulkyReplies(4) } });
    outputs.push([
      "batch_update_presentation",
      await call(connector, "batch_update_presentation", {
        presentationId: "deck1",
        requiredRevisionId: "rev-1",
        requests: Array.from({ length: 4 }, () => ({ createShape: {} })),
      }),
    ]);
    expect((outputs[outputs.length - 1]![1] as any).replies[0].cut.length).toBeGreaterThan(0);
    route = () => ({ body: COMMENT_DECK });
    outputs.push(["list_comments", await call(connector, "list_comments", { presentationId: "deck1" })]);
    // A continued row, and a page's threads.
    route = () => ({ body: { ...COMMENT_DECK, comments: [{ ...THREADS[0], plainTextQuote: "q".repeat(300_000) }] } });
    const cut = await call(connector, "list_comments", { presentationId: "deck1" });
    outputs.push(["list_comments", cut]);
    outputs.push(["list_comments", await call(connector, "list_comments", { presentationId: "deck1", cursor: cut.page.nextCursor })]);
    route = () => ({ body: { objectId: "p", commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED", comments: THREADS.slice(0, 1) } });
    outputs.push(["list_comments", await call(connector, "list_comments", { presentationId: "deck1", pageObjectId: "p" })]);
    route = () => ({ body: insertedComment({ replies: [slidesPost("p10", "Yes", SAM)] }) });
    outputs.push(["create_comment", await call(connector, "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" })]);
    route = () => ({ body: { presentationId: "deck1", replies: [{}], commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" } });
    outputs.push(["create_comment", await call(connector, "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" })]);
    route = () => ({ body: { presentationId: "deck1", replies: [{ addCommentReply: { post: slidesPost("p11", "Done", SAM) } }], commentUpdateState: "ALL_SAVED" } });
    outputs.push(["create_comment_reply", await call(connector, "create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done" })]);
    outputs.push(["update_comment_thread", await call(connector, "update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "RESOLVED" })]);
    route = () => ({ body: { presentationId: "deck1", replies: [{}], commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" } });
    for (const [name, args] of [
      ["update_comment_post", { presentationId: "deck1", commentId: "c1", postId: "p1", content: "Smaller?" }],
      ["delete_comment", { presentationId: "deck1", commentId: "c1" }],
      ["delete_comment_reply", { presentationId: "deck1", commentId: "c1", postId: "p2" }],
    ] as const) {
      outputs.push([name, await call(connector, name, args)]);
    }

    // The validator bites: a wrong type is caught, so a pass below means something.
    expect(validates(schemas["get_presentation"]!, { presentationId: 7 }, "decks.get_presentation")).toBeDefined();
    const gaps: string[] = [];
    for (const [name, output] of outputs) {
      undeclared(schemas[name], output, name, gaps);
      expect(validates(schemas[name]!, output, `decks.${name}`), name).toBeUndefined();
    }
    expect([...new Set(gaps)]).toEqual([]);
    expect(new Set(outputs.map(([name]) => name))).toEqual(new Set(Object.keys(schemas)));
  });

  it("projects an empty deck, which Slides sends with no slides array at all", async () => {
    route = () => ({ body: EMPTY });
    const result = await call(connection(), "get_presentation", { presentationId: "empty1" });
    expect(result).toEqual({
      presentationId: "empty1",
      title: "Untitled presentation",
      revisionId: "rev-0",
      url: "https://docs.google.com/presentation/d/empty1/edit",
      slideCount: 0,
      layouts: [],
      slides: [],
      page: { hasMore: false, nextCursor: null },
    });
  });

  it("lets raw: true's untouched slides validate, full or empty", async () => {
    const tool = (await connection().listTools(context())).find((entry) => entry.name === "get_presentation")!;
    for (const body of [PRESENTATION, EMPTY]) {
      route = () => ({ body });
      const result = await call(connection(), "get_presentation", { presentationId: body.presentationId, raw: true });
      expect(result.slides).toEqual("slides" in body ? body.slides : []);
      expect(validates(tool.outputSchema!, result, "decks.get_presentation")).toBeUndefined();
    }
  });
});

// The suites below walk megabytes of worst-case text to the end, so they
// get room past the default timeout on a loaded runner.
describe("every result is deliverable, in a program and directly", { timeout: 60_000 }, () => {
  /**
   * A program's host call carries at most 256 KiB of serialized JSON
   * (`MAX_HOST_RESULT_BYTES`); a direct call stashes more for get_result, up
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
          shape: { shapeType: "TEXT_BOX", placeholder: { type: element === 0 ? "TITLE" : "BODY" }, text: textContent(heavy(chars)) },
        })),
      })),
    };
  }

  /** Every page from the first cursor to the last, each measured. */
  async function walk(connector: Connector, args: Record<string, unknown>) {
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "get_presentation", { presentationId: "big1", ...args, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && pages.length < 1_000);
    return pages;
  }

  it.each([
    ["defaults", {}],
    ["the explicit maxima", { limit: 100, maxCharsPerSlide: 50_000 }],
    ["raw: true", { raw: true }],
  ])("keeps every page of a worst-case deck under the bridge cap at %s, and reaches every slide", async (_label, args) => {
    const deck = worstDeck(30, 4, 8_000);
    route = () => ({ body: deck });
    const connector = connection();
    const pages = await walk(connector, args);
    for (const page of pages) expect(bytes(page)).toBeLessThan(BRIDGE_BYTES);
    // The byte budget, not the slide limit, is what ended these pages: 30
    // slides fit two default pages, or one at limit 100.
    expect(pages.length).toBeGreaterThan(2);
    // Paging always moves forward: each slide appears once, in order.
    expect(pages.flatMap((page) => page.slides.map((slide: any) => slide.objectId))).toEqual(
      deck.slides.map((slide) => slide.objectId),
    );
  });

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

  it("leaves out and counts the last elements of a slide too crowded to fit even without text", async () => {
    route = () => ({ body: worstDeck(1, 6_000, 10, 0) });
    const result = await call(connection(), "get_presentation", { presentationId: "big1" });
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    const [slide] = result.slides;
    expect(slide.elementsNotShown).toBeGreaterThan(0);
    expect(slide.elements.length + slide.elementsNotShown).toBe(6_000);
    expect(slide.elements[0].objectId).toBe("s0_e0");
  });

  it("names a raw slide no result can carry instead of returning it", async () => {
    route = () => ({ body: worstDeck(2, 4, 60_000) });
    const result = await call(connection(), "get_presentation", { presentationId: "big1", raw: true });
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    expect(result.slides).toEqual([
      { objectId: "s0", rawNotShown: expect.stringMatching(/^This slide's raw JSON is \d+ bytes, more than one result can carry/) },
    ]);
    expect(result.page.nextCursor).toBeTruthy();
  });

  it("bounds every write result: replace_all_text echoes finds, not their full text", async () => {
    const replacements = Array.from({ length: 50 }, (_, index) => ({ find: `${index}x${heavy(998)}`, replace: "" }));
    route = () => ({ body: { presentationId: "deck1", replies: replacements.map(() => ({ replaceAllText: { occurrencesChanged: 1 } })) } });
    const result = await call(connection(), "replace_all_text", { presentationId: "deck1", replacements });
    expect(bytes(result)).toBeLessThan(32 * 1024);
    const echoed: string = result.replacements[0].find;
    expect(echoed.startsWith("0x\u0001😀")).toBe(true);
    expect(echoed.endsWith("…")).toBe(true);
    expect(echoed.length).toBeLessThanOrEqual(101);
    // Never half an emoji: the cut falls between code points.
    expect(echoed).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(result.occurrencesChanged).toBe(50);
  });
});

describe("get_page and list_layouts: every page, element, and layout is reachable", { timeout: 60_000 }, () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  /** Long text whose every position is distinct, with emoji to test surrogate-safe cuts. */
  const long = (length: number) =>
    Array.from({ length }, (_, index) => (index % 997 === 0 ? "😀" : String.fromCharCode(97 + (index % 26)))).join("").slice(0, length);
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
      const page = await call(connector, "get_page", { presentationId: "deck1", ...args, ...(cursor ? { cursor } : {}) });
      expect(bytes(page)).toBeLessThan(BRIDGE_BYTES);
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && pages.length < 200);
    return pages;
  }

  it("reads a layout's placeholders, with the types, indexes, and parents placeholderIdMappings needs", async () => {
    route = () => ({ body: LAYOUT_PAGE });
    const result = await call(connection(), "get_page", { presentationId: "deck1", pageObjectId: "L2" });
    expect(calls[0]!.url.pathname).toBe("/v1/presentations/deck1/pages/L2");
    const fields = calls[0]!.url.searchParams.get("fields")!;
    expect(fields).toContain("placeholder(type,index,parentObjectId)");
    expect(fields).toContain("layoutProperties(name,displayName,masterObjectId)");
    expect(result).toEqual({
      presentationId: "deck1",
      pageObjectId: "L2",
      revisionId: "rev-1",
      pageType: "LAYOUT",
      masterId: "M1",
      name: "TITLE_AND_BODY",
      displayName: "Title and body",
      elementCount: 2,
      elements: [
        { objectId: "L2_title", kind: "shape", placeholder: "TITLE", placeholderParentId: "M1_title" },
        { objectId: "L2_body", kind: "shape", placeholder: "BODY", placeholderIndex: 0, placeholderParentId: "M1_body" },
      ],
      page: { hasMore: false, nextCursor: null },
    });
  });

  it("reads a slide's every element in reading order, groups named, notes page linked", async () => {
    route = () => ({ body: SLIDE_PAGE });
    const result = await call(connection(), "get_page", { presentationId: "deck1", pageObjectId: "s2" });
    expect(result).toMatchObject({ pageType: "SLIDE", layoutId: "L2", masterId: "M1", notesPageId: "s2_notes", skipped: true, elementCount: 3 });
    expect(result.elements).toEqual([
      { objectId: "photo", kind: "image", altText: "Empty tomb: Sunrise photo" },
      { objectId: "g-table", kind: "table", groupId: "group", text: "Time\tService\n9:00\tSunrise service" },
      { objectId: "chart", kind: "chart", spreadsheetId: "sheet1" },
    ]);
  });

  it("pages elements by limit, with the same reading order", async () => {
    route = () => ({ body: SLIDE_PAGE });
    const pages = await follow(connection(), { pageObjectId: "s2", limit: 1 });
    expect(pages.map((page) => page.elements.map((element: any) => element.objectId))).toEqual([["photo"], ["g-table"], ["chart"]]);
  });

  it("continues text cut on a slide from its textCursor until the last character", async () => {
    const full = long(300_000);
    const deck = {
      presentationId: "deck1",
      revisionId: "rev-1",
      slides: [{ objectId: "p", pageElements: [{ objectId: "essay", shape: { shapeType: "TEXT_BOX", text: textContent(full) } }] }],
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

  it("continues cut speaker notes from notesCursor on the notes page", async () => {
    const notes = long(9_000);
    const notesPage = {
      objectId: "p_notes",
      pageType: "NOTES",
      notesProperties: { speakerNotesObjectId: "n1" },
      pageElements: [
        { objectId: "img", transform: at(0, 0), image: { contentUrl: "x" } },
        { objectId: "n1", transform: at(0, 5000000), shape: { shapeType: "TEXT_BOX", text: textContent(notes) } },
      ],
    };
    const deck = { presentationId: "deck1", revisionId: "rev-1", slides: [{ objectId: "p", slideProperties: { notesPage: notesPage } }] };
    serve(deck, { p_notes: notesPage });
    const connector = connection();
    const read = await call(connector, "get_presentation", { presentationId: "deck1" });
    const slide = read.slides[0];
    const [rest] = (await follow(connector, { pageObjectId: "p_notes" }, slide.notesCursor)).flatMap((page) => page.elements);
    expect(rest.objectId).toBe("n1");
    expect(slide.notes.replace(/\n\[… [^\]]*\]$/, "") + rest.text).toBe(notes);
  });

  it("lists the elements a crowded slide could not, from elementsCursor", async () => {
    const elements = Array.from({ length: 6_000 }, (_, index) => ({
      objectId: `e${index}`,
      transform: at(index, index),
      shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY" }, text: textContent(`${index}`) },
    }));
    const deck = { presentationId: "deck1", revisionId: "rev-1", slides: [{ objectId: "p", pageElements: elements }] };
    serve(deck);
    const connector = connection();
    const read = await call(connector, "get_presentation", { presentationId: "deck1" });
    const slide = read.slides[0];
    expect(slide.elementsNotShown).toBeGreaterThan(0);
    const shown = slide.elements.map((element: any) => element.objectId);
    const rest = (await follow(connector, { pageObjectId: "p", limit: 500 }, slide.elementsCursor)).flatMap((page) =>
      page.elements.map((element: any) => element.objectId),
    );
    expect([...shown, ...rest]).toEqual(elements.map((element) => element.objectId));
  });

  it("sends a raw element too large for one result in JSON chunks that parse back to it", async () => {
    const huge = {
      objectId: "essay",
      transform: at(0, 0),
      shape: { shapeType: "TEXT_BOX", text: { textElements: [{ textRun: { content: long(400_000), style: { bold: true } } }] } },
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

  it("bounds a 300,000-character layout name everywhere, and raw get_page still has all of it", async () => {
    const name = long(300_000);
    const deck = {
      ...PRESENTATION,
      masters: [{ objectId: "M1", masterProperties: { displayName: "Theme" } }],
      layouts: [{ objectId: "L1", layoutProperties: { name: "CUSTOM", displayName: name, masterObjectId: "M1" } }],
      slides: [{ objectId: "p", slideProperties: { layoutObjectId: "L1" }, pageElements: [] }],
    };
    const layoutPage = { objectId: "L1", pageType: "LAYOUT", revisionId: "rev-1", layoutProperties: deck.layouts[0]!.layoutProperties, pageElements: [] };
    serve(deck, { L1: layoutPage });
    const connector = connection();
    const results = [
      await call(connector, "get_presentation", { presentationId: "deck1" }),
      await call(connector, "list_layouts", { presentationId: "deck1" }),
      await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "L1" }),
    ];
    for (const result of results) expect(bytes(result)).toBeLessThan(32 * 1024);
    expect(results[0].slides[0].layout).toMatch(/\[… \d+ more characters; get_page on layoutId with raw: true has the whole name\]$/);
    expect(results[1].layouts[1].displayName).toMatch(/has the whole name\]$/);
    // The raw page carries the whole name, in chunks if it must.
    const pages = await follow(connector, { pageObjectId: "L1", raw: true });
    let json = "";
    for (const page of pages) json += page.propertiesJson?.json ?? "";
    const properties = json ? JSON.parse(json) : pages[0].properties;
    expect(properties.layoutProperties.displayName).toBe(name);
  });

  it("continues the layout preview in list_layouts from layoutsCursor, masters first", async () => {
    const masters = [{ objectId: "M1", masterProperties: { displayName: "Light" } }, { objectId: "M2", masterProperties: { displayName: "Dark" } }];
    const layouts = Array.from({ length: 1_200 }, (_, index) => ({
      objectId: `L${index}`,
      layoutProperties: { name: "CUSTOM", displayName: `Layout ${index} ${"x".repeat(60)}`, masterObjectId: index % 2 ? "M2" : "M1" },
    }));
    serve({ ...PRESENTATION, masters, layouts });
    const connector = connection();
    const read = await call(connector, "get_presentation", { presentationId: "deck1" });
    expect(read.layoutsNotShown).toBeGreaterThan(0);
    const rows = [...read.layouts];
    let cursor: string | undefined = read.layoutsCursor;
    while (cursor) {
      const page = await call(connector, "list_layouts", { presentationId: "deck1", cursor, limit: 500 });
      expect(bytes(page)).toBeLessThan(BRIDGE_BYTES);
      rows.push(...page.layouts);
      cursor = page.page.nextCursor ?? undefined;
    }
    const expected = [
      "M1",
      ...layouts.filter((_, index) => index % 2 === 0).map((layout) => layout.objectId),
      "M2",
      ...layouts.filter((_, index) => index % 2 === 1).map((layout) => layout.objectId),
    ];
    expect(rows.map((row) => row.objectId)).toEqual(expected);
    expect(rows[0]).toEqual({ objectId: "M1", kind: "master", displayName: "Light" });
    expect(rows[1]).toMatchObject({ objectId: "L0", kind: "layout", masterId: "M1" });
  });

  describe("cursors are bound to the deck, the page, the mode, and the revision", () => {
    const three = (revisionId?: string, ids = ["A", "B", "C"]) => ({
      presentationId: "deck1",
      ...(revisionId ? { revisionId } : {}),
      slides: ids.map((objectId) => ({ objectId, pageElements: [] })),
    });

    async function firstPage(connector: Connector, deck: any) {
      route = () => ({ body: deck });
      const page = await call(connector, "get_presentation", { presentationId: "deck1", limit: 1 });
      expect(page.slides.map((slide: any) => slide.objectId)).toEqual(["A"]);
      return page.page.nextCursor as string;
    }

    it.each([
      ["a revision", "rev-1", "rev-2"],
      ["no revision (a viewer)", undefined, undefined],
    ])("with %s, a deleted slide is a conflict rather than a skipped one", async (_label, before, after) => {
      const connector = connection();
      const cursor = await firstPage(connector, three(before));
      route = () => ({ body: three(after, ["B", "C"]) });
      await expect(call(connector, "get_presentation", { presentationId: "deck1", limit: 1, cursor })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("Start again without a cursor"),
      });
    });

    it.each([
      ["a revision", "rev-1", "rev-2"],
      ["no revision (a viewer)", undefined, undefined],
    ])("with %s, an inserted slide is a conflict rather than a repeated one", async (_label, before, after) => {
      const connector = connection();
      const cursor = await firstPage(connector, three(before));
      route = () => ({ body: three(after, ["Z", "A", "B", "C"]) });
      await expect(call(connector, "get_presentation", { presentationId: "deck1", limit: 1, cursor })).rejects.toMatchObject({
        code: "conflict",
      });
    });

    it("continues an unchanged deck, revision or not", async () => {
      for (const revision of ["rev-1", undefined]) {
        const connector = connection();
        const cursor = await firstPage(connector, three(revision));
        const next = await call(connector, "get_presentation", { presentationId: "deck1", limit: 1, cursor });
        expect(next.slides.map((slide: any) => slide.objectId)).toEqual(["B"]);
      }
    });

    it("refuses a cursor from another deck, page, tool, or mode before any request", async () => {
      const connector = connection();
      const deckCursor = await firstPage(connector, three("rev-1"));
      route = () => ({ body: SLIDE_PAGE });
      const pageCursor = (await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "s2", limit: 1 })).page.nextCursor;
      calls.length = 0;
      const refusals = [
        ["get_presentation", { presentationId: "deck2", cursor: deckCursor }, "different presentation"],
        ["get_presentation", { presentationId: "deck1", cursor: deckCursor, raw: true }, "raw: false"],
        ["get_page", { presentationId: "deck1", pageObjectId: "s2", cursor: deckCursor }, "another tool"],
        ["get_page", { presentationId: "deck1", pageObjectId: "s3", cursor: pageCursor }, "different page"],
        ["list_layouts", { presentationId: "deck1", cursor: pageCursor }, "another tool"],
      ] as const;
      for (const [name, args, why] of refusals) {
        await expect(call(connector, name, args)).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining(why) });
      }
      expect(calls).toEqual([]);
    });

    it("binds a viewer's get_page cursor to the page's text, so an edit is a conflict", async () => {
      const page = (content: string) => ({
        objectId: "p",
        pageElements: [{ objectId: "essay", shape: { shapeType: "TEXT_BOX", text: textContent(content) } }],
      });
      const connector = connection();
      route = () => ({ body: page(long(300_000)) });
      const first = await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p" });
      expect(first.page.hasMore).toBe(true);
      route = () => ({ body: page(`inserted ${long(300_000)}`) });
      await expect(
        call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p", cursor: first.page.nextCursor }),
      ).rejects.toMatchObject({ code: "conflict" });
    });
  });

  it("refuses, explicitly, a result it cannot fit rather than returning it", async () => {
    route = () => ({ body: { ...PRESENTATION, locale: "x".repeat(300_000) } });
    await expect(call(connection(), "get_presentation", { presentationId: "deck1" })).rejects.toMatchObject({
      code: "connector_call_failed",
      message: expect.stringContaining("more than one result can carry"),
    });
  });
});

describe("round three: content-bound cursors, the notes master, bounded replies and links", { timeout: 60_000 }, () => {
  const BRIDGE_BYTES = 256 * 1024;
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
      pageElements: [{ objectId: "essay", shape: { text: { textElements: [{ textRun: { content: content(swap) } }] } } }],
    });
    expect(bytes(page("😀"))).toBe(bytes(page("abcd")));
    const connector = connection();
    route = () => ({ body: page("😀") });
    const first = await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p", raw: true });
    expect(first.page.hasMore).toBe(true);
    route = () => ({ body: page("abcd") });
    await expect(
      call(connector, "get_page", { presentationId: "deck1", pageObjectId: "p", raw: true, cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("names the notes master, in projected and raw reads alike, and get_page reads it", async () => {
    const deck = { ...PRESENTATION, notesMaster: { objectId: "NM", pageType: "NOTES_MASTER", pageElements: [] } };
    const notesMaster = {
      objectId: "NM",
      pageType: "NOTES_MASTER",
      revisionId: "rev-1",
      pageElements: [
        { objectId: "NM_body", transform: at(0, 5000000), shape: { shapeType: "TEXT_BOX", placeholder: { type: "BODY", index: 1 } } },
        { objectId: "NM_slide", transform: at(0, 0), image: { contentUrl: "x" } },
      ],
    };
    route = (request) => ({ body: request.url.pathname.endsWith("/pages/NM") ? notesMaster : deck });
    const connector = connection();
    const projected = await call(connector, "get_presentation", { presentationId: "deck1" });
    expect(calls[0]!.url.searchParams.get("fields")).toContain("notesMaster(objectId)");
    expect(projected.notesMasterId).toBe("NM");
    expect((await call(connector, "get_presentation", { presentationId: "deck1", raw: true })).notesMasterId).toBe("NM");
    const listed = await call(connector, "list_layouts", { presentationId: "deck1" });
    expect(listed.notesMasterId).toBe("NM");
    const page = await call(connector, "get_page", { presentationId: "deck1", pageObjectId: projected.notesMasterId });
    expect(page).toMatchObject({ pageObjectId: "NM", pageType: "NOTES_MASTER", elementCount: 2 });
    expect(page.elements).toEqual([
      { objectId: "NM_slide", kind: "image" },
      { objectId: "NM_body", kind: "shape", placeholder: "BODY", placeholderIndex: 1 },
    ]);
  });

  it("bounds a raw batch's replies, keeping every new id and naming what it cut, and never says nothing changed", async () => {
    const replies = Array.from({ length: 100 }, (_, index) => ({
      createShape: { objectId: `c${index}`, content: "x".repeat(2_048), html: `<p>${"y".repeat(2_048)}</p>` },
    }));
    route = () => ({ body: { presentationId: "deck1", replies, writeControl: { requiredRevisionId: "rev-2" } } });
    const result = await call(connection(), "batch_update_presentation", {
      presentationId: "deck1",
      requiredRevisionId: "rev-1",
      requests: Array.from({ length: 100 }, () => ({ createShape: {} })),
    });
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    expect(result.revisionId).toBe("rev-2");
    expect(result.replies).toHaveLength(100);
    expect(result.replies[7]).toEqual({ createShape: { objectId: "c7" }, cut: ["createShape.content", "createShape.html"] });
    expect(result.note).toMatch(/^Large reply fields are named in cut; every id is kept\./);
    expect(result.note).toContain("re-read with get_presentation or get_page");
    expect(JSON.stringify(result)).not.toMatch(/nothing (was|is) changed/i);
  });

  it("returns every reply's ids even when they outgrow one result, for get_result to page", async () => {
    const replies = Array.from({ length: 400 }, (_, index) => ({
      // Each one small enough to pass whole, but 400 of them are not.
      createShape: { objectId: `s${index}_${"z".repeat(900)}` },
    }));
    route = () => ({ body: { presentationId: "deck1", replies } });
    const result = await call(connection(), "batch_update_presentation", {
      presentationId: "deck1",
      requiredRevisionId: "rev-1",
      requests: [{ createShape: {} }],
    });
    expect(bytes(result)).toBeGreaterThan(BRIDGE_BYTES);
    expect(result.replies.map((reply: any) => reply.createShape.objectId)).toEqual(replies.map((reply) => reply.createShape.objectId));
    expect(result.repliesNotShown).toBeUndefined();
    expect(result.note).toContain("more than execute_code can carry (262144)");
    expect(result.note).toContain("page it with get_result");
    expect(result.note).not.toMatch(/applied/);
  });

  it("refuses a thumbnail link too long to pass on, rather than returning or cutting it", async () => {
    route = () => ({ body: { contentUrl: `https://lh7.googleusercontent.com/${"a".repeat(300_000)}`, width: 800, height: 450 } });
    const failure = await call(connection(), "get_slide_thumbnail", { presentationId: "deck1", slideObjectId: "p" }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("open the slide in Slides instead");
  });
});

describe("round four: nested reply ids, and every write result bounded", () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const batch = (count: number) => ({
    presentationId: "deck1",
    requiredRevisionId: "rev-1",
    requests: Array.from({ length: count }, () => ({ createShape: {} })),
  });

  it("keeps every nested id while cutting long fields, and names what it cut", async () => {
    route = () => ({ body: { presentationId: "deck1", replies: bulkyReplies(100), writeControl: { requiredRevisionId: "rev-2" } } });
    const result = await call(connection(), "batch_update_presentation", batch(100));
    expect(bytes(result)).toBeLessThan(BRIDGE_BYTES);
    expect(result.replies).toHaveLength(100);
    expect(result.repliesNotShown).toBeUndefined();
    expect(result.replies[0]).toEqual({
      duplicateObject: { objectId: "dup-0", detail: { sourceId: "src-0", status: "OK", parts: [{ partId: "part-0-a" }] } },
      cut: ["duplicateObject.detail.note", "duplicateObject.detail.parts[0].body"],
    });
    expect(result.replies[1]).toEqual({ createShape: { objectId: "shape-1" }, cut: ["createShape.blob"] });
    expect(result.note).toMatch(/^Large reply fields are named in cut; every id is kept\./);
  });

  it("keeps ids whole even when only ids fit, and never cuts one", async () => {
    const longId = `id-${"x".repeat(900)}`;
    const reply = { duplicateObject: { objectId: longId, detail: { sourceId: longId, label: "d".repeat(250) } } };
    route = () => ({ body: { presentationId: "deck1", replies: [reply] } });
    const result = await call(connection(), "batch_update_presentation", batch(1));
    expect(result.replies[0].duplicateObject.objectId).toBe(longId);
    expect(result.replies[0].duplicateObject.detail.sourceId).toBe(longId);
  });

  it("keeps every id in an array longer than the short-field limit", async () => {
    // Fifty nested ids beside long text: the short pass keeps twenty items,
    // so only the ids pass fits, and it walks every item.
    const parts = Array.from({ length: 50 }, (_, index) => ({ partId: `part-${index}`, body: "b".repeat(400) }));
    route = () => ({ body: { presentationId: "deck1", replies: [{ groupObjects: { objectId: "g1", parts } }] } });
    const result = await call(connection(), "batch_update_presentation", batch(1));
    expect(result.replies[0].groupObjects.parts.map((part: any) => part.partId)).toEqual(parts.map((part) => part.partId));
    expect(result.replies[0].groupObjects.objectId).toBe("g1");
  });

  it("drops, flags, and never cuts a revision too long to copy, on every write", async () => {
    const huge = "r".repeat(300_000);
    const cases = [
      ["create_presentation", { title: "Easter" }, { presentationId: "new1", revisionId: huge, slides: [{ objectId: "p" }] }],
      ["create_slide", { presentationId: "deck1" }, { replies: [{ createSlide: { objectId: "g1" } }], writeControl: { requiredRevisionId: huge } }],
      ["replace_all_text", { presentationId: "deck1", replacements: [{ find: "a", replace: "b" }] }, { writeControl: { requiredRevisionId: huge } }],
      ["batch_update_presentation", batch(1), { presentationId: `deck-${huge}`, replies: [{}], writeControl: { requiredRevisionId: huge } }],
    ] as const;
    for (const [name, args, body] of cases) {
      route = () => ({ body });
      const result = await call(connection(), name, args);
      expect(bytes(result), name).toBeLessThan(4 * 1024);
      expect(result.revisionId, name).toBeUndefined();
      expect(result.revisionIdNotShown, name).toBe(true);
      expect(JSON.stringify(result)).not.toContain("rrrrrrrrrr");
    }
    // The presentation id is the caller's own, never Google's echo of it.
    route = () => ({ body: { presentationId: `deck-${huge}`, replies: [{}] } });
    expect((await call(connection(), "batch_update_presentation", batch(1))).presentationId).toBe("deck1");
  });

  it.each([
    ["create_presentation", { title: "Easter" }, { presentationId: "p".repeat(300_000) }, "search Drive for the deck by its title"],
    ["create_slide", { presentationId: "deck1" }, { replies: [{ createSlide: { objectId: "g".repeat(300_000) } }] }, "find the new slide"],
  ])("%s refuses an unusable new id after a 2xx by saying the write applied", async (name, args, body, reread) => {
    route = () => ({ body });
    const failure = await call(connection(), name, args).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("applied — Google answered 2xx");
    expect(failure.message).toContain("Do not repeat it");
    expect(failure.message).toContain(reread);
    expect(failure.message).not.toMatch(/nothing (was|is) (applied|changed)/i);
    expect(bytes(failure.message)).toBeLessThan(1024);
  });

  it("bounds a copied title and a copied slide id list", async () => {
    route = () => ({
      body: {
        presentationId: "new1",
        title: "t".repeat(300_000),
        slides: [{ objectId: "p" }, { objectId: "q".repeat(5_000) }],
      },
    });
    const result = await call(connection(), "create_presentation", { title: "Easter" });
    expect(bytes(result)).toBeLessThan(8 * 1024);
    expect(result.title).toMatch(/Drive shows the whole title\]$/);
    expect(result.slideObjectIds).toEqual(["p"]);
    expect(result.slideObjectIdsNotShown).toBe(1);
  });

  it("refuses a write result too large to deliver by saying the write applied, never that nothing changed", async () => {
    // Many whole ids, each within bounds, whose sum is not.
    route = () => ({
      body: {
        presentationId: "new1",
        slides: Array.from({ length: 400 }, (_, index) => ({ objectId: `s${index}_${"x".repeat(900)}` })),
      },
    });
    const failure = await call(connection(), "create_presentation", { title: "Easter" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("create_presentation applied — Google answered 2xx — but its result is");
    expect(failure.message).toContain("search Drive for the deck by its title");
    expect(failure.message).not.toMatch(/nothing (was|is) (applied|changed)/i);
  });
});

describe("comments: the read path (#696)", { timeout: 60_000 }, () => {
  const BRIDGE_BYTES = 256 * 1024;
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  it("reads a deck's threads with comments included, each anchored, quoted, and authored by user id", async () => {
    route = () => ({ body: COMMENT_DECK });
    const result = await call(connection(), "list_comments", { presentationId: "deck1" });
    expect(path(0)).toBe("/presentations/deck1");
    // INCLUDED, never the default (omitted) or DEFAULT_FOR_CURRENT_ACCESS,
    // which would hand a view-only account an empty list.
    expect(calls[0]!.url.searchParams.get("commentsViewMode")).toBe("COMMENTS_VIEW_MODE_INCLUDED");
    const fields = calls[0]!.url.searchParams.get("fields")!;
    for (const field of ["comments", "revisionId", "commentsViewMode", "slides(objectId,commentAnchors", "notesPage(objectId,commentAnchors)"]) {
      expect(fields).toContain(field);
    }
    expect(result.presentationId).toBe("deck1");
    expect(result.revisionId).toBe("rev-1");
    expect(result.total).toBe(3);
    expect(result.page).toEqual({ hasMore: false, nextCursor: null });
    expect(result.threads[0]).toEqual(C1);
    // A speaker-notes comment sits on the notes page; an anonymous author has no id.
    expect(result.threads[1]).toEqual({
      commentId: "c2",
      anchorId: "a2",
      status: "RESOLVED",
      pageObjectIds: ["p_notes"],
      objectIds: ["n1"],
      replyCount: 0,
      headPost: {
        postId: "p4",
        author: { anonymous: true },
        content: "Typo in the notes",
        createTime: "2026-10-01T10:13:12Z",
        updateTime: "2026-10-01T10:13:12Z",
      },
    });
    // Anchored to the slide itself; an imported post says why it has no
    // user; a deleted reply keeps its id.
    expect(result.threads[2]).toMatchObject({
      commentId: "c3",
      pageObjectIds: ["s2"],
      headPost: { postId: "p5", author: { displayName: "Old Author" }, imported: true },
      replies: [{ postId: "p6", deleted: true }],
    });
    expect(result.threads[2].objectIds).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("contentHtml");
  });

  it("reads one page's threads from pages.get, with comments included", async () => {
    route = () => ({
      body: {
        objectId: "p",
        revisionId: "rev-1",
        commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
        comments: THREADS.slice(0, 1),
        commentAnchors: COMMENT_DECK.slides[0]!.commentAnchors,
      },
    });
    const result = await call(connection(), "list_comments", { presentationId: "deck1", pageObjectId: "p" });
    expect(path(0)).toBe("/presentations/deck1/pages/p");
    expect(calls[0]!.url.searchParams.get("commentsViewMode")).toBe("COMMENTS_VIEW_MODE_INCLUDED");
    expect(calls[0]!.url.searchParams.get("fields")).toBe("objectId,revisionId,commentsViewMode,comments,commentAnchors");
    expect(result).toMatchObject({ presentationId: "deck1", pageObjectId: "p", total: 1 });
    expect(result.threads).toEqual([C1]);
  });

  it("reads a deck with no comments, which ProtoJSON sends with no comments array", async () => {
    route = () => ({ body: { presentationId: "deck1", revisionId: "rev-1", commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED" } });
    const result = await call(connection(), "list_comments", { presentationId: "deck1" });
    expect(result).toEqual({ presentationId: "deck1", revisionId: "rev-1", total: 0, threads: [], page: { hasMore: false, nextCursor: null } });
  });

  it("refuses a reply in any other view mode rather than pass off a list that may be missing threads", async () => {
    route = () => ({ body: { ...COMMENT_DECK, commentsViewMode: "COMMENTS_VIEW_MODE_OMITTED", comments: [] } });
    const failure = await call(connection(), "list_comments", { presentationId: "deck1" }).catch((error) => error);
    expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
    expect(failure.message).toContain("COMMENTS_VIEW_MODE_OMITTED");
    expect(failure.message).toContain("may be incomplete");
  });

  it("says a 403 on a comment read most likely means the account may only view the deck", async () => {
    route = () => ({ status: 403, body: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } });
    const failure = await call(connection(), "list_comments", { presentationId: "deck1" }).catch((error) => error);
    expect(failure.code).toBe("provider_permission_denied");
    expect(failure.message).toContain("The caller does not have permission");
    expect(failure.message).toContain("Reading comments needs comment access");
  });

  it("pages threads by limit with one opaque cursor, each thread once and in order", async () => {
    route = () => ({ body: COMMENT_DECK });
    const connector = connection();
    const first = await call(connector, "list_comments", { presentationId: "deck1", limit: 2 });
    expect(first.threads.map((thread: any) => thread.commentId)).toEqual(["c1", "c2"]);
    expect(first.page.hasMore).toBe(true);
    const second = await call(connector, "list_comments", { presentationId: "deck1", limit: 2, cursor: first.page.nextCursor });
    expect(second.threads.map((thread: any) => thread.commentId)).toEqual(["c3"]);
    expect(second.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it("keeps every page of a worst-case comment list under the bridge cap, every id whole, and every text recoverable", async () => {
    // Long quotes and long posts in escape-heavy text, far past one result.
    // Without contentHtml, so the deck stays under the 16 MiB read ceiling.
    const noHtml = { contentHtml: undefined };
    const heavy = (chars: number, seed: number) => `${seed}:` + "\u0001😀x".repeat(Math.ceil(chars / 4)).slice(0, chars);
    // About two megabytes: ten or so pages, small enough to walk inside
    // workerd too, where every page re-reads and re-hashes the whole list.
    const threads = Array.from({ length: 20 }, (_, thread) => ({
      commentId: `c${thread}`,
      anchorId: `a${thread}`,
      status: "OPEN",
      plainTextQuote: heavy(thread % 7 === 0 ? 60_000 : 500, thread),
      headPost: slidesPost(`p${thread}`, heavy(thread % 5 === 0 ? 40_000 : 1_000, thread), { displayName: "Pat", user: `users/${thread}` }, noHtml),
      replies: Array.from({ length: thread % 6 === 0 ? 30 : 2 }, (_, reply) =>
        slidesPost(`p${thread}_${reply}`, heavy(reply % 13 === 0 ? 20_000 : 800, reply), { displayName: "Sam", user: `users/r${reply}` }, noHtml),
      ),
    }));
    route = () => ({ body: { ...COMMENT_DECK, comments: threads } });
    const connector = connection();
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "list_comments", { presentationId: "deck1", limit: 500, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && pages.length < 500);
    expect(cursor).toBeUndefined();
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) expect(bytes(page)).toBeLessThan(BRIDGE_BYTES);

    // Stitch every row back into threads by id, in order.
    const quotes = new Map<string, string>();
    const posts = new Map<string, { content: string; user: string | undefined }>();
    const strip = (value: string) => value.replace(/\n\[… \d+ more characters continue on the next page\]$/, "");
    const take = (post: any) => {
      const seen = posts.get(post.postId);
      if (seen) {
        expect(post.contentOffset).toBe(seen.content.length);
        seen.content += strip(post.content ?? "");
      } else {
        expect(post.contentOffset).toBeUndefined();
        posts.set(post.postId, { content: strip(post.content ?? ""), user: post.author?.user });
      }
    };
    for (const page of pages) {
      for (const row of page.threads) {
        if (row.quote !== undefined) quotes.set(row.commentId, (quotes.get(row.commentId) ?? "") + strip(row.quote));
        if (row.headPost) take(row.headPost);
        for (const reply of row.replies ?? []) take(reply);
      }
    }
    for (const thread of threads) {
      expect(quotes.get(thread.commentId), thread.commentId).toBe(thread.plainTextQuote);
      for (const post of [thread.headPost, ...thread.replies]) {
        expect(posts.get(post.postId)?.content, post.postId).toBe(post.content);
        expect(posts.get(post.postId)?.user, post.postId).toBe(post.author.user);
      }
    }
    // Every post exactly once, in Slides' order.
    expect([...posts.keys()]).toEqual(threads.flatMap((thread) => [thread.headPost, ...thread.replies].map((post) => post.postId)));
  });

  it("continues one thread across pages, saying where each row picks up", async () => {
    const replies = Array.from({ length: 3 }, (_, index) => slidesPost(`r${index}`, "y".repeat(100_000), SAM));
    route = () => ({ body: { ...COMMENT_DECK, comments: [{ ...THREADS[0], replies }] } });
    const connector = connection();
    const first = await call(connector, "list_comments", { presentationId: "deck1" });
    const row = first.threads[0];
    expect(row).toMatchObject({ commentId: "c1", truncated: true, replyCount: 3 });
    expect(row.continued).toBeUndefined();
    const cutPost = row.replies.at(-1);
    expect(cutPost.contentLength).toBe(100_000);
    expect(cutPost.content).toMatch(/more characters continue on the next page\]$/);
    const second = await call(connector, "list_comments", { presentationId: "deck1", cursor: first.page.nextCursor });
    const next = second.threads[0];
    expect(next).toMatchObject({ commentId: "c1", anchorId: "a1", status: "OPEN", continued: true, replyCount: 3 });
    expect(next.headPost).toBeUndefined();
    expect(next.quote).toBeUndefined();
    expect(next.repliesOffset).toBe(row.replies.length - 1);
    expect(next.replies[0].postId).toBe(cutPost.postId);
    expect(next.replies[0].contentOffset).toBeGreaterThan(0);
  });

  describe("cursors are bound to the deck, the page, the revision, and the threads", () => {
    async function firstPage(connector: Connector, deck: any, args: Record<string, unknown> = {}) {
      route = () => ({ body: deck });
      const page = await call(connector, "list_comments", { presentationId: "deck1", limit: 1, ...args });
      expect(page.page.hasMore).toBe(true);
      return page.page.nextCursor as string;
    }

    it("continues an unchanged deck", async () => {
      const connector = connection();
      const cursor = await firstPage(connector, COMMENT_DECK);
      const next = await call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor });
      expect(next.threads.map((thread: any) => thread.commentId)).toEqual(["c2"]);
    });

    const resolved = [{ ...THREADS[0], status: "RESOLVED" }, ...THREADS.slice(1)];
    const replied = [{ ...THREADS[0], replies: [...THREADS[0]!.replies!, slidesPost("p7", "More", SAM)] }, ...THREADS.slice(1)];
    it.each([
      ["the revision moved", COMMENT_DECK, { ...COMMENT_DECK, revisionId: "rev-2" }],
      ["a thread was added at the same revision", COMMENT_DECK, { ...COMMENT_DECK, comments: [THREADS[2], ...THREADS] }],
      ["a reply was added at the same revision", COMMENT_DECK, { ...COMMENT_DECK, comments: replied }],
      [
        "a thread was resolved, with no revision (a commenter)",
        { ...COMMENT_DECK, revisionId: undefined },
        { ...COMMENT_DECK, revisionId: undefined, comments: resolved },
      ],
    ])("is a conflict when %s", async (_label, before, after) => {
      const connector = connection();
      const cursor = await firstPage(connector, before);
      route = () => ({ body: after });
      await expect(call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("deck's comments changed"),
      });
    });

    it("is a conflict when an anchor moves to another element, with no revision and the threads unchanged", async () => {
      const deck = (objectId: string) => ({
        ...COMMENT_DECK,
        revisionId: undefined,
        slides: [{ objectId: "p", commentAnchors: [{ anchorId: "a2", objectAnchors: [{ objectId }] }] }],
      });
      const connector = connection();
      const cursor = await firstPage(connector, deck("shapeA"));
      route = () => ({ body: deck("shapeB") });
      await expect(call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor })).rejects.toMatchObject({
        code: "conflict",
      });
      // Unmoved, it continues, and places the thread where the anchor is.
      const fresh = await firstPage(connector, deck("shapeA"));
      const next = await call(connector, "list_comments", { presentationId: "deck1", limit: 1, cursor: fresh });
      expect(next.threads[0]).toMatchObject({ commentId: "c2", objectIds: ["shapeA"] });
    });

    it("refuses a cursor from another deck, page, or tool before any request", async () => {
      const connector = connection();
      const deckCursor = await firstPage(connector, COMMENT_DECK);
      const pageCursor = await firstPage(connector, { ...COMMENT_DECK, objectId: "p" }, { pageObjectId: "p" });
      route = () => ({ body: SLIDE_PAGE });
      const elementCursor = (await call(connector, "get_page", { presentationId: "deck1", pageObjectId: "s2", limit: 1 })).page.nextCursor;
      calls.length = 0;
      const refusals = [
        [{ presentationId: "deck2", cursor: deckCursor }, "different presentation"],
        [{ presentationId: "deck1", pageObjectId: "p", cursor: deckCursor }, "different page"],
        [{ presentationId: "deck1", pageObjectId: "s2", cursor: pageCursor }, "different page"],
        [{ presentationId: "deck1", cursor: elementCursor }, "another tool (get_page)"],
      ] as const;
      for (const [args, why] of refusals) {
        await expect(call(connector, "list_comments", args)).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining(why) });
      }
      await expect(call(connector, "get_page", { presentationId: "deck1", pageObjectId: "s2", cursor: deckCursor })).rejects.toMatchObject({
        message: expect.stringContaining("another tool (list_comments)"),
      });
      expect(calls).toEqual([]);
    });
  });
});

describe("comments: writes (#696)", () => {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const sent = (index = 0) => calls[index]!.body.requests;

  it("comments on a page, an element, a range of text, a cell's text, or a whole cell, each as Slides' one anchor", async () => {
    route = () => ({ body: insertedComment() });
    const range = (startIndex: number, endIndex: number) => ({ type: "FIXED_RANGE", startIndex, endIndex });
    const cases = [
      [{ objectId: "p" }, { objectId: "p" }],
      [{ objectId: "body", textRange: { startIndex: 0, endIndex: 11 } }, { shapeTextAnchor: { objectId: "body", textRange: range(0, 11) } }],
      [
        { objectId: "table", cell: { rowIndex: 1, columnIndex: 2 }, textRange: { startIndex: 0, endIndex: 3 } },
        { tableCellTextAnchor: { objectId: "table", cellLocation: { rowIndex: 1, columnIndex: 2 }, textRange: range(0, 3) } },
      ],
      [
        { objectId: "table", cell: { rowIndex: 0, columnIndex: 0 } },
        { tableAnchor: { objectId: "table", tableRange: { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 1 } } },
      ],
    ] as const;
    for (const [args, anchor] of cases) {
      calls.length = 0;
      await call(connection(), "create_comment", { presentationId: "deck1", content: "Bigger?", assigneeEmail: "sam@church.example", ...args });
      expect(calls[0]!.method).toBe("POST");
      expect(path(0)).toBe("/presentations/deck1:batchUpdate");
      expect(sent()).toEqual([{ insertComment: { ...anchor, content: "Bigger?", assigneeEmailAddress: "sam@church.example" } }]);
      expect(calls[0]!.body.writeControl).toBeUndefined();
    }
    calls.length = 0;
    await call(connection(), "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?", requiredRevisionId: "rev-1" });
    expect(calls[0]!.body.writeControl).toEqual({ requiredRevisionId: "rev-1" });
  });

  it("returns the new thread's commentId, head postId, and author's user id", async () => {
    route = () => ({ body: insertedComment() });
    const result = await call(connection(), "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" });
    expect(result).toEqual({
      presentationId: "deck1",
      revisionId: "rev-2",
      commentId: "c9",
      anchorId: "a9",
      status: "OPEN",
      headPost: {
        postId: "p9",
        author: { user: "users/1001", displayName: "Pat Pastor", me: true },
        content: "Bigger?",
        createTime: "2026-10-01T10:13:12Z",
        updateTime: "2026-10-01T10:13:12Z",
      },
    });
  });

  it("keeps every id whole when a reply is too large, and summarizes its text", async () => {
    const huge = "h".repeat(100_000);
    route = () => ({
      body: insertedComment({
        plainTextQuote: huge,
        headPost: slidesPost("p9", huge, { displayName: "d".repeat(50_000), user: "users/1001" }, { contentHtml: huge }),
        replies: Array.from({ length: 30 }, (_, index) => slidesPost(`r${index}`, huge, { displayName: "Sam", user: `users/r${index}` })),
      }),
    });
    const result = await call(connection(), "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" });
    expect(bytes(result)).toBeLessThan(64 * 1024);
    expect(result.commentId).toBe("c9");
    expect(result.anchorId).toBe("a9");
    expect(result.headPost.postId).toBe("p9");
    expect(result.headPost.author.user).toBe("users/1001");
    expect(result.headPost.content).toMatch(/list_comments has the whole post\]$/);
    expect(result.quote).toMatch(/list_comments has the whole quote\]$/);
    expect(result.replies.map((reply: any) => reply.postId)).toEqual(Array.from({ length: 30 }, (_, index) => `r${index}`));
    expect(result.replies.map((reply: any) => reply.author.user)).toEqual(Array.from({ length: 30 }, (_, index) => `users/r${index}`));
  });

  it("replies with a post and nothing else, returning the new post's id and author", async () => {
    route = () => ({
      body: { presentationId: "deck1", replies: [{ addCommentReply: { post: slidesPost("p11", "Done", SAM) } }], commentUpdateState: "ALL_SAVED" },
    });
    const result = await call(connection(), "create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done" });
    expect(sent()).toEqual([{ addCommentReply: { commentId: "c1", post: { content: "Done" } } }]);
    expect(result).toEqual({
      presentationId: "deck1",
      commentId: "c1",
      post: {
        postId: "p11",
        author: { user: "users/2002", displayName: "Sam Staff" },
        content: "Done",
        createTime: "2026-10-01T10:13:12Z",
        updateTime: "2026-10-01T10:13:12Z",
      },
    });
    // A reply cannot change the thread: those fields are not in its schema.
    for (const extra of [{ action: "RESOLVE" }, { status: "RESOLVED" }, { assigneeEmail: "sam@church.example" }]) {
      await expect(
        call(connection(), "create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done", ...extra }),
      ).rejects.toMatchObject({ code: "invalid_args" });
    }
  });

  it("resolves, reopens, or reassigns a thread as its own destructive write, with an optional note", async () => {
    route = () => ({
      body: { presentationId: "deck1", replies: [{ addCommentReply: { post: slidesPost("p12", "", SAM, { commentAction: "RESOLVE" }) } }], commentUpdateState: "ALL_SAVED" },
    });
    const result = await call(connection(), "update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "RESOLVED" });
    expect(sent()).toEqual([{ addCommentReply: { commentId: "c1", post: { commentAction: "RESOLVE" } } }]);
    expect(result.post).toMatchObject({ postId: "p12", commentAction: "RESOLVE", author: { user: "users/2002" } });
    for (const [args, post] of [
      [{ status: "OPEN", content: "Not yet" }, { content: "Not yet", commentAction: "REOPEN" }],
      [{ assigneeEmail: "sam@church.example", content: "Yours" }, { content: "Yours", assigneeEmail: "sam@church.example" }],
    ] as const) {
      calls.length = 0;
      await call(connection(), "update_comment_thread", { presentationId: "deck1", commentId: "c1", ...args });
      expect(sent()).toEqual([{ addCommentReply: { commentId: "c1", post } }]);
    }
  });

  it("updates a post and deletes a thread or a reply by id", async () => {
    route = () => ({ body: { presentationId: "deck1", replies: [{}], writeControl: { requiredRevisionId: "rev-3" }, commentUpdateState: "ALL_SAVED" } });
    const cases = [
      ["update_comment_post", { commentId: "c1", postId: "p1", content: "Smaller?" }, { updateCommentPost: { commentId: "c1", postId: "p1", content: "Smaller?" } }],
      ["delete_comment", { commentId: "c1" }, { deleteComment: { commentId: "c1" } }],
      ["delete_comment_reply", { commentId: "c1", postId: "p2" }, { deleteCommentReply: { commentId: "c1", postId: "p2" } }],
    ] as const;
    for (const [name, args, request] of cases) {
      calls.length = 0;
      const result = await call(connection(), name, { presentationId: "deck1", ...args });
      expect(sent(), name).toEqual([request]);
      const { content: _content, ...ids } = args as Record<string, unknown>;
      expect(result, name).toEqual({ presentationId: "deck1", revisionId: "rev-3", ...ids });
    }
  });

  it("refuses what Slides can only refuse, before any token or request", async () => {
    const refusals = [
      ["create_comment", { presentationId: "deck1", objectId: "p", content: "é".repeat(1_025) }, "2050 UTF-8 bytes"],
      ["create_comment", { presentationId: "deck1", objectId: "p", content: "x", textRange: { startIndex: 5, endIndex: 5 } }, "endIndex"],
      ["update_comment_post", { presentationId: "deck1", commentId: "c1", postId: "p1", content: "😀".repeat(513) }, "2052 UTF-8 bytes"],
    ] as const;
    for (const [name, args, why] of refusals) {
      await expect(call(connection(), name, args), why).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining(why) });
    }
    for (const [name, args] of [
      ["create_comment", { presentationId: "deck1", objectId: "p" }],
      ["create_comment", { presentationId: "deck1", objectId: "p", content: "" }],
      ["create_comment_reply", { presentationId: "deck1", commentId: "c1" }],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "DELETED" }],
      // Runtime validation keeps the alternatives out of discovery's schema.
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1" }],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", content: "x" }],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "RESOLVED", assigneeEmail: "a@b.example" }],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "RESOLVED", assigneeEmail: "a@b.example", content: "x" }],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", assigneeEmail: "a@b.example" }],
      ["delete_comment", { presentationId: "deck1", commentId: "c 1" }],
      ["delete_comment_reply", { presentationId: "deck1", commentId: "c1" }],
    ] as const) {
      await expect(call(connection(), name, args)).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it("keeps the complete thread-update input inside the discovery rendering budget (H7)", async () => {
    const tool = (await connection().listTools(context())).find((entry) => entry.name === "update_comment_thread")!;
    const rendered = compactDiscoverySchema(tool.inputSchema!);
    for (const parameter of ["presentationId", "commentId", "status", "assigneeEmail", "content"]) {
      expect(rendered.text).toContain(parameter);
    }
    expect(rendered.text).toContain('"RESOLVED" | "OPEN"');
    expect(rendered.text).toContain("content?: string /* length >= 1; length <= 2048 */");
    expect(rendered.truncated).toBe(false);
    expect(new TextEncoder().encode(rendered.text).length).toBeLessThanOrEqual(MAX_COMPACT_DISCOVERY_SCHEMA_BYTES);
  });

  it("discovers thread-update parameters, enum values, and bounds through search_tools and connecta.search (H7)", async () => {
    const connector = connection();
    const registry = makeRegistry([connector]);
    const args = { connector: "decks", query: "update_comment_thread", includeSchemas: "typescript" as const };
    const searched = await createMetaTools(registry, "https://connecta.example").searchTools(args);
    const grouped = JSON.parse(required(searched.content[0]).text) as {
      connectors: { tools: { name: string; signature: string; inputSchemaTruncated?: boolean }[] }[];
    };
    const topLevel = required(grouped.connectors.flatMap((entry) => entry.tools).find((tool) => tool.name === "update_comment_thread"));
    const providers = await buildSandboxProviders(registry, "https://connecta.example", silentLogger);
    const program = await required(required(providers.find((provider) => provider.name === "connecta")).fns.search)(args) as {
      tools: { name: string; signature: string; inputSchemaTruncated?: boolean }[];
    };
    const inProgram = required(program.tools.find((tool) => tool.name === "update_comment_thread"));
    const tool = required((await connector.listTools(context())).find((entry) => entry.name === "update_comment_thread"));
    const rendered = typescriptSignature(tool.inputSchema!, tool.outputSchema, { observed: false, description: false });
    for (const discovered of [topLevel, inProgram]) {
      expect(discovered.signature).toBe(rendered.text);
      const input = discovered.signature.slice("(args: ".length, discovered.signature.indexOf(") => Promise<"));
      for (const parameter of [
        "presentationId: string /* length >= 1; length <= 256;",
        "commentId: string /* length >= 1; length <= 1024;",
        'status?: "RESOLVED" | "OPEN"',
        "assigneeEmail?: string /* length >= 3; length <= 320;",
        "content?: string /* length >= 1; length <= 2048 */",
      ]) {
        expect(input).toContain(parameter);
      }
      expect(new TextEncoder().encode(input).length).toBeLessThanOrEqual(MAX_COMPACT_DISCOVERY_SCHEMA_BYTES);
      expect(discovered.inputSchemaTruncated).toBeUndefined();
    }
    expect(rendered.inputTruncated).toBe(false);
    expect(rendered.outputTruncated).toBe(false);
    expect(calls).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it("declares thread-update fields and describes runtime alternatives", async () => {
    const tool = (await connection().listTools(context())).find((entry) => entry.name === "update_comment_thread")!;
    expect(tool.description).toContain("Pass exactly one of status or assigneeEmail");
    expect(tool.description).toContain("reassignment requires content");
    const check = (args: Record<string, unknown>) =>
      validateToolInput(tool.inputSchema!, { presentationId: "deck1", commentId: "c1", ...args }, {
        address: "decks.update_comment_thread",
        logger: silentLogger,
        failClosed: true,
      })?.message;
    expect(check({ status: "RESOLVED" })).toBeUndefined();
    expect(check({ status: "OPEN", content: "Not yet" })).toBeUndefined();
    expect(check({ assigneeEmail: "a@b.example", content: "Yours" })).toBeUndefined();
    for (const args of [{ status: "DELETED" }, { assigneeEmail: "a@b.example", content: "" }, { status: "OPEN", extra: true }]) {
      expect(check(args), JSON.stringify(args)).toBeDefined();
    }
  });

  it("says a comment create whose outcome is unknown may have applied, and to look before sending it again", async () => {
    route = () => ({
      response: () => {
        throw new TypeError("fetch failed");
      },
    });
    for (const [name, args, advice] of [
      ["create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" }, "look for it before commenting again"],
      ["create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done" }, "look for the post before sending it again"],
      ["update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "RESOLVED" }, "look for the post before sending it again"],
    ] as const) {
      const failure = await call(connection(), name, args).catch((error) => error);
      expect(failure).toMatchObject({ code: "connector_call_failed", retryable: false });
      expect(failure.message).toContain("may or may not have been applied");
      expect(failure.message).toContain(advice);
    }
  });

  it("refuses a saved create with no usable id by saying it applied, never that nothing changed", async () => {
    route = () => ({ body: insertedComment({ commentId: "c".repeat(5_000) }) });
    const failure = await call(connection(), "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" }).catch((error) => error);
    expect(failure.message).toContain("create_comment applied — Google answered 2xx");
    expect(failure.message).toContain("list_comments");
    expect(failure.message).not.toMatch(/nothing (was|is) (applied|changed)/i);
  });

  it("flags, never cuts, an author id too long to copy", async () => {
    const author = { displayName: "Sam", user: `users/${"9".repeat(5_000)}` };
    route = () => ({
      body: { presentationId: "deck1", replies: [{ addCommentReply: { post: slidesPost("p11", "Done", author) } }], commentUpdateState: "ALL_SAVED" },
    });
    const result = await call(connection(), "create_comment_reply", { presentationId: "deck1", commentId: "c1", content: "Done" });
    expect(result.post.postId).toBe("p11");
    expect(result.post.author).toEqual({ displayName: "Sam" });
    expect(result.idsNotShown).toBe(true);
  });
});

describe("comments: partial saves are reported, not hidden (#696)", () => {
  const sent = () => calls[0]!.body.requests;
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
    ["update_comment_thread", { presentationId: "deck1", commentId: "c1", status: "OPEN" }],
    ["update_comment_post", { presentationId: "deck1", commentId: "c1", postId: "p1", content: "Smaller?" }],
    ["delete_comment", { presentationId: "deck1", commentId: "c1" }],
    ["delete_comment_reply", { presentationId: "deck1", commentId: "c1", postId: "p2" }],
  ])("%s reports a 2xx whose comment change did not save, as a result rather than a failure", async (name, args) => {
    route = () => ({ body: unsaved });
    const result = await call(connection(), name, args);
    expect(result.presentationId).toBe("deck1");
    expect(result.revisionId).toBe("rev-2");
    expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
  });

  it("keeps whatever ids Slides did send beside an unsaved state", async () => {
    route = () => ({ body: insertedComment({}, { commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" }) });
    const result = await call(connection(), "create_comment", { presentationId: "deck1", objectId: "p", content: "Bigger?" });
    expect(result.commentId).toBe("c9");
    expect(result.headPost.postId).toBe("p9");
    expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
  });

  it("reports a comment write Slides gave no state for as unspecified, since nothing said it saved", async () => {
    route = () => ({ body: { presentationId: "deck1", replies: [{}] } });
    const result = await call(connection(), "delete_comment", { presentationId: "deck1", commentId: "c1" });
    expectReported(result, "COMMENT_UPDATE_STATE_UNSPECIFIED");
  });

  it("says nothing extra when Slides reports ALL_SAVED", async () => {
    route = () => ({ body: { ...unsaved, commentUpdateState: "ALL_SAVED" } });
    const result = await call(connection(), "delete_comment", { presentationId: "deck1", commentId: "c1" });
    expect(result.commentUpdateState).toBeUndefined();
    expect(result.note).toBeUndefined();
  });

  describe("in the raw hatch", () => {
    const batch = (...requests: Record<string, unknown>[]) => ({ presentationId: "deck1", requiredRevisionId: "rev-1", requests });

    it("accepts every Request kind in Slides' Discovery document, comment kinds included", async () => {
      // `Request`'s properties at Discovery revision 20260930, the revision
      // src/providers/slides/drift.json records. A kind Google adds moves
      // batchUpdate's digested contract, and the drift check says so.
      const discovery = [
        "addCommentReply", "createImage", "createLine", "createParagraphBullets", "createShape", "createSheetsChart",
        "createSlide", "createTable", "createVideo", "deleteComment", "deleteCommentReply", "deleteObject",
        "deleteParagraphBullets", "deleteTableColumn", "deleteTableRow", "deleteText", "duplicateObject", "groupObjects",
        "insertComment", "insertTableColumns", "insertTableRows", "insertText", "mergeTableCells", "refreshSheetsChart",
        "replaceAllShapesWithImage", "replaceAllShapesWithSheetsChart", "replaceAllText", "replaceImage", "rerouteLine",
        "ungroupObjects", "unmergeTableCells", "updateCommentPost", "updateImageProperties", "updateLineCategory",
        "updateLineProperties", "updatePageElementAltText", "updatePageElementTransform", "updatePageElementsZOrder",
        "updatePageProperties", "updateParagraphStyle", "updateShapeProperties", "updateSlideProperties",
        "updateSlidesPosition", "updateTableBorderProperties", "updateTableCellProperties", "updateTableColumnProperties",
        "updateTableRowProperties", "updateTextStyle", "updateVideoProperties",
      ];
      expect(discovery).toHaveLength(49);
      route = () => ({ body: { presentationId: "deck1", replies: discovery.map(() => ({})), commentUpdateState: "ALL_SAVED" } });
      await call(connection(), "batch_update_presentation", batch(...discovery.map((kind) => ({ [kind]: {} }))));
      expect(sent().map((request: Record<string, unknown>) => Object.keys(request)[0])).toEqual(discovery);
    });

    it.each(["insertComment", "addCommentReply", "updateCommentPost", "deleteComment", "deleteCommentReply"])(
      "sends %s as Slides' own request",
      async (kind) => {
        route = () => ({ body: { presentationId: "deck1", replies: [{}, {}], commentUpdateState: "ALL_SAVED" } });
        const result = await call(
          connection(),
          "batch_update_presentation",
          batch({ insertText: { objectId: "t", text: "x" } }, { [kind]: { commentId: "c1" } }),
        );
        expect(sent()).toEqual([{ insertText: { objectId: "t", text: "x" } }, { [kind]: { commentId: "c1" } }]);
        expect(result.commentUpdateState).toBeUndefined();
        expect(result.note).toBeUndefined();
      },
    );

    it("reports a batch whose deck changes applied and whose comments did not", async () => {
      route = () => ({ body: { ...unsaved, replies: [{}, {}] } });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch({ insertText: { objectId: "t", text: "x" } }, { insertComment: { objectId: "p", content: "c" } }),
      );
      expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
      expect(result.note).toContain("re-read with get_presentation or get_page for deck changes, and list_comments for comments");
    });

    it("cuts text before ids even when every reply is small: 100 replies of about 2 KB each stay under the budget", async () => {
      const posts = Array.from({ length: 100 }, (_, index) => slidesPost(`p${index}`, "w".repeat(890), SAM, { contentHtml: "h".repeat(890) }));
      route = () => ({ body: { presentationId: "deck1", replies: posts.map((post) => ({ addCommentReply: { post } })), commentUpdateState: "ALL_SAVED" } });
      const result = await call(connection(), "batch_update_presentation", batch(...posts.map(() => ({ addCommentReply: { commentId: "c1", post: { content: "w" } } }))));
      const size = new TextEncoder().encode(JSON.stringify(result)).length;
      expect(size).toBeLessThanOrEqual(192 * 1024);
      expect(result.replies.map((reply: any) => reply.addCommentReply.post.postId)).toEqual(posts.map((post) => post.postId));
      expect(result.replies.map((reply: any) => reply.addCommentReply.post.author.user)).toEqual(posts.map(() => "users/2002"));
      // The later replies gave up their text so every one keeps its ids.
      expect(result.replies.at(-1).cut).toEqual([expect.stringContaining("ids only")]);
      expect(result.note).toContain("every id is kept");
      expect(result.note).not.toContain("execute_code");
    });

    it("returns ids past the provider budget but under the 256 KiB bridge with no get_result caveat", async () => {
      const replies = Array.from({ length: 200 }, (_, index) => ({ createShape: { objectId: `s${index}_${"z".repeat(1_000)}` } }));
      route = () => ({ body: { presentationId: "deck1", replies } });
      const result = await call(connection(), "batch_update_presentation", batch({ createShape: {} }));
      const size = new TextEncoder().encode(JSON.stringify(result)).length;
      expect(size).toBeGreaterThan(192 * 1024);
      expect(size).toBeLessThanOrEqual(256 * 1024);
      expect(result.replies).toHaveLength(200);
      expect(result.note).toBeUndefined();
    });

    it("keeps the save state and the way back when even the ids pass any result, and never says applied", async () => {
      const longId = (prefix: string, index: number) => `${prefix}${index}_${"i".repeat(1_000)}`;
      const threads = Array.from({ length: 100 }, (_, index) => ({
        commentId: longId("c", index),
        anchorId: longId("a", index),
        status: "OPEN",
        headPost: { postId: longId("p", index), author: { user: `users/${longId("u", index)}` } },
        replies: Array.from({ length: 21 }, (_, reply) => ({ postId: longId(`r${reply}_`, index), author: { user: `users/${longId(`v${reply}_`, index)}` } })),
      }));
      route = () => ({
        body: {
          presentationId: "deck1",
          replies: threads.map((commentThread) => ({ insertComment: { commentThread } })),
          commentUpdateState: "ALL_FAILED_UNKNOWN_REASON",
          writeControl: { requiredRevisionId: "rev-2" },
        },
      });
      const result = await call(connection(), "batch_update_presentation", batch(...threads.map(() => ({ insertComment: { objectId: "p", content: "x" } }))));
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

    it("never says a comment-only batch applied when Slides did not confirm its comments, even with a summarized reply", async () => {
      const content = "c".repeat(2_048);
      route = () => ({
        body: insertedComment(
          { plainTextQuote: content, headPost: slidesPost("p9", content) },
          { commentUpdateState: "ALL_FAILED_UNKNOWN_REASON" },
        ),
      });
      const result = await call(connection(), "batch_update_presentation", batch({ insertComment: { objectId: "p", content } }));
      expect(result.replies[0].cut.length).toBeGreaterThan(0);
      expect(result.replies[0].insertComment.commentThread.commentId).toBe("c9");
      expectReported(result, "ALL_FAILED_UNKNOWN_REASON");
      expect(result.note).not.toMatch(/(write|batch) applied/i);
      expect(result.note).toContain("Slides accepted the write but did not report its comment changes saved");
    });

    it("returns every created comment, anchor, post, and author id from a 100-comment batch, cutting text first", async () => {
      const id = (prefix: string, index: number) => `${prefix}${index}_${"i".repeat(150)}`;
      const threads = Array.from({ length: 100 }, (_, index) => ({
        commentId: id("c", index),
        anchorId: id("a", index),
        status: "OPEN",
        plainTextQuote: "q".repeat(2_000),
        headPost: slidesPost(id("p", index), "x".repeat(2_048), { displayName: "Pat", user: `users/${id("u", index)}` }),
      }));
      route = () => ({
        body: {
          presentationId: "deck1",
          replies: threads.map((commentThread) => ({ insertComment: { commentThread } })),
          commentUpdateState: "ALL_SAVED",
          writeControl: { requiredRevisionId: "rev-2" },
        },
      });
      const result = await call(
        connection(),
        "batch_update_presentation",
        batch(...threads.map(() => ({ insertComment: { objectId: "p", content: "x" } }))),
      );
      expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(256 * 1024);
      expect(result.replies).toHaveLength(100);
      expect(result.repliesNotShown).toBeUndefined();
      const shown = result.replies.map((reply: any) => reply.insertComment.commentThread);
      expect(shown.map((thread: any) => thread.commentId)).toEqual(threads.map((thread) => thread.commentId));
      expect(shown.map((thread: any) => thread.anchorId)).toEqual(threads.map((thread) => thread.anchorId));
      expect(shown.map((thread: any) => thread.headPost.postId)).toEqual(threads.map((thread) => thread.headPost.postId));
      expect(shown.map((thread: any) => thread.headPost.author.user)).toEqual(threads.map((thread) => thread.headPost.author.user));
      expect(result.note).toContain("list_comments");
      expect(result.note).not.toContain("get_presentation or get_page for what it");
    });

    it("reports a batch with comment requests and no state as unspecified, and one without them as settled", async () => {
      route = () => ({ body: { presentationId: "deck1", replies: [{}] } });
      expectReported(
        await call(connection(), "batch_update_presentation", batch({ deleteComment: { commentId: "c1" } })),
        "COMMENT_UPDATE_STATE_UNSPECIFIED",
      );
      for (const state of [undefined, "NO_UPDATES_REQUESTED", "ALL_SAVED"]) {
        route = () => ({ body: { presentationId: "deck1", replies: [{}], ...(state ? { commentUpdateState: state } : {}) } });
        const result = await call(connection(), "batch_update_presentation", batch({ deleteObject: { objectId: "x" } }));
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

    it("keeps a large insertComment reply's comment, post, and author ids whole, and names what it cut", async () => {
      const long = "l".repeat(5_000);
      route = () => ({
        body: insertedComment({
          plainTextQuote: long,
          headPost: slidesPost("p9", long, { displayName: "Pat", user: "users/1001" }, { contentHtml: long }),
          replies: Array.from({ length: 25 }, (_, index) => slidesPost(`r${index}`, long, { displayName: "Sam", user: `users/r${index}` })),
        }),
      });
      const result = await call(connection(), "batch_update_presentation", batch({ insertComment: { objectId: "p", content: "c" } }));
      const thread = result.replies[0].insertComment.commentThread;
      expect(thread.commentId).toBe("c9");
      expect(thread.anchorId).toBe("a9");
      expect(thread.headPost.postId).toBe("p9");
      expect(thread.headPost.author.user).toBe("users/1001");
      expect(thread.replies.map((reply: any) => reply.postId)).toEqual(Array.from({ length: 25 }, (_, index) => `r${index}`));
      expect(thread.replies.map((reply: any) => reply.author.user)).toEqual(Array.from({ length: 25 }, (_, index) => `users/r${index}`));
      expect(result.replies[0].cut).toContain("insertComment.commentThread.headPost.content");
      expect(result.note).toContain("Large reply fields are named in cut");
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
    expect(result.threads[0].commentAnchors[0].objectAnchors[0].shapeTextAnchors.ranges).toEqual([{ startIndex: 0, endIndex: 11 }]);
    expect(result.threads[1].headPost.fromCopiedPresentation).toBe(true);
    expect(result.threads[1].commentAnchors).toEqual([{ pageObjectId: "p_notes", anchorId: "a2", objectAnchors: [{ objectId: "n1" }] }]);
    expect(validateToolInput(tool.outputSchema!, result, { address: "decks.list_comments", logger: silentLogger, failClosed: true })?.message).toBeUndefined();
  });

  it("sends a thread too large for one result in JSON chunks that parse back to it, under the same budget and binding", async () => {
    const replies = Array.from({ length: 40 }, (_, index) => slidesPost(`r${index}`, "z".repeat(10_000), SAM));
    const big = { ...THREADS[0], replies };
    route = () => ({ body: { ...COMMENT_DECK, comments: [THREADS[1], big, THREADS[2]] } });
    const connector = connection();
    const pages: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(connector, "list_comments", { presentationId: "deck1", raw: true, ...(cursor ? { cursor } : {}) });
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
      const page = await call(connector, "list_comments", { presentationId: "deck1", raw: true, ...(cursor ? { cursor } : {}) });
      rows.push(...page.threads);
      cursor = page.page.nextCursor ?? undefined;
    } while (cursor && rows.length < 50);
    const whole = JSON.parse(rows.map((row) => row.rawJson.json).join(""));
    expect(whole.commentAnchors[0].objectAnchors).toHaveLength(300);
  });
});

describe("comments in the guide (#696)", () => {
  it("describes comment support and partial saves, and no longer says comments are unsupported", () => {
    const content = guide(connection()).content;
    expect(content).toContain("## Comments");
    expect(content).toContain("`list_comments`");
    expect(content).toContain("`author.user`");
    expect(content).toContain("`commentUpdateState`");
    expect(content).toContain("Do not repeat it");
    expect(content).not.toContain("not supported yet");
  });
});
