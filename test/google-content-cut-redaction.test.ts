// Workspace products cut what Google returns — a body to maxBodyChars, a
// header or title to a byte budget, a page of text from an offset — and every
// secret the request sent is replaced before each cut. A cut through an echo
// leaves a fragment that no registered form matches, which no later
// redaction can find. SECRET is the delegated token each call sends.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { forms } from "../src/providers/forms/index.js";
import { gmail } from "../src/providers/gmail/index.js";
import { requestSentSecrets } from "../src/sent-secrets.js";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { sheets } from "../src/providers/sheets/index.js";
import { slides } from "../src/providers/slides/index.js";
import { caller, stubGoogle, workspaceOptions } from "./helpers/google-echo.js";
import {
  SECRET,
  echoForms,
  expectNoFragment,
  head,
  leaks,
  straddling,
  straddlingJson,
} from "./helpers/secret-echoes.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What a call returned, read as a record. */
async function read(call: unknown): Promise<any> {
  return await Promise.resolve(call);
}

describe("Gmail", () => {
  function message(subject: string, body: string, parts: unknown[] = []) {
    return {
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      internalDate: "1767322800000",
      snippet: "hello",
      payload: {
        mimeType: parts.length > 0 ? "multipart/mixed" : "text/plain",
        headers: [
          { name: "Subject", value: subject },
          { name: "From", value: "bob@example.com" },
        ],
        body: parts.length > 0 ? { size: 0 } : { size: body.length, data: base64url(body) },
        parts:
          parts.length > 0
            ? [
                {
                  partId: "0",
                  mimeType: "text/plain",
                  headers: [],
                  body: { size: body.length, data: base64url(body) },
                },
                ...parts,
              ]
            : undefined,
      },
    };
  }

  it.each(echoForms(SECRET))(
    "INV-5: a message body echoing the sent token %s across maxBodyChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => message("Subject", straddling(form, 500)));
      const connector = gmail("mail", await workspaceOptions());
      const result = await read(connector.callTool("get_message", { messageId: "m1", maxBodyChars: 500 }, caller()));
      expectNoFragment(result.body, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a Subject header echoing the sent token %s across its 4 KiB cut leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => message(straddlingJson(form, 4 * 1024), "body"));
      const connector = gmail("mail", await workspaceOptions());
      const result = await read(connector.callTool("get_message", { messageId: "m1" }, caller()));
      expectNoFragment(result.subject, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a text attachment echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      const content = straddling(form, 500);
      stubGoogle(() =>
        message("Subject", "body", [
          {
            partId: "1",
            mimeType: "text/plain",
            filename: "notes.txt",
            headers: [],
            body: { size: new TextEncoder().encode(content).length, data: base64url(content) },
          },
        ]),
      );
      const connector = gmail("mail", await workspaceOptions());
      const result = await read(
        connector.callTool("get_attachment", { messageId: "m1", partId: "1", maxChars: 500 }, caller()),
      );
      expectNoFragment(result.content, form);
    },
  );
});

describe("Drive", () => {
  it.each([["raw", SECRET]])(
    "INV-5: a file name echoing the sent token %s across its 32 KiB cut leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => ({ id: "f1", name: straddlingJson(form, 32 * 1024), mimeType: "text/plain" }));
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file", { fileId: "f1" }, caller()));
      expectNoFragment(result.name, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: an exported Google Doc echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle((url) =>
        url.pathname.endsWith("/export")
          ? new Response(straddling(form, 500), { headers: { "content-type": "text/markdown" } })
          : { id: "f1", name: "Notes", mimeType: "application/vnd.google-apps.document" },
      );
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file_content", { fileId: "f1", maxChars: 500 }, caller()));
      // The binary-body boundary withholds the whole content before text
      // decoding; still prove the cut cannot expose any credential fragment.
      expect(String(result.content)).toMatch(/^\[redacted\](?:\n|$)/);
      expect(leaks(String(result.content), form)).toBe(false);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a downloaded text file echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      const content = `${straddling(form, 500)}${"y".repeat(5_000)}`;
      stubGoogle((url) =>
        url.searchParams.get("alt") === "media"
          ? new Response(content, { headers: { "content-type": "text/plain" } })
          : { id: "f1", name: "notes.txt", mimeType: "text/plain", size: String(content.length) },
      );
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file_content", { fileId: "f1", maxChars: 500 }, caller()));
      // The binary-body boundary withholds the whole content before text
      // decoding; still prove the cut cannot expose any credential fragment.
      expect(String(result.content)).toMatch(/^\[redacted\](?:\n|$)/);
      expect(leaks(String(result.content), form)).toBe(false);
    },
  );
});

describe("Drive bounded reads", () => {
  // A text read keeps 4·maxChars + 4 bytes. A form that begins in the shown
  // characters and ends past the read never arrives whole.
  it.each([["raw", SECRET]])(
    "INV-5: a download that stops inside the sent token %s shows no fragment of it",
    async (_name, form) => {
      const escaped = form.startsWith("\\u");
      // Shown units of the form: eight decoded characters.
      const shown = escaped ? 48 : 8;
      const maxChars = Math.floor((form.length - 4 - shown - 1) / 3);
      const content = `${"x".repeat(maxChars - shown)}${form}${"y".repeat(1_000)}`;
      expect(maxChars - shown + form.length).toBeGreaterThan(4 * maxChars + 4);
      stubGoogle((url) =>
        url.searchParams.get("alt") === "media"
          ? new Response(content, { headers: { "content-type": "text/plain" } })
          : { id: "f1", name: "notes.txt", mimeType: "text/plain", size: String(content.length) },
      );
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file_content", { fileId: "f1", maxChars }, caller()));
      expect(result.content).toContain("x");
      expect(result.content).not.toContain(form.slice(0, shown));
    },
  );
});

describe("Docs", () => {
  /** A document of one paragraph, without tabs. */
  function document(title: string, paragraph: string) {
    const end = paragraph.length + 2;
    return {
      documentId: "d1",
      title,
      revisionId: "r1",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: end,
            paragraph: {
              elements: [{ startIndex: 1, endIndex: end, textRun: { content: `${paragraph}\n` } }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          },
        ],
      },
    };
  }

  it.each([["raw", SECRET]])(
    "INV-5: document text echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => document("Plan", straddling(form, 500)));
      const connector = docs("documents", await workspaceOptions());
      const result = await read(connector.callTool("get_document", { documentId: "d1", maxChars: 500 }, caller()));
      expectNoFragment(result.tabs[0].text, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a title echoing the sent token %s across its 4 KiB cut leaks no fragment of it",
    async (_name, form) => {
      const marker = (dropped: number) => `… [${dropped} more characters]`;
      stubGoogle(() => document(straddlingJson(form, 4 * 1024, marker), "Body"));
      const connector = docs("documents", await workspaceOptions());
      const result = await read(connector.callTool("get_document", { documentId: "d1" }, caller()));
      expectNoFragment(result.title, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: an index row's preview echoing the sent token %s across its 80-character cut leaks no fragment of it",
    async (_name, form) => {
      const kept = Math.min(head(form).length, 60);
      stubGoogle(() => document("Plan", straddling(form, 80, kept)));
      const connector = docs("documents", await workspaceOptions());
      const result = await read(connector.callTool("get_document", { documentId: "d1", withIndexes: true }, caller()));
      expectNoFragment(result.tabs[0].elements[0].text, form, { kept });
    },
  );
});

describe("Sheets", () => {
  let restoreTransport: ReturnType<typeof configureGuardedTransport>;
  beforeEach(() => {
    restoreTransport = configureGuardedTransport({ send: (url, init) => globalThis.fetch(url, init) });
  });
  afterEach(() => {
    configureGuardedTransport(restoreTransport);
  });

  const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

  it.each([["raw", SECRET]])(
    "INV-5: a cell echoing the sent token %s across maxCellChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => ({
        spreadsheetId: ID,
        valueRanges: [{ range: "Sheet1!A1:A1", majorDimension: "ROWS", values: [[straddling(form, 500)]] }],
      }));
      const connector = sheets("sheets", await workspaceOptions());
      const result = await read(
        connector.callTool("get_values", { spreadsheetId: ID, ranges: ["Sheet1!A1"], maxCellChars: 500 }, caller()),
      );
      expectNoFragment(result.valueRanges[0].values[0][0], form);
      // A private argument submitted earlier in this request may equal a
      // public Sheets wire key. Keep the rows for projection; their cell
      // values stay redacted, and the final boundary still protects keys
      // that match the private value, exactly as the legacy result did.
      for (const privateValue of ["values", "range", "sheets", "properties"]) {
        const ctx = caller();
        requestSentSecrets(ctx).arguments(
          { private: privateValue },
          { type: "object", properties: { private: { type: "string", writeOnly: true } } },
        );
        stubGoogle(() => ({
          spreadsheetId: ID,
          properties: { title: "Budget" },
          sheets: [{ properties: { sheetId: 2, title: "Summary" } }],
          valueRanges: [{ range: "Sheet1!A1:A2", values: [["kept"], [privateValue]] }],
        }));
        const projected = await read(
          connector.callTool(
            privateValue === "values" || privateValue === "range" ? "get_values" : "get_spreadsheet",
            privateValue === "values" || privateValue === "range"
              ? { spreadsheetId: ID, ranges: ["Sheet1!A1:A2"] }
              : { spreadsheetId: ID },
            ctx,
          ),
        );
        if (privateValue === "values" || privateValue === "range") {
          expect(projected.valueRanges[0][privateValue === "values" ? "[redacted]" : "values"]).toEqual([
            ["kept"],
            ["[redacted]"],
          ]);
          expect(projected.cellCount).toBe(2);
        } else {
          expect(projected.title).toBe("Budget");
          expect(projected[privateValue === "sheets" ? "[redacted]" : "sheets"][0]).toMatchObject({
            sheetId: 2,
            title: "Summary",
          });
        }
      }
      // Error-envelope keys feed classification before the final boundary.
      // Private key collisions must keep rate-limit, precondition and scope advice.
      for (const row of [
        ...["reason", "errors", "error"].map((privateValue) => ({
          privateValue,
          error: { code: 403, message: "Quota exceeded", errors: [{ reason: "userRateLimitExceeded" }] },
          expected: {
            code: "rate_limited",
            retryable: true,
            message: expect.stringContaining("Google meters this API"),
          },
        })),
        {
          privateValue: "status",
          error: { code: 400, message: "Precondition", status: "FAILED_PRECONDITION" },
          expected: { code: "connector_call_failed", message: expect.stringContaining("precondition") },
        },
        {
          privateValue: "reason",
          error: { code: 403, message: "Scope refused", errors: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
          expected: {
            code: "provider_permission_denied",
            message: expect.stringContaining("lacks a scope this call needs"),
          },
        },
      ]) {
        const ctx = caller();
        requestSentSecrets(ctx).arguments(
          { private: row.privateValue },
          { type: "object", properties: { private: { type: "string", writeOnly: true } } },
        );
        stubGoogle(() => Response.json({ error: row.error }, { status: row.error.code }));
        await expect(
          connector.callTool("get_values", { spreadsheetId: ID, ranges: ["Sheet1!A1"] }, ctx),
        ).rejects.toMatchObject(row.expected);
      }
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a summarized reply echoing the sent token %s across its 256-byte cut leaks no fragment of it",
    async (_name, form) => {
      const marker = (dropped: number) => `[… ${dropped} more characters]`;
      stubGoogle(() => ({
        spreadsheetId: ID,
        // Too large to return whole, so every reply after it is summarized.
        replies: [
          { addSheet: { properties: { sheetId: 1, title: "y".repeat(200_000) } } },
          { addSheet: { properties: { sheetId: 2, title: straddlingJson(form, 256, marker) } } },
        ],
      }));
      const connector = sheets("sheets", await workspaceOptions());
      const result = await read(
        connector.callTool(
          "batch_update_spreadsheet",
          { spreadsheetId: ID, requests: [{ addSheet: {} }, { addSheet: {} }] },
          caller(),
        ),
      );
      expectNoFragment(result.replies[1].properties.title, form);
    },
  );
});

describe("Forms", () => {
  function form(title: string) {
    return {
      formId: "form1",
      revisionId: "r1",
      info: { title, documentTitle: "Survey" },
      items: [{ itemId: "i1", title: "Feedback", questionItem: { question: { questionId: "q1", textQuestion: {} } } }],
    };
  }

  it.each([["raw", SECRET]])(
    "INV-5: a form title echoing the sent token %s across its 2,000-character cut leaks no fragment of it",
    async (_name, echo) => {
      stubGoogle(() => form(straddling(echo, 2_000)));
      const connector = forms("forms", await workspaceOptions());
      const result = await read(connector.callTool("get_form", { formId: "form1" }, caller()));
      expectNoFragment(result.title, echo);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: an answer echoing the sent token %s across its 2,000-character cut leaks no fragment of it",
    async (_name, echo) => {
      stubGoogle((url) =>
        url.pathname.endsWith("/responses")
          ? {
              responses: [
                {
                  responseId: "resp1",
                  answers: { q1: { questionId: "q1", textAnswers: { answers: [{ value: straddling(echo, 2_000) }] } } },
                },
              ],
            }
          : form("Survey"),
      );
      const connector = forms("forms", await workspaceOptions());
      const result = await read(connector.callTool("list_responses", { formId: "form1" }, caller()));
      expectNoFragment(result.responses[0].answers[0].values[0], echo);
    },
  );
});

describe("Slides", () => {
  /** A one-slide deck whose slide holds one text box. */
  function deck(title: string, text: string) {
    const slide = {
      objectId: "s1",
      slideProperties: { layoutObjectId: "L1", notesPage: { objectId: "s1_notes" } },
      pageElements: [
        {
          objectId: "box",
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" },
          shape: { shapeType: "TEXT_BOX", text: { textElements: [{ textRun: { content: text } }] } },
        },
      ],
    };
    return {
      presentation: {
        presentationId: "deck1",
        title,
        revisionId: "rev-1",
        layouts: [{ objectId: "L1", layoutProperties: { name: "BLANK", displayName: "Blank" } }],
        slides: [slide],
      },
      page: { ...slide, pageType: "SLIDE", revisionId: "rev-1" },
    };
  }

  /** No start of the form, nor its end, nor the secret it encodes, in what the pages show. */
  function expectNoPiece(text: string, form: string): void {
    expect(text).not.toContain(form.slice(0, 12));
    expect(text).not.toContain(form.slice(-12));
    expect(leaks(text)).toBe(false);
  }

  it.each([["raw", SECRET]])(
    "INV-5: slide text echoing the sent token %s across maxCharsPerSlide, and its continuation, leak no fragment of it",
    async (_name, form) => {
      const { presentation, page } = deck("Plan", straddling(form, 500));
      stubGoogle((url) => (url.pathname.includes("/pages/") ? page : presentation));
      const connector = slides("decks", await workspaceOptions());
      const result = await read(
        connector.callTool("get_presentation", { presentationId: "deck1", maxCharsPerSlide: 500 }, caller()),
      );
      const element = result.slides[0].elements[0];
      expectNoFragment(element.text, form);
      if (element.textCursor) {
        const next = await read(
          connector.callTool(
            "get_page",
            { presentationId: "deck1", pageObjectId: "s1", cursor: element.textCursor },
            caller(),
          ),
        );
        expect(next.elements[0].text).not.toContain(`${form.slice(head(form).length)} tail`);
      }
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a deck title echoing the sent token %s across its 4 KiB cut leaks no fragment of it",
    async (_name, form) => {
      const marker = (dropped: number) => `[… ${dropped} more characters; Drive shows the whole title]`;
      const { presentation } = deck(straddlingJson(form, 4 * 1024, marker), "Body");
      stubGoogle(() => presentation);
      const connector = slides("decks", await workspaceOptions());
      const result = await read(connector.callTool("get_presentation", { presentationId: "deck1" }, caller()));
      expectNoFragment(result.title, form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a page's text echoing the sent token %s, paged past one result, leaks no fragment across pages",
    async (_name, form) => {
      const { page } = deck("Plan", form.repeat(Math.ceil(400_000 / form.length)));
      stubGoogle(() => page);
      const connector = slides("decks", await workspaceOptions());
      const args = { presentationId: "deck1", pageObjectId: "s1" };
      const first = await read(connector.callTool("get_page", args, caller()));
      let shown = first.elements.map((element: { text?: string }) => element.text ?? "").join("");
      if (first.page.nextCursor) {
        const second = await read(connector.callTool("get_page", { ...args, cursor: first.page.nextCursor }, caller()));
        shown += second.elements.map((element: { text?: string }) => element.text ?? "").join("");
      }
      expectNoPiece(shown.replace(/\n\[… \d+ more characters continue on the next page\]/g, ""), form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a comment echoing the sent token %s, paged past one result, leaks no fragment across pages",
    async (_name, form) => {
      stubGoogle(() => ({
        presentationId: "deck1",
        revisionId: "rev-1",
        commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
        comments: [
          { commentId: "c1", headPost: { postId: "p1", content: form.repeat(Math.ceil(400_000 / form.length)) } },
        ],
        slides: [],
      }));
      const connector = slides("decks", await workspaceOptions());
      const shown: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 4; pages++) {
        const args = { presentationId: "deck1", ...(cursor ? { cursor } : {}) };
        const result = await read(connector.callTool("list_comments", args, caller()));
        for (const thread of result.threads as { headPost?: { content?: string } }[])
          shown.push(thread.headPost?.content ?? "");
        cursor = result.page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expectNoPiece(shown.join("").replace(/\n\[… \d+ more characters continue on the next page\]/g, ""), form);
    },
  );

  it.each([["raw", SECRET]])(
    "INV-5: a raw page element echoing the sent token %s, chunked past one result, leaks no fragment across chunks",
    async (_name, form) => {
      const { page } = deck("Plan", form.repeat(Math.ceil(400_000 / form.length)));
      stubGoogle(() => page);
      const connector = slides("decks", await workspaceOptions());
      const args = { presentationId: "deck1", pageObjectId: "s1", raw: true };
      const chunks: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 8; pages++) {
        const result = await read(connector.callTool("get_page", cursor ? { ...args, cursor } : args, caller()));
        for (const element of result.elements as { rawJson?: { json: string } }[])
          chunks.push(element.rawJson?.json ?? "");
        cursor = result.page.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expectNoPiece(chunks.join(""), form);
    },
  );
});
