// The draft-only Gmail connection. Request and result shapes are pinned by
// test/goldens/gmail; this suite keeps what the goldens do not reach: MIME
// encoding and refusals, body selection, charsets, attachments, and bounds.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gmail } from "./index.js";
import { attachmentFixtures } from "./fixtures.js";
import { RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext } from "../../types.js";

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
let route: Route = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  route = () => undefined;
  globalThis.fetch = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (url === TOKEN_URL) {
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
  return gmail("mail", {
    purpose: "Pastoral staff email",
    serviceAccount: { clientEmail: `gmail-${accounts}@project.iam.gserviceaccount.com`, privateKey: PRIVATE_KEY },
    subject: "pastor@church.example",
    ...overrides,
  } as Parameters<typeof gmail>[1]);
}

function context(): ConnectorContext {
  return { storage: memoryStorage(), logger: silentLogger, baseUrl: "https://connecta.example" };
}

function call(connector: Connector, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return connector.callTool(name, args, context()) as Promise<any>;
}

const path = (index: number) => calls[index]!.url.pathname.replace("/gmail/v1/users/me", "");

function b64url(value: string, charset: "utf-8" | "latin1" = "utf-8"): string {
  const bytes =
    charset === "utf-8"
      ? new TextEncoder().encode(value)
      : Uint8Array.from(value, (character) => character.charCodeAt(0));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** Headers (unfolded) and the decoded text of every base64 part of a raw message. */
function parseMime(raw: string): {
  headers: Record<string, string>;
  parts: { type: string; text: string }[];
  source: string;
} {
  const source = decodeRaw(raw);
  const [head = "", ...rest] = source.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n /g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon)] = line.slice(colon + 1).trim();
  }
  const parts: { type: string; text: string }[] = [];
  const decode = (body: string) => {
    const binary = atob(body.replace(/\r\n/g, "").trim());
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  };
  const boundary = /boundary="([^"]+)"/.exec(headers["Content-Type"] ?? "")?.[1];
  if (!boundary) {
    parts.push({ type: headers["Content-Type"]!, text: decode(rest.join("\r\n\r\n")) });
  } else {
    for (const section of rest.join("\r\n\r\n").split(`--${boundary}`)) {
      const [partHead, partBody] = section.replace(/^\r\n/, "").split("\r\n\r\n");
      const type = /Content-Type: ([^\r\n]+)/.exec(partHead ?? "")?.[1];
      if (type && partBody !== undefined) parts.push({ type, text: decode(partBody) });
    }
  }
  return { headers, parts, source };
}

/** RFC 2047 B-words back to text, for asserting what a client will show. */
function decodeWords(value: string): string {
  return value
    .replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_word, data: string) =>
      new TextDecoder().decode(Uint8Array.from(atob(data), (character) => character.charCodeAt(0))),
    )
    .trim();
}

const MESSAGE = {
  id: "m2",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Can we move Tuesday&#39;s meeting?",
  internalDate: "1790000000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Ann Elder <ann@church.example>" },
      { name: "To", value: "pastor@church.example" },
      { name: "Subject", value: "Elders meeting" },
      { name: "Message-ID", value: "<m2@mail.example>" },
      { name: "In-Reply-To", value: "<m1@mail.example>" },
      { name: "References", value: "<m0@mail.example> <m1@mail.example>" },
      { name: "X-Noise", value: "dropped" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
            body: { size: 40, data: b64url("Can we move Tuesday’s meeting to 7pm?") },
          },
          {
            mimeType: "text/html",
            headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
            body: { size: 60, data: b64url("<p>Can we <b>move</b> it?</p>") },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "agenda.pdf",
        body: { size: 12345, attachmentId: "att-1" },
      },
    ],
  },
};

describe("reading mail (H9, H10)", () => {
  it("falls back to HTML converted to text, and honors a declared charset", async () => {
    route = () => ({
      body: {
        id: "m3",
        payload: {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: 'text/html; charset="iso-8859-1"' }],
              body: { data: b64url("<style>p{}</style><p>Café &amp; <b>prêt</b></p><br>Ligne&nbsp;2", "latin1") },
            },
          ],
        },
      },
    });
    const result = await call(connection(), "get_message", { messageId: "m3" });
    expect(result.bodyFormat).toBe("html");
    expect(result.body).toBe("Café & prêt\n\nLigne 2");
  });
});

describe("writing drafts", () => {
  it("creates a plain-text draft with encoded non-ASCII headers and a base64url raw message", async () => {
    route = () => ({ body: { id: "d1", message: { id: "m1", threadId: "t1", labelIds: ["DRAFT"] } } });
    const result = await call(connection(), "create_draft", {
      to: ["Zoë Ångström <zoe@church.example>", "bo@church.example"],
      cc: ["Smith, Ann <ann@church.example>"],
      bcc: ["elders@church.example"],
      subject: "Réunion des anciens — mardi 🙏",
      body: "Bonjour à tous,\nÀ mardi.",
    });

    expect(calls[0]!.method).toBe("POST");
    expect(path(0)).toBe("/drafts");
    const raw: string = calls[0]!.body.message.raw;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(calls[0]!.body.message.threadId).toBeUndefined();
    const mime = parseMime(raw);
    // Header lines are ASCII; RFC 2047 words carry the rest.
    expect(mime.source.split("\r\n\r\n")[0]).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(decodeWords(mime.headers["Subject"]!)).toBe("Réunion des anciens — mardi 🙏");
    for (const word of mime.headers["Subject"]!.split(" ")) expect(word.length).toBeLessThanOrEqual(75);
    expect(decodeWords(mime.headers["To"]!)).toBe("Zoë Ångström<zoe@church.example>, bo@church.example");
    expect(mime.headers["Cc"]).toBe('"Smith, Ann" <ann@church.example>');
    expect(mime.headers["Bcc"]).toBe("elders@church.example");
    expect(mime.headers["MIME-Version"]).toBe("1.0");
    expect(mime.headers["From"]).toBeUndefined();
    expect(mime.parts).toEqual([{ type: 'text/plain; charset="UTF-8"', text: "Bonjour à tous,\nÀ mardi." }]);
    expect(result).toEqual({ draftId: "d1", messageId: "m1", threadId: "t1", saved: true, sent: false });
  });

  it("refuses header injection and malformed addresses before anything is sent", async () => {
    await expect(
      call(connection(), "create_draft", { subject: "Hi\r\nBcc: spy@evil.example", body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "create_draft", { to: ["ann@church.example\nBcc: spy@evil.example"], body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connection(), "create_draft", { to: ["not an address"], body: "x" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(call(connection(), "create_draft", { to: ["a@b.example"] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
  });

  /** An existing draft as Gmail's full format returns it. */
  function existingDraft(headers: { name: string; value: string }[], parts?: unknown[]) {
    return {
      id: "d1",
      message: {
        id: "m5",
        threadId: "t1",
        payload: parts
          ? { mimeType: "multipart/mixed", headers, parts }
          : { mimeType: "text/plain", headers, body: { data: b64url("Old text") } },
      },
    };
  }

  it.each([
    [
      "an attachment",
      [
        { mimeType: "text/plain", body: { data: b64url("See attached.") } },
        { mimeType: "application/pdf", filename: "contract.pdf", body: { attachmentId: "a1", size: 9000 } },
      ],
      "contract.pdf",
    ],
    [
      "an inline image",
      [
        {
          mimeType: "multipart/related",
          parts: [
            { mimeType: "text/html", body: { data: b64url('<img src="cid:logo">') } },
            { mimeType: "image/png", headers: [{ name: "Content-ID", value: "<logo>" }], body: { attachmentId: "a2" } },
          ],
        },
      ],
      "multipart/related",
    ],
    [
      "a forwarded message",
      [
        { mimeType: "text/plain", body: { data: b64url("FYI") } },
        { mimeType: "message/rfc822", body: { attachmentId: "a3" } },
      ],
      "message/rfc822",
    ],
  ])("refuses, unchanged, a draft carrying %s it could not rebuild", async (_kind, parts, named) => {
    route = () => ({ body: existingDraft([{ name: "To", value: "ann@church.example" }], parts) });
    const failure = await call(connection(), "update_draft", { draftId: "d1", body: "Revised." }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(failure.message).toContain(named);
    expect(failure.message).toContain("Nothing was changed");
    expect(calls.map((entry) => entry.method)).toEqual(["GET"]);
  });

  it("refuses a draft nested deeper than it inspects, rather than assuming it is safe", async () => {
    // An attachment 22 multiparts down: past the depth the guard walks, so
    // it must refuse instead of rebuilding a message that would drop it.
    let deepest: Record<string, unknown> = {
      mimeType: "application/pdf",
      filename: "buried.pdf",
      body: { attachmentId: "a9", size: 10 },
    };
    for (let level = 0; level < 22; level += 1) {
      deepest = {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "text/plain", body: { data: b64url("x") } }, deepest],
      };
    }
    route = () => ({ body: existingDraft([{ name: "To", value: "ann@church.example" }], [deepest]) });
    const failure = await call(connection(), "update_draft", { draftId: "d1", body: "Revised." }).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "invalid_args" });
    expect(failure.message).toContain("nested more than 20 levels");
    expect(calls.map((entry) => entry.method)).toEqual(["GET"]);
  });

  it("splits address lists as RFC 5322 does: quoted commas, comments, and groups", async () => {
    route = (request) =>
      request.method === "GET"
        ? {
            body: {
              id: "m2",
              threadId: "t1",
              payload: {
                headers: [
                  { name: "Message-ID", value: "<m2@mail.example>" },
                  { name: "Subject", value: "Plans" },
                  {
                    name: "Reply-To",
                    value:
                      'Alice <alice@example.com>, "Bob, Jr." <bob@example.com> (desk), Team: carol@example.com, dan@example.com;',
                  },
                  { name: "From", value: "someone-else@example.com" },
                ],
              },
            },
          }
        : { body: { id: "d2", message: { id: "m3", threadId: "t1" } } };
    await call(connection(), "create_draft", { replyToMessageId: "m2", body: "Count us in." });
    const mime = parseMime(calls[1]!.body.message.raw);
    expect(mime.headers["To"]).toBe(
      'Alice <alice@example.com>, "Bob, Jr." <bob@example.com>, carol@example.com, dan@example.com',
    );
  });

  it("refuses a reply whose sender header it cannot parse, unless to is given", async () => {
    const replied = {
      id: "m2",
      threadId: "t1",
      payload: {
        headers: [
          { name: "Message-ID", value: "<m2@mail.example>" },
          { name: "From", value: '"Unclosed <ann@church.example>' },
        ],
      },
    };
    route = (request) =>
      request.method === "GET" ? { body: replied } : { body: { id: "d2", message: { id: "m3", threadId: "t1" } } };
    await expect(call(connection(), "create_draft", { replyToMessageId: "m2", body: "Hi" })).rejects.toMatchObject({
      code: "invalid_args",
      message: expect.stringContaining("pass to explicitly"),
    });
    expect(calls.map((entry) => entry.method)).toEqual(["GET"]);

    calls.length = 0;
    await call(connection(), "create_draft", { replyToMessageId: "m2", to: ["ann@church.example"], body: "Hi" });
    expect(parseMime(calls[1]!.body.message.raw).headers["To"]).toBe("ann@church.example");
  });
});

describe("a message's own body, apart from what it carries", () => {
  it("never takes an attached email's text for the message body", async () => {
    route = () => ({
      body: {
        id: "m7",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/html", body: { data: b64url("<p>The <b>real</b> body</p>") } },
            {
              mimeType: "message/rfc822",
              filename: "",
              body: {},
              parts: [{ mimeType: "text/plain", body: { data: b64url("The forwarded email's text") } }],
            },
            {
              mimeType: "multipart/mixed",
              headers: [{ name: "Content-Disposition", value: "attachment" }],
              parts: [{ mimeType: "text/plain", body: { data: b64url("Inside a disposed attachment") } }],
            },
          ],
        },
      },
    });
    const result = await call(connection(), "get_message", { messageId: "m7" });
    expect(result.bodyFormat).toBe("html");
    expect(result.body).toBe("The real body");
    expect(result.attachments).toEqual([
      { filename: "", mimeType: "message/rfc822" },
      { filename: "", mimeType: "multipart/mixed" },
    ]);
  });

  it("fetches a body Gmail stored apart from the message", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/attachments/body-1")
        ? { body: { size: 30, data: b64url("A long body stored separately") } }
        : {
            body: {
              id: "m8",
              payload: {
                mimeType: "text/plain",
                headers: [{ name: "Content-Type", value: 'text/plain; charset="UTF-8"' }],
                body: { size: 30, attachmentId: "body-1" },
              },
            },
          };
    const result = await call(connection(), "get_message", { messageId: "m8" });
    expect(path(1)).toBe("/messages/m8/attachments/body-1");
    expect(result).toMatchObject({ body: "A long body stored separately", bodyFormat: "text", bodyTruncated: false });
    expect(result.attachments).toBeUndefined();
  });

  it("says so, never returning a silent empty body, when a stored body is too large to read", async () => {
    route = () => ({
      body: {
        id: "m9",
        payload: { mimeType: "text/plain", body: { size: 5_000_000, attachmentId: "body-2" } },
      },
    });
    const result = await call(connection(), "get_message", { messageId: "m9" });
    expect(calls).toHaveLength(1);
    expect(result.bodyFormat).toBe("unavailable");
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toContain("5000000 bytes");
  });
});

// --- Worst-case result sizes ---------------------------------------------------------

// Worst-case payloads pushed through whole calls: CPU-bound, with no timing
// behavior, and seconds long even on an idle machine. A loaded one ran the
// unbudgeted cases past vitest's 5s default, so every case here gets a hang
// guard sized for that, not a speed assertion.
describe("every result is deliverable both ways it can be called", { timeout: 60_000 }, () => {
  // Inside execute_code the QuickJS bridge refuses one host result over
  // 256 KiB (MAX_HOST_RESULT_BYTES, src/executors/quickjs-runtime.ts); through
  // call_tool anything up to the stash (8 MiB by default) pages. A result
  // under the bridge clears both, so that is the bound asserted here, against
  // the most expensive strings JSON can carry: control characters (six bytes
  // escaped), lone surrogates (six), emoji (four per two units), CJK (three),
  // quotes and backslashes (two).
  const NASTY = '\u0001界😀\ud800"\\';
  const nasty = (length: number) => NASTY.repeat(Math.ceil(length / NASTY.length)).slice(0, length);
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const headers = (length: number) =>
    ["From", "To", "Cc", "Bcc", "Reply-To", "Subject", "Message-ID", "In-Reply-To"].map((name) => ({
      name,
      value: nasty(length),
    }));
  const labels = Array.from({ length: 200 }, (_, index) => `Label_${index}_${nasty(300)}`);

  function hugeMessage(
    id: string,
    bodyChars: number,
    { attachments = 300, headerChars = 10_000, labelCount = 200, filenameChars = 2000 } = {},
  ) {
    return {
      id,
      threadId: "t-huge",
      labelIds: labels.slice(0, labelCount),
      snippet: nasty(5000),
      internalDate: "1790000000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: headers(headerChars),
        parts: [
          { mimeType: "text/plain", body: { data: b64url(nasty(bodyChars)) } },
          ...Array.from({ length: attachments }, (_, index) => ({
            mimeType: "application/pdf",
            filename: `${index}-${nasty(filenameChars)}.pdf`,
            body: { attachmentId: `att-${index}-${"A".repeat(400)}`, size: 1000 },
          })),
        ],
      },
    };
  }

  it("keeps a full search page of the worst summaries under the bridge", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/threads")
        ? {
            body: {
              threads: Array.from({ length: 25 }, (_, index) => ({ id: `t${index}`, snippet: nasty(5000) })),
              nextPageToken: "next",
            },
          }
        : {
            body: {
              id: "t",
              messages: Array.from({ length: 3 }, (_, index) => ({
                id: `m${index}`,
                labelIds: labels,
                internalDate: "1790000000000",
                payload: { headers: headers(20_000) },
              })),
            },
          };
    const result = await call(connection(), "search_threads", { limit: 25 });
    expect(result.threads).toHaveLength(25);
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it.each([["the largest explicit body cap", 100_000]])(
    "pages a 40-message worst-case thread under %s, every page under the bridge",
    async (_cap, maxBodyChars) => {
      // Sized to stay inside the connector's 16 MB response ceiling, which a
      // thread this hostile would otherwise hit first.
      const messages = Array.from({ length: 40 }, (_, index) =>
        hugeMessage(`m${index}`, 12_000, { attachments: 10, headerChars: 2000, labelCount: 30, filenameChars: 300 }),
      );
      route = () => ({ body: { id: "t-huge", messages } });
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await call(connection(), "get_thread", {
          threadId: "t-huge",
          ...(maxBodyChars === undefined ? {} : { maxBodyChars }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.messageCount).toBe(40);
        seen.push(...result.messages.map((message: { id: string }) => message.id));
        cursor = result.page.nextCursor ?? undefined;
        expect(result.page.hasMore).toBe(cursor !== undefined);
        pages += 1;
      } while (cursor !== undefined && pages < 200);
      // Every message exactly once, in order, however many pages it took.
      expect(seen).toEqual(messages.map((message) => message.id));
      expect(pages).toBeGreaterThan(1);
    },
    60_000,
  );

  it("caps one worst-case message, at the largest body cap, under the bridge and says where it cut", async () => {
    route = () => ({ body: hugeMessage("m1", 200_000) });
    const result = await call(connection(), "get_message", { messageId: "m1", maxBodyChars: 100_000 });
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.bodyTruncated).toBe(true);
    expect(result.body).toMatch(/more characters truncated at connecta's 192 KiB per-result limit/);
    expect(result.attachments).toHaveLength(20);
    expect(result.attachmentsOmitted).toBe(280);
    // Every fixture label id is far past any Gmail id: dropped and counted, never cut.
    expect(result.labelIds).toEqual([]);
    expect(result.labelIdsOmitted).toBe(200);
  });

  it("refuses a raw message past the limit, with the way forward, and returns a small one", async () => {
    route = () => ({ body: hugeMessage("m3", 200_000) });
    const failure = await call(connection(), "get_message", { messageId: "m3", raw: true }).catch((error) => error);
    expect(failure).toMatchObject({ code: "invalid_args", message: expect.stringContaining("Read it without raw") });
    route = () => ({ body: MESSAGE });
    await expect(call(connection(), "get_message", { messageId: "m2", raw: true })).resolves.toEqual(MESSAGE);
  });
});

describe("round-5 bounds: identifiers, wrappers, and cursors", () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  it("drops identifiers far past any Gmail id instead of letting them fill the result", async () => {
    route = () => ({
      body: {
        id: "m".repeat(300_000),
        threadId: "t".repeat(300_000),
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Hello") } },
            { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "A".repeat(300_000), size: 9 } },
          ],
        },
      },
    });
    const result = await call(connection(), "get_message", { messageId: "m1" });
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.id).toBeUndefined();
    expect(result.threadId).toBeUndefined();
    expect(result.omittedIds).toEqual(["id", "threadId"]);
    expect(result.attachments).toEqual([
      { filename: "a.pdf", mimeType: "application/pdf", size: 9, omittedIds: ["attachmentId"] },
    ]);
    expect(result.body).toBe("Hello");
  });

  describe("thread cursors", () => {
    /** Messages whose 60 KB bodies put three on a page at most. */
    const message = (id: string) => ({
      id,
      threadId: "t1",
      payload: { mimeType: "text/plain", body: { data: b64url("a".repeat(60_000)) } },
    });
    let messages: ReturnType<typeof message>[];
    beforeEach(() => {
      messages = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map(message);
      route = () => ({ body: { id: "t1", messages } });
    });
    const page = (args: Record<string, unknown>) =>
      call(connection(), "get_thread", { threadId: "t1", maxBodyChars: 100_000, ...args });

    it("refuses a cursor from another thread, body cap, or tool", async () => {
      const first = await page({});
      const cursor = first.page.nextCursor;
      await expect(page({ threadId: "t2", cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(page({ maxBodyChars: 99_999, cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(call(connection(), "list_labels", { cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(page({ cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("not a cursor this connection issued"),
      });
    });

    it("answers conflict when a message is added or removed before where the page ended", async () => {
      const first = await page({});
      const cursor = first.page.nextCursor;
      const returned = first.messages.map((entry: { id: string }) => entry.id);
      expect(returned[0]).toBe("m1");

      // Insert before the anchor: resuming by position would repeat a message.
      messages = [message("m0"), ...messages];
      await expect(page({ cursor })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("Read it again from the start"),
      });

      // Remove one before it: resuming by position would skip one.
      messages = messages.filter((entry) => entry.id !== "m0" && entry.id !== "m1");
      await expect(page({ cursor })).rejects.toMatchObject({ code: "conflict" });
    });

    it("continues normally when messages arrive after where the page ended", async () => {
      const first = await page({});
      messages = [...messages, message("m8")];
      const second = await page({ cursor: first.page.nextCursor });
      expect(second.messages[0].id).toBe(messages[first.messages.length]!.id);
    });
  });

  it("answers conflict when the label list changed before a page's end", async () => {
    const labels = Array.from({ length: 3000 }, (_, index) => ({
      id: `Label_${index}`,
      name: "x".repeat(200),
      type: "user",
    }));
    let current = labels;
    route = () => ({ body: { labels: current } });
    const first = await call(connection(), "list_labels");
    expect(first.page.hasMore).toBe(true);
    expect(size(first)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    current = [{ id: "Label_new", name: "new", type: "user" }, ...labels];
    await expect(call(connection(), "list_labels", { cursor: first.page.nextCursor })).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("round-6: measured budgets, said omissions, declared keys", () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

  /** Every key a result carries, declared somewhere in its output schema. */
  function undeclared(value: unknown, schema: any, path = "$"): string[] {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => undeclared(item, schema?.items, `${path}[${index}]`));
    }
    if (value === null || typeof value !== "object") return [];
    const properties = schema?.properties ?? {};
    // An omission names a field of the object it sits on, by its public name.
    const omitted = Array.isArray((value as { omittedIds?: unknown }).omittedIds)
      ? (value as { omittedIds: string[] }).omittedIds
          .filter((name) => !(name in properties))
          .map((name) => `${path}.omittedIds:${name}`)
      : [];
    return [
      ...omitted,
      ...Object.entries(value).flatMap(([key, item]) =>
        key in properties ? undeclared(item, properties[key], `${path}.${key}`) : [`${path}.${key}`],
      ),
    ];
  }

  async function schemaOf(tool: string): Promise<unknown> {
    const tools = await connection().listTools(context());
    return tools.find((entry) => entry.name === tool)!.outputSchema;
  }

  it.each([
    [
      "get_message",
      { messageId: "m1" },
      (body: string) => ({ id: "m1", payload: { mimeType: "text/plain", body: { data: b64url(body) } } }),
    ],
  ] as const)(
    "%s fits a body at the exact boundary, untruncated, and cuts one character past it",
    async (tool, args, reply) => {
      // The largest plain body whose whole result fits, found by measuring the
      // real result — the accounting the tool itself must get right.
      const fetchWith = async (length: number) => {
        // Three bytes a character, so the result budget binds before maxBodyChars.
        route = () => ({ body: reply("界".repeat(length)) });
        return await call(connection(), tool, { ...args, maxBodyChars: 100_000 });
      };
      let low = 50_000;
      let high = 70_000;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const result = await fetchWith(middle);
        if (result.bodyTruncated === false) low = middle;
        else high = middle - 1;
      }
      const exact = await fetchWith(low);
      expect(exact.bodyTruncated).toBe(false);
      expect(exact.body.length).toBe(low);
      expect(size(exact)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      // At the boundary the result is within a few bytes of the budget: the
      // body was not given up to an estimate.
      expect(RESULT_BUDGET_BYTES - size(exact)).toBeLessThan(8);

      const past = await fetchWith(low + 1);
      expect(past.bodyTruncated).toBe(true);
      expect(size(past)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    },
    60_000,
  );

  it("reports a saved draft as saved even when Gmail's id cannot be returned", async () => {
    route = () => ({ body: { id: "D".repeat(5000), message: { id: "m1", threadId: "t1" } } });
    const tooLong = await call(connection(), "create_draft", { body: "x" });
    expect(tooLong).toMatchObject({ saved: true, sent: false, messageId: "m1", omittedIds: ["draftId"] });
    expect(tooLong.draftId).toBeUndefined();
    expect(tooLong.note).toContain("list_drafts");
    expect(tooLong.note).toContain("do not create it again");

    route = () => ({ body: { message: { id: "m2" } } });
    const missing = await call(connection(), "create_draft", { body: "x" });
    expect(missing).toMatchObject({ saved: true, sent: false, messageId: "m2" });
    expect(missing.omittedIds).toBeUndefined();
    expect(missing.note).toContain("list_drafts");
  });

  it("declares every key its results carry, omission fields included", async () => {
    const message = {
      id: "M".repeat(500),
      threadId: "t1",
      labelIds: Array.from({ length: 25 }, (_, index) => `Label_${index}`),
      snippet: "Hi",
      internalDate: "1790000000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [{ name: "Subject", value: "S" }],
        parts: [
          { mimeType: "text/plain", body: { data: b64url("Body") } },
          ...Array.from({ length: 22 }, (_, index) => ({
            mimeType: "application/pdf",
            filename: `${index}.pdf`,
            body: { attachmentId: index === 0 ? "A".repeat(5000) : `a${index}`, size: 1 },
          })),
        ],
      },
    };
    route = (request) => {
      const path = request.url.pathname;
      if (path.endsWith("/threads")) return { body: { threads: [{ id: "t1" }] } };
      if (path.endsWith("/drafts") && request.method === "GET") return { body: { drafts: [{ id: "d1" }] } };
      if (path.endsWith("/labels"))
        return {
          body: {
            labels: [
              { id: "INBOX", name: "INBOX", type: "system" },
              { id: "X".repeat(500), name: "x" },
            ],
          },
        };
      if (path.includes("/drafts/")) return { body: { id: "D".repeat(500), message } };
      if (path.includes("/threads/")) return { body: { id: "t1", messages: [message] } };
      if (request.method === "POST") return { body: { id: "D".repeat(500), message: { id: "m9" } } };
      return { body: message };
    };
    const results: [string, Record<string, unknown>][] = [
      ["search_threads", {}],
      ["get_thread", { threadId: "t1" }],
      ["get_message", { messageId: "m1" }],
      ["list_labels", {}],
      ["list_drafts", {}],
      ["get_draft", { draftId: "d1" }],
      ["create_draft", { body: "x" }],
    ];
    for (const [tool, args] of results) {
      const result = await call(connection(), tool, args);
      expect(undeclared(result, await schemaOf(tool)), tool).toEqual([]);
      // The fixture's oversized message id is reported under each tool's own
      // name for it.
      if (tool === "get_draft") expect(result.omittedIds).toEqual(["messageId"]);
      if (tool === "get_message") expect(result.omittedIds).toEqual(["id"]);
    }
  });
});

describe("reading carried attachments", () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  function serve(part: Record<string, unknown>, data?: string) {
    route = (request) =>
      request.url.pathname.includes("/attachments/")
        ? { body: { data } }
        : { body: { id: "m1", payload: { mimeType: "multipart/mixed", parts: [part] } } };
  }
  const read = (args: Record<string, unknown> = {}) =>
    call(connection(), "get_attachment", { messageId: "m1", ...args });

  it.each([
    ["forwarded email", attachmentFixtures.forwarded, "From: ann@example.com\r\n\r\nHi"],
    ["JSON", { ...attachmentFixtures.csv, mimeType: "application/json" }, '{"name":"Ann"}'],
  ])("INV-10: reads %s as text with only GET requests", async (_name, part, content) => {
    serve({ ...part, body: { ...part.body, size: new TextEncoder().encode(content).length } }, b64url(content));
    const result = await read({ partId: part.partId });
    expect(result).toMatchObject({
      messageId: "m1",
      filename: part.filename,
      mimeType: part.mimeType,
      format: "text",
      content,
      contentTruncated: false,
    });
    expect(calls.every((entry) => entry.method === "GET")).toBe(true);
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it.each([{ size: 0 }])("renders parsed forwarded headers and its own plain body with container %j", async (body) => {
    serve({ ...attachmentFixtures.parsedForwarded, body });
    const result = await read({ partId: "7" });
    expect(result).toMatchObject({
      format: "text",
      contentTruncated: false,
      content:
        "From: ann@example.com\nTo: bob@example.com\nDate: Mon, 12 Oct 2026 10:00:00 +0000\nSubject: Forwarded café\n\nHi",
    });
    expect(calls).toHaveLength(1);
  });

  it("checks the sum of forwarded descendants before any stored-body download", async () => {
    serve({
      ...attachmentFixtures.parsedForwarded,
      parts: [
        { mimeType: "text/plain", body: { size: 600_000, attachmentId: "body" } },
        { mimeType: "image/png", body: { size: 600_000, attachmentId: "image" } },
      ],
    });
    expect(await read({ partId: "7" })).toMatchObject({
      format: "unavailable",
      note: expect.stringContaining("1048576-byte"),
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    'text/csv; CHARSET = ISO-8859-1; name="cafe.csv"',
    'text/csv; name="cafe; charset=utf-8.csv"; ChArSeT \t=\t "ISO-8859-1"',
  ])("parses MIME charset parameter %s for attachments and all body callers", async (contentType) => {
    const part = { ...attachmentFixtures.latin1, headers: [{ name: "Content-Type", value: contentType }] };
    serve(part, b64url("Café", "latin1"));
    expect(await read({ partId: "3" })).toMatchObject({ format: "text", content: "Café" });
    const message = { id: "m1", payload: { ...part, filename: "", body: { size: 4, data: b64url("Café", "latin1") } } };
    route = (request) => ({
      body: request.url.pathname.includes("/threads/")
        ? { id: "t1", messages: [message] }
        : request.url.pathname.includes("/drafts/")
          ? { id: "d1", message }
          : message,
    });
    expect((await call(connection(), "get_message", { messageId: "m1" })).body).toBe("Café");
    expect((await call(connection(), "get_thread", { threadId: "t1" })).messages[0].body).toBe("Café");
    expect((await call(connection(), "get_draft", { draftId: "d1" })).body).toBe("Café");
  });

  it("reports unsupported charsets for attachments and message bodies", async () => {
    const part = {
      ...attachmentFixtures.latin1,
      headers: [{ name: "Content-Type", value: "text/plain; charset=x-unknown" }],
    };
    serve(part, b64url("Café", "latin1"));
    expect(await read({ partId: "3" })).toMatchObject({
      format: "text",
      note: expect.stringMatching(/x-unknown.*decoded as UTF-8/),
    });
    route = () => ({
      body: { id: "m1", payload: { ...part, filename: "", body: { data: b64url("Café", "latin1") } } },
    });
    expect(await call(connection(), "get_message", { messageId: "m1" })).toMatchObject({
      body: "Caf�",
      bodyNote: expect.stringMatching(/x-unknown.*decoded as UTF-8/),
    });
  });

  it.each([
    [3, 3, ""],
    [10, 3, "abc"],
  ])("refuses inconsistent attachment sizes: part %s, response %s, data %j", async (declared, fetched, data) => {
    route = (request) => ({
      body: request.url.pathname.includes("/attachments/")
        ? { size: fetched, data: b64url(data) }
        : { id: "m1", payload: { ...attachmentFixtures.pdf, body: { size: declared, attachmentId: "pdf" } } },
    });
    await expect(read({ partId: "5" })).rejects.toMatchObject({
      code: "connector_call_failed",
      retryable: false,
      message: expect.stringContaining("size"),
    });
  });

  it.each(["inline", "stored"])("keeps genuine zero-byte %s binary attachments supported", async (storage) => {
    const body = storage === "inline" ? { size: 0, data: "" } : { size: 0, attachmentId: "empty" };
    route = (request) => ({
      body: request.url.pathname.includes("/attachments/")
        ? { size: 0, data: "" }
        : { id: "m1", payload: { ...attachmentFixtures.pdf, body } },
    });
    expect(await read({ partId: "5" })).toMatchObject({
      format: "base64",
      size: 0,
      content: "",
      contentTruncated: false,
    });
  });

  it("lists and reads inline data without an attachmentId or download request", async () => {
    serve(attachmentFixtures.inline);
    const listing = await call(connection(), "get_message", { messageId: "m1" });
    expect(listing.attachments).toEqual([{ filename: "small.csv", mimeType: "text/csv", size: 4, partId: "4" }]);
    expect(await read({ partId: listing.attachments[0].partId })).toMatchObject({ content: "a,b\n", format: "text" });
    expect(calls).toHaveLength(2);
  });

  it("preserves an empty root partId for an inline attachment", async () => {
    route = () => ({ body: { id: "m1", payload: { ...attachmentFixtures.inline, partId: "" } } });
    const listing = await call(connection(), "get_message", { messageId: "m1" });
    expect(listing.attachments[0].partId).toBe("");
    expect(await read({ partId: "" })).toMatchObject({ partId: "", content: "a,b\n" });
  });

  it("returns standard base64 that round-trips PDF bytes exactly", async () => {
    const binary = "%PDF-1.7\n" + String.fromCharCode(0, 255, 254, 253, 252, 251);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    serve(attachmentFixtures.pdf, encoded);
    const result = await read({ attachmentId: "pdf-current" });
    expect(result).toMatchObject({ format: "base64", contentTruncated: false });
    expect(result.content).toBe(btoa(binary));
    expect(atob(result.content)).toBe(binary);
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it.each(["text/csv", "application/pdf"])("refuses oversized %s before any attachment request", async (mimeType) => {
    serve({ ...attachmentFixtures.pdf, mimeType, body: { attachmentId: "large", size: 1024 * 1024 + 1 } });
    const result = await read({ partId: "5", maxBytes: 4 * 1024 * 1024 });
    expect(result).toMatchObject({ format: "unavailable", note: expect.stringContaining("1048576-byte") });
    expect(result.content).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("accounts for metadata and base64 padding at the exact maxBytes boundary", async () => {
    const maxBytes = 64 * 1024;
    const part = { ...attachmentFixtures.pdf, body: { attachmentId: "fit", size: 0 } };
    serve(part, "");
    const empty = await read({ partId: "5", maxBytes });
    const fitting = Math.floor((maxBytes - size(empty) - 5) / 4) * 3;
    serve({ ...part, body: { attachmentId: "fit", size: fitting } }, b64url("x".repeat(fitting)));
    const fit = await read({ partId: "5", maxBytes });
    expect(fit.format).toBe("base64");
    expect(size(fit)).toBeLessThanOrEqual(maxBytes);
    calls.length = 0;
    serve({ ...part, body: { attachmentId: "fit", size: fitting + 1 } });
    expect(await read({ partId: "5", maxBytes })).toMatchObject({ format: "unavailable" });
    expect(calls).toHaveLength(1);
  });

  it("checks actual bytes too when declared size understates the binary", async () => {
    serve(attachmentFixtures.pdf, b64url("x".repeat(150_000)));
    await expect(read({ partId: "5" })).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it.each([{ attachmentId: "unknown" }, { partId: "unknown" }])(
    "refuses an unknown identifier %j without downloading",
    async (args) => {
      serve(attachmentFixtures.pdf);
      await expect(read(args)).rejects.toMatchObject({ code: "not_found" });
      expect(calls).toHaveLength(1);
    },
  );

  it("refuses a body part and missing identifiers without a blind fetch", async () => {
    serve({ partId: "body", mimeType: "text/plain", body: { size: 2, attachmentId: "body-current" } });
    await expect(read({ attachmentId: "body-current" })).rejects.toMatchObject({ code: "not_found" });
    calls.length = 0;
    await expect(read()).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(0);
  });

  it("resolves rotated attachmentIds through immutable partId using the fresh id", async () => {
    const connector = connection();
    serve({ ...attachmentFixtures.csv, body: { ...attachmentFixtures.csv.body, attachmentId: "old" } });
    const listed = await call(connector, "get_message", { messageId: "m1" });
    serve({ ...attachmentFixtures.csv, body: { ...attachmentFixtures.csv.body, size: 4 } }, b64url("a,b\n"));
    expect(
      await call(connector, "get_attachment", {
        messageId: "m1",
        partId: listed.attachments[0].partId,
        attachmentId: listed.attachments[0].attachmentId,
      }),
    ).toMatchObject({ content: "a,b\n" });
    expect(path(2)).toBe("/messages/m1/attachments/csv-current");
  });

  it("caps text by code points with a truncation marker", async () => {
    serve({ ...attachmentFixtures.csv, body: { ...attachmentFixtures.csv.body, size: 9 } }, b64url("😀a界b"));
    expect(await read({ partId: "1", maxChars: 2 })).toMatchObject({
      content: expect.stringMatching(/^😀a\n\[… 2 more characters truncated/),
      contentTruncated: true,
    });
  });

  it("keeps JSON-escaped text and long metadata inside the whole result budget", async () => {
    const content = '\u0001界😀"\\'.repeat(30_000);
    serve(
      {
        ...attachmentFixtures.csv,
        filename: content,
        body: { size: new TextEncoder().encode(content).length, attachmentId: "text" },
      },
      b64url(content),
    );
    const result = await read({ partId: "1", maxChars: 100_000, maxBytes: 64 * 1024 });
    expect(result.format).toBe("text");
    expect(result.contentTruncated).toBe(true);
    expect(result.content).toContain("truncated");
    expect(result.content.match(/more characters truncated/g)).toHaveLength(1);
    expect(size(result)).toBeLessThanOrEqual(64 * 1024);
  });

  it("does not turn malformed base64url into silently empty text", async () => {
    serve(attachmentFixtures.csv, "!");
    await expect(read({ partId: "1" })).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
  });

  it("refuses missing sizes and missing data explicitly", async () => {
    serve({ ...attachmentFixtures.inline, body: { data: "YSxiCg" } });
    expect(await read({ partId: "4" })).toMatchObject({
      format: "unavailable",
      note: expect.stringContaining("valid attachment size"),
    });
    serve({ ...attachmentFixtures.inline, body: { size: 4 } });
    expect(await read({ partId: "4" })).toMatchObject({
      format: "unavailable",
      note: expect.stringContaining("no attachment data"),
    });
  });
});
