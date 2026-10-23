// Security-review regressions for original-span matching, all derived copies,
// normalization/extraction, tiny tails, and cross-request paging stability.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureGuardedTransport } from "../src/guarded-transport.js";
import { breeze } from "../src/providers/breeze/index.js";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { gmail } from "../src/providers/gmail/index.js";
import { notion } from "../src/providers/notion/index.js";
import { slides } from "../src/providers/slides/index.js";
import { redactBoundedRead, requestSentSecrets, SentSecrets } from "../src/sent-secrets.js";
import type { ConnectorContext } from "../src/types.js";
import { caller, stubGoogle, workspaceOptions } from "./helpers/google-echo.js";
import { echoForms, leaks, SECRET } from "./helpers/secret-echoes.js";
import { connectorContext } from "./fixtures/misc.js";

const MARKER = "[redacted]";
const privateSchema = { type: "object", properties: { private: { type: "string", writeOnly: true } } };

function privateContext(value?: string): ConnectorContext {
  const ctx = caller();
  ctx.requestScope = {};
  if (value !== undefined) requestSentSecrets(ctx).arguments({ private: value }, privateSchema);
  return ctx;
}

function keyed(value = SECRET): ConnectorContext {
  return { ...connectorContext(), credential: { get: async () => value, getAll: async () => ({ value }) } };
}

function download(content: string): void {
  stubGoogle((url) =>
    url.searchParams.get("alt") === "media"
      ? new Response(content, { headers: { "content-type": "text/plain" } })
      : { id: "f1", name: "notes.txt", mimeType: "text/plain", size: String(new TextEncoder().encode(content).length) },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded reads match original spans", () => {
  it("INV-5: a complete credential cannot hide the unfinished private value containing it in Drive", async () => {
    const privateValue = `private-begin-value/${SECRET}/${"private-end-value/".repeat(20)}`;
    download(privateValue);
    const connector = drive("files", await workspaceOptions());
    const result: any = await connector.callTool(
      "get_file_content",
      { fileId: "f1", maxChars: 30 },
      privateContext(privateValue),
    );
    expect(result.content).toContain(MARKER);
    expect(result.content).not.toContain("private-begin");
    expect(leaks(JSON.stringify(result), privateValue)).toBe(false);
  });

  it("INV-5: an aligned Basic username cannot hide an unfinished encoded credential pair", () => {
    const username = "aligneduserx"; // Twelve bytes: its unpadded encoding is a prefix of the pair's.
    const password = "supersecret-credential-value-0123456789";
    const pair = btoa(`${username}:${password}`);
    const prefix = pair.slice(0, -8);
    // Decode the surviving suffix independently: this is the review's leaking alignment.
    expect(atob(prefix.slice(btoa(username).length))).toContain(":supersecret-credential-value");
    const ctx = privateContext();
    requestSentSecrets(ctx).header(`Basic ${pair}`);
    const result = redactBoundedRead(ctx, `intro ${prefix}`);
    expect(result).toBe(`intro ${MARKER}`);
    expect(leaks(result, password)).toBe(false);
  });

  it.each(echoForms(`prefix/${SECRET}/${"suffix".repeat(40)}`))(
    "INV-5: overlapping complete and unfinished matches replace original %s spans once",
    (_name, form) => {
      const ctx = privateContext(`prefix/${SECRET}/${"suffix".repeat(40)}`);
      requestSentSecrets(ctx).add(SECRET);
      const result = redactBoundedRead(ctx, `intro ${form.slice(0, Math.floor(form.length / 2))}`);
      expect(result).toBe(`intro ${MARKER}`);
      expect(leaks(result, "prefix/" + SECRET)).toBe(false);
    },
  );
});

describe("every Notion representation", () => {
  beforeEach(() => {
    configureGuardedTransport({ send: async (url, init) => globalThis.fetch(url, init) });
  });
  afterEach(() => {
    configureGuardedTransport(undefined);
  });

  it.each(echoForms(SECRET))(
    "INV-5: truncated %s text is safe in titles, selected properties, search, query, and raw branches",
    async (_name, form) => {
      const prefix = form.slice(0, Math.ceil(form.length / 2));
      const text = `intro ${prefix}`;
      const page = {
        object: "page",
        id: "p1",
        properties: {
          Name: {
            id: "title",
            type: "title",
            has_more: true,
            title: [
              { type: "text", plain_text: text.slice(0, 8), text: { content: text.slice(0, 8) } },
              { type: "text", plain_text: text.slice(8), text: { content: text.slice(8) } },
            ],
          },
          Notes: {
            id: "notes",
            type: "rich_text",
            has_more: true,
            rich_text: [{ type: "text", plain_text: text, text: { content: text } }],
          },
        },
      };
      vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        return Response.json(
          path.endsWith("/search") || path.endsWith("/query")
            ? { object: "list", results: [page], has_more: false, next_cursor: null }
            : page,
        );
      });
      const connector = notion("notes", { auth: { type: "token" }, purpose: "Team notes" });
      for (const raw of [false, true]) {
        for (const [tool, args] of [
          ["integration_get_page", { page_id: "p1" }],
          ["integration_get_page", { page_id: "p1", properties: ["Notes"] }],
          ["integration_search", {}],
          ["integration_query_data_source", { data_source_id: "ds1" }],
          ["notion_api_read", { path: "/v1/pages/p1" }],
        ] as const) {
          const result: any = await connector.callTool(
            tool,
            { ...args, ...(tool === "notion_api_read" ? {} : { raw }) },
            keyed(),
          );
          const shown = JSON.stringify(result);
          expect(shown).not.toContain(prefix);
          expect(leaks(shown)).toBe(false);
          expect(shown).toContain(MARKER);
        }
      }
    },
  );
});

describe("redact before normalization or extraction", () => {
  it("INV-5: Breeze redacts a private amount before decimal parsing can shorten its representation", async () => {
    const value = "12345.6700";
    vi.stubGlobal("fetch", async () => Response.json([{ id: "1", amount: value }]));
    const connector = breeze("giving", { subdomain: "example", purpose: "Giving records" });
    const result: any = await connector.callTool(
      "list_contributions",
      { start: "2026-01-01", end: "2026-01-31" },
      {
        ...privateContext(value),
        credential: keyed().credential!,
      },
    );
    expect(result.totalAmount).toBeNull();
    expect(result.contributions[0].amount).toBe(MARKER);
    expect(JSON.stringify(result)).not.toContain("12345.67");
  });

  it("INV-5: Gmail does not extract a private charset fragment into its fallback notice", async () => {
    const value = "   private-charset-source-0123456789";
    stubGoogle(() => ({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Content-Type", value: `text/plain; charset="${value}"` }],
        body: { data: btoa("hello") },
      },
    }));
    const connector = gmail("mail", await workspaceOptions());
    const result: any = await connector.callTool("get_message", { messageId: "m1" }, privateContext(value));
    expect(result.body).toBe("hello");
    expect(result.bodyNote).toContain(MARKER);
    expect(leaks(JSON.stringify(result), value.trim())).toBe(false);
  });

  it("INV-5: Slides redacts joined shape and table sources before trimming or flattening whitespace", async () => {
    const value = "private-slide\tcontent\nsensitive-value\n";
    const text = {
      textElements: [{ textRun: { content: value.slice(0, 10) } }, { textRun: { content: value.slice(10) } }],
    };
    stubGoogle(() => ({
      objectId: "s1",
      revisionId: "rev-1",
      pageElements: [
        { objectId: "shape", shape: { text } },
        { objectId: "table", table: { tableRows: [{ tableCells: [{ text }] }] } },
      ],
    }));
    const connector = slides("decks", await workspaceOptions());
    const result: any = await connector.callTool(
      "get_page",
      { presentationId: "deck1", pageObjectId: "s1" },
      privateContext(value),
    );
    expect(result.elements.map((element: any) => element.text)).toEqual([MARKER, MARKER]);
    expect(leaks(JSON.stringify(result), value)).toBe(false);
  });

  it("INV-5: a Google 400 cannot trim the beginning off a private value before its 500-character cap", async () => {
    const privateValue = `   ${"private-with-leading-space/".repeat(40)}`;
    stubGoogle(() => Response.json({ error: { message: privateValue } }, { status: 400 }));
    const connector = gmail("mail", await workspaceOptions());
    const error: any = await connector
      .callTool("list_labels", {}, privateContext(privateValue))
      .catch((error: unknown) => error);
    expect(error.message).toContain(MARKER);
    expect(error.message).not.toContain("private-with-leading-space");
    expect(leaks(error.message, privateValue.trim())).toBe(false);
  });

  it.each(["2026-01-02secret-value-123456789", "public-date-prefix 2026-01-02secret-value-123456789"])(
    "INV-5: Breeze returns only the marker if the date extraction source contains %s",
    async (paidOn) => {
      const secret = "2026-01-02secret-value-123456789";
      vi.stubGlobal("fetch", async () => Response.json([{ id: "1", amount: "5.00", paid_on: paidOn }]));
      const connector = breeze("giving", { subdomain: "example", purpose: "Giving records" });
      const result: any = await connector.callTool(
        "list_contributions",
        { start: "2026-01-01", end: "2026-01-31" },
        keyed(secret),
      );
      expect(result.contributions[0].paidOn).toBe(MARKER);
      expect(JSON.stringify(result)).not.toContain("2026-01-02");
      expect(leaks(JSON.stringify(result), secret)).toBe(false);
    },
  );

  it("INV-5: Docs normalizes a private paragraph only after redacting its original whitespace", async () => {
    const value = `   private   paragraph ${"sensitive ".repeat(30)}\n`;
    stubGoogle(() => ({
      documentId: "d1",
      title: "Plan",
      body: {
        content: [
          {
            startIndex: 1,
            endIndex: value.length + 1,
            paragraph: {
              elements: [{ textRun: { content: value } }],
              paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
            },
          },
        ],
      },
    }));
    const connector = docs("docs", await workspaceOptions());
    const result: any = await connector.callTool(
      "get_document",
      { documentId: "d1", withIndexes: true },
      privateContext(value),
    );
    expect(result.tabs[0].text).toContain(MARKER);
    expect(result.tabs[0].elements[0].text).toBe(MARKER);
    expect(leaks(JSON.stringify(result), value.trim())).toBe(false);
  });

  it("INV-5: Gmail strips HTML only after redacting a private source value", async () => {
    const value = `<b>private-html-${"sensitive".repeat(15)}</b>`;
    stubGoogle(() => ({
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "text/html",
        headers: [],
        body: { data: btoa(value) },
      },
    }));
    const connector = gmail("mail", await workspaceOptions());
    const result: any = await connector.callTool("get_message", { messageId: "m1" }, privateContext(value));
    expect(result.body).toBe(MARKER);
    expect(leaks(JSON.stringify(result), value.slice(3))).toBe(false);
  });
});

describe("tiny tails", () => {
  it.each(echoForms("🌈private/value+with=all-forms"))(
    "INV-5: every nonempty bounded-read prefix of %s is withheld, including partial escapes",
    (_name, form) => {
      const secrets = new SentSecrets();
      secrets.arguments({ private: "🌈private/value+with=all-forms" }, privateSchema);
      for (let end = 1; end < form.length; end++) {
        const output = secrets.redactOpenTail(`intro ${form.slice(0, end)}`);
        expect(output, `cut at ${end}`).toBe(`intro ${MARKER}`);
      }
    },
  );

  it("INV-5: Drive maxChars one cannot reveal even the first emoji of a private value", async () => {
    const value = "🌈🌈🌈private-emoji-value";
    download(value.repeat(10));
    const connector = drive("files", await workspaceOptions());
    const result: any = await connector.callTool(
      "get_file_content",
      { fileId: "f1", maxChars: 1 },
      privateContext(value),
    );
    expect(result.content).not.toContain("🌈");
    expect(result.content).toMatch(/^\[/);
  });
});

describe("Slides representation-bound cursors", () => {
  const privateValue = "secret-for-paging-0123456789";
  const content = `${privateValue.repeat(20)}${Array.from({ length: 30_000 }, (_, i) => `[${String(i).padStart(5, "0")}]`).join("")}`;

  it.each([false, true])(
    "INV-5: projected and raw continuations reject changed secret sets (first secret: %s)",
    async (firstHasSecret) => {
      stubGoogle((url) =>
        url.searchParams.has("commentsViewMode")
          ? {
              objectId: "s1",
              revisionId: "rev-1",
              commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED",
              comments: [{ commentId: "c1", headPost: { postId: "p1", content } }],
            }
          : {
              objectId: "s1",
              pageType: "SLIDE",
              revisionId: "rev-1",
              pageElements: [
                {
                  objectId: "box",
                  shape: { text: { textElements: [{ textRun: { content } }] } },
                },
              ],
            },
      );
      const connector = slides("decks", await workspaceOptions());
      for (const [tool, raw] of [
        ["get_page", false],
        ["get_page", true],
        ["list_comments", false],
        ["list_comments", true],
      ] as const) {
        const args = { presentationId: "deck1", pageObjectId: "s1", raw };
        const first: any = await connector.callTool(
          tool,
          args,
          privateContext(firstHasSecret ? privateValue : undefined),
        );
        expect(first.page.nextCursor).toBeTruthy();
        const continuation = { ...args, cursor: first.page.nextCursor };
        const same: any = await connector.callTool(
          tool,
          continuation,
          privateContext(firstHasSecret ? privateValue : undefined),
        );
        expect((same.elements ?? same.threads).length).toBeGreaterThan(0);
        await expect(
          connector.callTool(tool, continuation, privateContext(firstHasSecret ? undefined : privateValue)),
        ).rejects.toMatchObject({ code: "conflict" });
        if (firstHasSecret) expect(leaks(JSON.stringify([first, same]), privateValue)).toBe(false);
      }
    },
  );
});
