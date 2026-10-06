// The Google Slides connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, and the classifications it
// declares — H1, H9, H10, and H11 for this provider. Delegation, subjects, and
// tokens are test/google-workspace-delegation.test.ts; the one subject check
// here proves this provider rides the same fail-closed path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLIDES_API_BASE_URL, SLIDES_SCOPES, slides } from "../src/providers/slides.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { validateToolInput } from "../src/validate.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide, JsonSchema } from "../src/types.js";

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

  it("has exactly eight tools, and none that shares, moves, or deletes a deck", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "batch_update_presentation",
      "create_presentation",
      "create_slide",
      "get_page",
      "get_presentation",
      "get_slide_thumbnail",
      "list_layouts",
      "replace_all_text",
    ]);
  });

  it("classifies reads as read-only, creates as additive, and replacement and the raw hatch as destructive", async () => {
    const connector = connection();
    const byName = Object.fromEntries((await connector.listTools(context())).map((tool) => [tool.name, tool]));
    for (const name of ["get_presentation", "get_slide_thumbnail"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: true });
      expect(isExplicitlyReadOnly(byName[name]!)).toBe(true);
    }
    for (const name of ["create_presentation", "create_slide"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    }
    for (const name of ["replace_all_text", "batch_update_presentation"]) {
      expect(byName[name]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
      expect(isExplicitlyReadOnly(byName[name]!)).toBe(false);
    }
    // The provider never exempts itself, and has no slot or OAuth of its own.
    expect(connector.approval).toBeUndefined();
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
    expect(failure.code).toBe("auth_required");
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

    // The validator bites: a wrong type is caught, so a pass below means something.
    expect(validates(schemas["get_presentation"]!, { presentationId: 7 }, "decks.get_presentation")).toBeDefined();
    const gaps: string[] = [];
    for (const [name, output] of outputs) {
      undeclared(schemas[name], output, name, gaps);
      expect(validates(schemas[name]!, output, `decks.${name}`), name).toBeUndefined();
    }
    // The one passthrough: Slides' own Response union, one reply per request,
    // with as many kinds as the requests have.
    expect([...new Set(gaps)]).toEqual(["batch_update_presentation.replies[] (opaque)"]);
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

describe("every result is deliverable, in a program and directly", () => {
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

describe("get_page and list_layouts: every page, element, and layout is reachable", () => {
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
