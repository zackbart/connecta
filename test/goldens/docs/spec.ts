import { docs } from "../../../src/providers/docs/index.js";
import { defineGoldenSpec } from "../harness.js";

const keys = (await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
const ACCESS_TOKEN = "golden-docs-access-token-123456";

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
    paragraph: { elements: pieces, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, ...extra },
  };
}

const DOCUMENT = {
  documentId: "doc-1",
  title: "Elders meeting",
  revisionId: "rev-1",
  suggestionsViewMode: "SUGGESTIONS_INLINE",
  tabs: [
    {
      tabProperties: { tabId: "t.0", title: "Notes", index: 0 },
      documentTab: {
        body: {
          content: [
            { endIndex: 1, sectionBreak: { sectionStyle: {} } },
            {
              startIndex: 1,
              endIndex: 16,
              paragraph: { elements: [run("Elders meeting\n", 1)], paragraphStyle: { namedStyleType: "TITLE" } },
            },
            paragraph(16, [run("See the ", 16), run("plan", 24, "https://example.org/plan"), run(" now.\n", 28)]),
            paragraph(34, [run("Budget\n", 34)], { bullet: { listId: "kix.ol", nestingLevel: 0 } }),
          ],
        },
        lists: { "kix.ol": { listProperties: { nestingLevels: [{ glyphType: "DECIMAL" }] } } },
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

export default defineGoldenSpec({
  provider: "docs",
  // Delegated tokens are cached per service account for the process, so each
  // scenario names its own account and mints its own token.
  create: (scenario) =>
    docs("docs", {
      purpose: "Staff meeting notes",
      serviceAccount: {
        clientEmail: `docs-${scenario}@project.iam.gserviceaccount.com`,
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
    { tool: "get_document", args: { documentId: "doc-1" }, replies: [{ body: DOCUMENT }] },
    {
      label: "get_document withIndexes",
      tool: "get_document",
      args: { documentId: "doc-1", tabId: "t.0", withIndexes: true },
      replies: [{ body: DOCUMENT }],
    },
    {
      tool: "create_document",
      args: { title: "Minutes" },
      replies: [{ body: { documentId: "new-1", title: "Minutes", revisionId: "r0", body: {} } }],
    },
    {
      label: "create_document with text",
      tool: "create_document",
      args: { title: "Minutes", text: "Opened in prayer.\nQuorum present." },
      replies: [
        { body: { documentId: "new-1", title: "Minutes", revisionId: "r0" } },
        { body: { documentId: "new-1", replies: [{}], writeControl: { requiredRevisionId: "r1" } } },
      ],
    },
    {
      tool: "append_text",
      args: { documentId: "doc-1", text: "\nAction items follow.", tabId: "t.child", requiredRevisionId: "rev-1" },
      replies: [{ body: { documentId: "doc-1", replies: [{}], writeControl: { requiredRevisionId: "rev-2" } } }],
    },
    {
      tool: "insert_text",
      args: { documentId: "doc-1", index: 23, text: "Note: " },
      replies: [{ body: { documentId: "doc-1", replies: [{}] } }],
    },
    {
      tool: "replace_all_text",
      args: {
        documentId: "doc-1",
        find: "\\bQ(\\d)\\b",
        replaceWith: "Quarter",
        matchCase: true,
        regex: true,
        tabIds: ["t.0"],
      },
      replies: [
        {
          body: {
            documentId: "doc-1",
            replies: [{ replaceAllText: { occurrencesChanged: 3 } }],
            writeControl: { requiredRevisionId: "rev-9" },
          },
        },
      ],
    },
    {
      tool: "batch_update_document",
      args: {
        documentId: "doc-1",
        requiredRevisionId: "rev-2",
        requests: [
          { deleteContentRange: { range: { startIndex: 5, endIndex: 9 } } },
          { createNamedRange: { name: "agenda", range: { startIndex: 1, endIndex: 4 } } },
        ],
      },
      replies: [
        {
          body: {
            documentId: "doc-1",
            replies: [{}, { createNamedRange: { namedRangeId: "kix.nr1" } }],
            writeControl: { requiredRevisionId: "rev-3" },
          },
        },
      ],
    },
  ],
  unsent: ["privateKey"],
  echo: {
    tool: "get_document",
    args: { documentId: "doc-1" },
    replies: (text) => [{ body: { ...DOCUMENT, title: text } }],
  },
  failures: {
    read: { tool: "get_document", args: { documentId: "doc-1" } },
    write: {
      tool: "append_text",
      args: { documentId: "doc-1", text: "\nAction items follow.", requiredRevisionId: "rev-1" },
    },
  },
});
