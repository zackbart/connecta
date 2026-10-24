import { slides } from "../../../src/providers/slides/index.js";
import { defineGoldenSpec } from "../harness.js";

import { PRIVATE_KEY } from "../rsa-fixture.js";

const ACCESS_TOKEN = "golden-slides-access-token/123+456=";

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

const MASTERS = [{ objectId: "M1", masterProperties: { displayName: "Light" } }];

const LAYOUTS = [
  { objectId: "L1", layoutProperties: { name: "TITLE", displayName: "Title slide", masterObjectId: "M1" } },
  { objectId: "L2", layoutProperties: { name: "TITLE_AND_BODY", displayName: "Title and body", masterObjectId: "M1" } },
];

const SLIDE_TWO = {
  objectId: "s2",
  slideProperties: { layoutObjectId: "L2", isSkipped: true },
  pageElements: [
    {
      objectId: "group",
      transform: { scaleX: 1, scaleY: 1, translateX: 100, translateY: 0, unit: "PT" },
      elementGroup: {
        children: [
          {
            objectId: "g-table",
            transform: at(0, 1270000),
            table: {
              rows: 2,
              columns: 2,
              tableRows: [
                { tableCells: [{ text: textContent("Time\n") }, { text: textContent("Service\n") }] },
                { tableCells: [{ text: textContent("9:00\n") }, { text: textContent("Sunrise\nservice\n") }] },
              ],
            },
          },
        ],
      },
    },
    {
      objectId: "photo",
      transform: at(0, 1270000),
      title: "Empty tomb",
      description: "Sunrise photo",
      image: { contentUrl: "https://lh3.example/x" },
    },
    { objectId: "chart", transform: at(0, 3000000), sheetsChart: { spreadsheetId: "sheet1" } },
  ],
};

const PRESENTATION = {
  presentationId: "deck1",
  title: "Easter Sunday",
  revisionId: "rev-1",
  locale: "en",
  pageSize: { width: { magnitude: 9144000, unit: "EMU" }, height: { magnitude: 5143500, unit: "EMU" } },
  masters: MASTERS,
  layouts: LAYOUTS,
  slides: [
    {
      objectId: "p",
      slideProperties: {
        layoutObjectId: "L1",
        notesPage: {
          objectId: "p_notes",
          notesProperties: { speakerNotesObjectId: "n1" },
          pageElements: [
            { objectId: "slideImage", image: { contentUrl: "https://lh3.example/y" } },
            { objectId: "n1", shape: { shapeType: "TEXT_BOX", text: textContent("Welcome everyone.\n") } },
          ],
        },
      },
      pageElements: [
        {
          objectId: "body",
          transform: at(311700, 2000000),
          shape: {
            shapeType: "TEXT_BOX",
            placeholder: { type: "SUBTITLE" },
            text: textContent("He is risen\u000bindeed\n"),
          },
        },
        {
          objectId: "title",
          transform: at(311700, 744575),
          shape: {
            shapeType: "TEXT_BOX",
            placeholder: { type: "CENTERED_TITLE" },
            text: textContent("Easter ", "Sunday\n"),
          },
        },
        { objectId: "rule", transform: at(0, 1500000), line: { lineType: "STRAIGHT_LINE" } },
      ],
    },
    SLIDE_TWO,
    { objectId: "s3", slideProperties: { layoutObjectId: "L2" }, pageElements: [] },
  ],
};

const SLIDE_PAGE = {
  ...SLIDE_TWO,
  pageType: "SLIDE",
  revisionId: "rev-1",
  slideProperties: { layoutObjectId: "L2", masterObjectId: "M1", isSkipped: true, notesPage: { objectId: "s2_notes" } },
};

const ALICE = { displayName: "Alice", me: true, user: "users/1001" };
const BOB = { displayName: "Bob", me: false, user: "users/2002" };

function post(postId: string, content: string, author: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    postId,
    content,
    contentHtml: `<span>${content}</span>`,
    author,
    createTime: "2026-01-01T10:13:12Z",
    updateTime: "2026-01-01T10:13:12Z",
    ...extra,
  };
}

const THREADS = [
  {
    commentId: "c1",
    anchorId: "a1",
    status: "OPEN",
    plainTextQuote: "He is risen",
    headPost: post("p1", "Should this be bigger?", ALICE),
    replies: [post("p2", "Agreed.", BOB), post("p3", "", BOB, { commentAction: "RESOLVE", contentHtml: "" })],
  },
  {
    commentId: "c2",
    anchorId: "a2",
    status: "RESOLVED",
    headPost: post("p4", "Typo in the notes", { anonymous: true }),
  },
];

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
  ],
};

const saved = (extra: Record<string, unknown>) => [
  { body: { presentationId: "deck1", commentUpdateState: "ALL_SAVED", ...extra } },
];

export default defineGoldenSpec({
  provider: "slides",
  // Delegated tokens are cached per service account for the process, so each
  // scenario names its own account and mints its own token.
  create: (scenario) =>
    slides("decks", {
      purpose: "Sermon slides",
      serviceAccount: {
        clientEmail: `slides-${scenario}@project.iam.gserviceaccount.com`,
        privateKey: PRIVATE_KEY,
      },
      subject: "alice@example.com",
    }),
  secrets: { privateKey: PRIVATE_KEY, accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === "https://oauth2.googleapis.com/token",
      reply: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } },
    },
  ],
  failureReply: (status, message) => ({
    status,
    body: { error: { code: status, message, status: "GOLDEN_FAILURE" } },
  }),
  calls: [
    { tool: "slides_api_search", args: { query: "format slide text" }, replies: [] },
    { tool: "slides_api_details", args: { method: "GET", path: "/presentations/{presentationsId}" }, replies: [] },
    {
      tool: "slides_api_write",
      args: {
        method: "POST",
        path: "/presentations/deck1:batchUpdate",
        body: {
          requests: [{ createSlide: { objectId: "newslide" } }, { insertComment: { objectId: "p", content: "Hello" } }],
          writeControl: { requiredRevisionId: "rev-1" },
        },
      },
      replies: [
        {
          body: {
            presentationId: "deck1",
            replies: [
              { createSlide: { objectId: "newslide" } },
              { insertComment: { commentThread: { commentId: "newcomment", headPost: { postId: "newpost" } } } },
            ],
            commentUpdateState: "ALL_FAILED_UNKNOWN_REASON",
          },
        },
      ],
    },

    { tool: "get_presentation", args: { presentationId: "deck1" }, replies: [{ body: PRESENTATION }] },
    {
      label: "structural presentation hatch",
      tool: "slides_api_read",
      args: { path: "/presentations/deck1" },
      replies: [{ body: PRESENTATION }],
    },
    {
      tool: "get_page",
      args: { presentationId: "deck1", pageObjectId: "s2" },
      replies: [{ body: SLIDE_PAGE }],
    },
    {
      tool: "list_layouts",
      args: { presentationId: "deck1" },
      replies: [{ body: PRESENTATION }],
    },
    { tool: "list_comments", args: { presentationId: "deck1" }, replies: [{ body: COMMENT_DECK }] },
    {
      tool: "get_slide_thumbnail",
      args: { presentationId: "deck1", slideObjectId: "g1a2b3c_0:4", size: "MEDIUM" },
      replies: [{ body: { contentUrl: "https://lh7.googleusercontent.com/thumb", width: 800, height: 450 } }],
    },
    {
      tool: "create_presentation",
      args: { title: "Staff meeting" },
      replies: [
        {
          body: { ...PRESENTATION, presentationId: "new1", title: "Staff meeting", slides: [{ objectId: "p" }] },
        },
      ],
    },
    {
      tool: "create_slide",
      args: { presentationId: "deck1", layout: "TITLE_AND_BODY", insertionIndex: 1 },
      replies: [
        {
          body: {
            presentationId: "deck1",
            replies: [{ createSlide: { objectId: "gNew" } }],
            writeControl: { requiredRevisionId: "rev-2" },
          },
        },
      ],
    },
    {
      tool: "replace_all_text",
      args: {
        presentationId: "deck1",
        replacements: [
          { find: "{{date}}", replace: "April 20" },
          { find: "easter", replace: "Easter", matchCase: false },
        ],
        slideObjectIds: ["p", "s2"],
        requiredRevisionId: "rev-1",
      },
      replies: [
        {
          body: {
            presentationId: "deck1",
            replies: [{ replaceAllText: { occurrencesChanged: 3 } }, { replaceAllText: {} }],
            writeControl: { requiredRevisionId: "rev-2" },
          },
        },
      ],
    },
    {
      tool: "create_comment",
      args: {
        presentationId: "deck1",
        objectId: "body",
        textRange: { startIndex: 0, endIndex: 11 },
        content: "Bigger?",
        assigneeEmail: "bob@example.com",
      },
      replies: saved({
        replies: [
          {
            insertComment: {
              commentThread: {
                commentId: "c9",
                anchorId: "a9",
                status: "OPEN",
                headPost: post("p9", "Bigger?", ALICE),
              },
            },
          },
        ],
        writeControl: { requiredRevisionId: "rev-2" },
      }),
    },
    {
      tool: "create_comment_reply",
      args: { presentationId: "deck1", commentId: "c1", content: "Done" },
      replies: saved({ replies: [{ addCommentReply: { post: post("p11", "Done", BOB) } }] }),
    },
    {
      tool: "update_comment_thread",
      args: { presentationId: "deck1", commentId: "c1", status: "RESOLVED" },
      replies: saved({
        replies: [{ addCommentReply: { post: post("p12", "", BOB, { commentAction: "RESOLVE", contentHtml: "" }) } }],
      }),
    },
    {
      tool: "update_comment_post",
      args: { presentationId: "deck1", commentId: "c1", postId: "p1", content: "Smaller?" },
      replies: saved({ replies: [{}], writeControl: { requiredRevisionId: "rev-3" } }),
    },
    {
      tool: "delete_comment",
      args: { presentationId: "deck1", commentId: "c1" },
      replies: saved({ replies: [{}], writeControl: { requiredRevisionId: "rev-3" } }),
    },
    {
      tool: "delete_comment_reply",
      args: { presentationId: "deck1", commentId: "c1", postId: "p2" },
      replies: saved({ replies: [{}], writeControl: { requiredRevisionId: "rev-3" } }),
    },
    {
      tool: "batch_update_presentation",
      args: {
        presentationId: "deck1",
        requiredRevisionId: "rev-2",
        requests: [
          { insertText: { objectId: "title", text: "Hello", insertionIndex: 0 } },
          { createShape: { shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "p" } } },
        ],
      },
      replies: [
        {
          body: {
            presentationId: "deck1",
            replies: [{}, { createShape: { objectId: "box2" } }],
            writeControl: { requiredRevisionId: "rev-3" },
          },
        },
      ],
    },
  ],
  unsent: ["privateKey"],
  // Google redacts a vendor message whole before cutting it to 500 characters.
  errorEcho: "all",
  echo: {
    tool: "get_presentation",
    args: { presentationId: "deck1" },
    replies: (text) => [{ body: { ...PRESENTATION, title: text } }],
  },
  failures: {
    read: { tool: "slides_api_read", args: { path: "/presentations/deck1" } },
    write: {
      tool: "slides_api_write",
      args: {
        method: "POST",
        path: "/presentations/deck1:batchUpdate",
        body: { requests: [{ createSlide: { objectId: "newslide" } }], writeControl: { requiredRevisionId: "rev-1" } },
      },
    },
  },
});
