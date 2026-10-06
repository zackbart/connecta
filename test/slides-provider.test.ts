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

  it("has exactly six tools, and none that shares, moves, or deletes a deck", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "batch_update_presentation",
      "create_presentation",
      "create_slide",
      "get_presentation",
      "get_slide_thumbnail",
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
    expect(fields).toContain("notesPage(notesProperties");
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
        { objectId: "L1", name: "TITLE", displayName: "Title slide" },
        { objectId: "L2", name: "TITLE_AND_BODY", displayName: "Title and body" },
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
      text: "Easter Sun\n[… 3 more characters truncated; raise maxCharsPerSlide to read them]",
      truncated: true,
    });
    // The budget is spent: the next element says so rather than vanishing.
    expect(first.elements[1].text).toBe(
      "\n[… 18 more characters truncated; raise maxCharsPerSlide to read them]",
    );
    expect(first.notes).toBe("Welcome ev\n[… 7 more characters truncated; raise maxCharsPerSlide to read them]");
    // The title is bounded by the same cap, and says so.
    expect(first.title).toBe("Easter Sun\n[… 3 more characters truncated; raise maxCharsPerSlide to read them]");
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
    expect(zero.slides[0].title).toBe("\n[… 100000 more characters truncated; raise maxCharsPerSlide to read them]");
    const most = await call(connection(), "get_presentation", { presentationId: "deck1", maxCharsPerSlide: 50_000 });
    expect(most.slides[0].title).toMatch(/^T{500}\n\[… 99500 more characters truncated/);
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
