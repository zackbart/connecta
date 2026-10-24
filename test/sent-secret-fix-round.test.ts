// Security-review regressions for original-span matching, all derived copies,
// normalization/extraction, tiny tails, and cross-request paging stability.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "./fixtures/owned-transport.js";
import { breeze } from "../src/providers/breeze/index.js";
import { docs } from "../src/providers/docs/index.js";
import { drive } from "../src/providers/drive/index.js";
import { gmail } from "../src/providers/gmail/index.js";
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

    // Private values matching wire keys must leave the projection, paging
    // and error decisions intact. The public result boundary still redacts.
    for (const key of ["files", "nextPageToken", "incompleteSearch", "emailAddress", "trashed"]) {
      stubGoogle(() => ({
        files: [{ id: "f1", name: "F", owners: [{ emailAddress: "alice@example.com" }], trashed: false }],
        nextPageToken: "next-1",
        incompleteSearch: true,
      }));
      const listing: any = await connector.callTool("search_files", {}, privateContext(key));
      expect(listing[key === "files" ? MARKER : "files"]).toEqual([
        { id: "f1", name: "F", owners: ["alice@example.com"], [key === "trashed" ? MARKER : "trashed"]: false },
      ]);
      expect(listing.page.hasMore).toBe(true);
      expect(listing.page.nextCursor).toBeTypeOf("string");
      expect(listing[key === "incompleteSearch" ? MARKER : "incompleteSearch"]).toBe(true);
    }

    const restore = installOwnedTransport();
    try {
      for (const key of ["parents", "rent"]) {
        const requests: { method: string; removeParents: string | null }[] = [];
        stubGoogle((url, init) => {
          requests.push({ method: init.method ?? "GET", removeParents: url.searchParams.get("removeParents") });
          return init.method === "PATCH" ? { id: "f1", parents: ["new-1"] } : { parents: ["old-1"] };
        });
        const moved: any = await connector.callTool(
          "move_file",
          { fileId: "f1", folderId: "new-1" },
          privateContext(key),
        );
        expect(requests).toEqual([
          { method: "GET", removeParents: null },
          { method: "PATCH", removeParents: "old-1" },
        ]);
        expect(moved[key === "parents" ? MARKER : "pa[redacted]s"]).toEqual(["new-1"]);
      }
    } finally {
      restore.restore();
    }

    for (const key of ["error", "errors", "details", "reason", "status", "message"]) {
      // Exercise both arrays and the status fallback, all with the same prose.
      for (const reason of [
        { errors: [{ reason: "userRateLimitExceeded" }] },
        { details: [{ reason: "userRateLimitExceeded" }] },
        { status: "RATE_LIMIT_EXCEEDED" },
      ]) {
        stubGoogle(() => Response.json({ error: { message: "Request refused.", ...reason } }, { status: 403 }));
        await expect(connector.callTool("get_file", { fileId: "f1" }, privateContext(key))).rejects.toMatchObject({
          code: "rate_limited",
          retryable: true,
        });
      }
      stubGoogle((url) =>
        url.pathname.endsWith("/export")
          ? Response.json(
              { error: { message: "Request refused.", errors: [{ reason: "exportSizeLimitExceeded" }] } },
              { status: 403 },
            )
          : { id: "d1", mimeType: "application/vnd.google-apps.document" },
      );
      await expect(connector.callTool("get_file_content", { fileId: "d1" }, privateContext(key))).rejects.toMatchObject(
        {
          code: "connector_call_failed",
          retryable: false,
          message:
            "Google Drive: Request refused. The item is larger than Google will export in this format. Download the original file instead, or export a smaller part.",
        },
      );
    }
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

describe("every Docs representation", () => {
  it.each(echoForms(SECRET))(
    "INV-5: truncated %s text is safe in titles, selected text, indexed previews, and the hatch",
    async (_name, form) => {
      const prefix = form.slice(0, Math.ceil(form.length / 2));
      const text = `intro ${form} public tail`;
      stubGoogle(() => ({
        documentId: "d1",
        title: text,
        body: {
          content: [
            {
              paragraph: {
                elements: [{ textRun: { content: text.slice(0, 8) } }, { textRun: { content: text.slice(8) } }],
              },
            },
          ],
        },
      }));
      const connector = docs("docs", await workspaceOptions());
      for (const args of [{}, { withIndexes: true }, { maxChars: 12 }, { hatch: true }]) {
        const ctx = privateContext(SECRET);
        const result =
          "hatch" in args
            ? await connector.callTool("docs_api_read", { path: "/documents/d1" }, ctx)
            : await connector.callTool("get_document", { documentId: "d1", ...args }, ctx);
        const shown = JSON.stringify(result);
        expect(shown).not.toContain(prefix);
        expect(leaks(shown)).toBe(false);
        expect(shown).toContain(MARKER);
        // A vendor-bounded source loses its unfinished tail before projection too.
        expect(redactBoundedRead(ctx, `intro ${prefix}`)).toBe(`intro ${MARKER}`);
      }
    },
  );
});

describe("redact before normalization or extraction", () => {
  it("INV-5: Breeze redacts a private amount before decimal parsing can shorten its representation, and a private key before its failure text is cut", async () => {
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
    expect(result).not.toHaveProperty("totalAmount");
    expect(result.items[0].amount).toBe(MARKER);
    expect(JSON.stringify(result)).not.toContain("12345.67");
    // The kit keeps keys for value safety (#703); the 300-unit cut would leave five units of this one.
    const key = "Q8!wZ2?vR7#k";
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: { [`${"x".repeat(293)}${key}`]: "no" } }),
    );
    const error = (await connector
      .callTool(
        "list_contributions",
        { start: "2026-01-01", end: "2026-01-31" },
        { ...privateContext(key), credential: keyed().credential! },
      )
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("Breeze reported a failure");
    expect(error.message).not.toContain(key.slice(0, 4));
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

  it("INV-5: Slides redacts joined shape and table sources before trimming or flattening whitespace, and keeps the wire and error keys a private value names", async () => {
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
    // The kit redacts each source leaf before joining the two runs.
    expect(result.elements.map((element: any) => element.text)).toEqual([`${MARKER}${MARKER}`, `${MARKER}${MARKER}`]);
    expect(leaks(JSON.stringify(result), value)).toBe(false);

    // A private value matching a public wire key cannot hide the shape's
    // text before projection. Unknown keys and echoed values stay private.
    stubGoogle(() => ({
      objectId: "s1",
      revisionId: "rev-1",
      pageElements: [
        {
          objectId: "elem1",
          shape: { text: { textElements: [{ textRun: { content: "Public retained text" } }] } },
          prefix_shape: "shape",
        },
      ],
    }));
    const keyed: any = await connector.callTool(
      "get_page",
      { presentationId: "deck1", pageObjectId: "s1" },
      privateContext("shape"),
    );
    expect(keyed.elements).toEqual([{ objectId: "elem1", kind: MARKER, text: "Public retained text" }]);
    expect(JSON.stringify(keyed)).not.toContain("shape");

    // Google's error keys keep their names too, so private values naming them leave the classification.
    stubGoogle(() =>
      Response.json(
        {
          error: {
            code: 403,
            message: "Rate Limit Exceeded",
            status: "PERMISSION_DENIED",
            errors: [{ reason: "userRateLimitExceeded", domain: "usageLimits" }],
          },
        },
        { status: 403 },
      ),
    );
    const named = privateContext();
    for (const value of ["reason", "errors", "status"])
      requestSentSecrets(named).arguments({ private: value }, privateSchema);
    const limited = await connector
      .callTool("get_page", { presentationId: "deck1", pageObjectId: "s1" }, named)
      .catch((error: unknown) => error);
    expect(limited).toMatchObject({ code: "rate_limited", retryable: true });
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
      expect(result.items[0].paidOn).toBe(MARKER);
      expect(JSON.stringify(result)).not.toContain("2026-01-02");
      expect(leaks(JSON.stringify(result), secret)).toBe(false);
    },
  );

  it("INV-5: Docs normalizes a private paragraph only after redacting its original whitespace", async () => {
    for (const value of [`   private   paragraph ${"sensitive ".repeat(30)}\n`, "paragraph"]) {
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
    }
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
