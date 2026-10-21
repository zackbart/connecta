// Workspace products cut what Google returns — a body to maxBodyChars, a
// header or title to a byte budget, a page of text from an offset — and every
// secret the request sent is replaced before each cut. A cut through an echo
// leaves a fragment that no registered form matches, which no later
// redaction can find. SECRET is the delegated token each call sends.
import { afterEach, describe, expect, it, vi } from "vitest";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { forms } from "../src/providers/forms/index.js";
import { gmail } from "../src/providers/gmail/index.js";
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

// Which echo forms the redactor recognizes is test/sent-secret-output-boundary.test.ts;
// here one plain and one JSON-escaped form show each cut site redacts before it cuts.
const FORMS = echoForms(SECRET).filter(([name]) => name === "raw" || name === "\\u-escaped (lower hex)");

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

  it.each(FORMS)(
    "INV-5: a message body echoing the sent token %s across maxBodyChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => message("Subject", straddling(form, 500)));
      const connector = gmail("mail", await workspaceOptions());
      const result = await read(connector.callTool("get_message", { messageId: "m1", maxBodyChars: 500 }, caller()));
      expectNoFragment(result.body, form);
    },
  );

  it.each(FORMS)(
    "INV-5: a Subject header echoing the sent token %s across its 4 KiB cut leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => message(straddlingJson(form, 4 * 1024), "body"));
      const connector = gmail("mail", await workspaceOptions());
      const result = await read(connector.callTool("get_message", { messageId: "m1" }, caller()));
      expectNoFragment(result.subject, form);
    },
  );
});

describe("Drive", () => {
  it.each(FORMS)(
    "INV-5: a file name echoing the sent token %s across its 32 KiB cut leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => ({ id: "f1", name: straddlingJson(form, 32 * 1024), mimeType: "text/plain" }));
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file", { fileId: "f1" }, caller()));
      expectNoFragment(result.name, form);
    },
  );

  it.each(FORMS)(
    "INV-5: an exported Google Doc echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle((url) =>
        url.pathname.endsWith("/export")
          ? new Response(straddling(form, 500), { headers: { "content-type": "text/markdown" } })
          : { id: "f1", name: "Notes", mimeType: "application/vnd.google-apps.document" },
      );
      const connector = drive("files", await workspaceOptions());
      const result = await read(connector.callTool("get_file_content", { fileId: "f1", maxChars: 500 }, caller()));
      expectNoFragment(result.content, form);
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

  it.each(FORMS)(
    "INV-5: document text echoing the sent token %s across maxChars leaks no fragment of it",
    async (_name, form) => {
      stubGoogle(() => document("Plan", straddling(form, 500)));
      const connector = docs("documents", await workspaceOptions());
      const result = await read(connector.callTool("get_document", { documentId: "d1", maxChars: 500 }, caller()));
      expectNoFragment(result.tabs[0].text, form);
    },
  );

  it.each(FORMS)(
    "INV-5: a title echoing the sent token %s across its 4 KiB cut leaks no fragment of it",
    async (_name, form) => {
      const marker = (dropped: number) => `… [${dropped} more characters]`;
      stubGoogle(() => document(straddlingJson(form, 4 * 1024, marker), "Body"));
      const connector = docs("documents", await workspaceOptions());
      const result = await read(connector.callTool("get_document", { documentId: "d1" }, caller()));
      expectNoFragment(result.title, form);
    },
  );
});

describe("Sheets", () => {
  const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

  it.each(FORMS)(
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

  it.each(FORMS)(
    "INV-5: a form title echoing the sent token %s across its 2,000-character cut leaks no fragment of it",
    async (_name, echo) => {
      stubGoogle(() => form(straddling(echo, 2_000)));
      const connector = forms("forms", await workspaceOptions());
      const result = await read(connector.callTool("get_form", { formId: "form1" }, caller()));
      expectNoFragment(result.title, echo);
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

  it.each(FORMS)(
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

  it.each(FORMS)(
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
