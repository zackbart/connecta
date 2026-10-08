// The draft-only Gmail connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the MIME it writes, and the
// surface it refuses to have — H1, H9, H10, H11, and H14 for this provider.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_API_BASE_URL, GMAIL_SCOPES, gmail } from "./index.js";
import { RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { classifyTool } from "../../tool-safety.js";
import { silentLogger } from "../../../test/helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../../types.js";

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

function guide(connector: Connector): ConnectorUsageGuide {
  if (typeof connector.usageGuide !== "object" || !connector.usageGuide) {
    throw new Error("expected a structured guide");
  }
  return connector.usageGuide;
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

describe("gmail() identity and surface (H1, H14)", () => {
  it("requires a purpose and names the routing fact in title, description, and guide", () => {
    expect(() => connection({ purpose: "" })).toThrow(/purpose/);
    const connector = connection({ instructions: "Sign drafts as Pastor Dan." });
    expect(connector.title).toBe("Gmail (drafts only)");
    expect(connector.description).toContain("never send");
    expect(connector.description).toContain("Pastoral staff email");
    const content = guide(connector).content;
    expect(content.split("\n").find((line) => line && !line.startsWith("#"))).toMatch(/never send/);
    expect(content).toContain("## Connection instructions\n\nSign drafts as Pastor Dan.");
    expect(guide(connector).required).toBe(true);
  });

  it("has no tool that sends, deletes, or relabels, and no raw hatch", async () => {
    const tools = await connection().listTools(context());
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_draft",
      "get_draft",
      "get_message",
      "get_thread",
      "list_drafts",
      "list_labels",
      "search_threads",
      "update_draft",
    ]);
    expect(tools.some((tool) => /send|delete|trash|label_|modify|gmail_api/.test(tool.name))).toBe(false);
  });

  it("classifies reads as read-only and drafts as writes", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const writes = tools.filter((tool) => !isRead(tool)).map((tool) => tool.name);
    expect(writes.sort()).toEqual(["create_draft", "update_draft"]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName["create_draft"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    // Gmail's update replaces the whole message; the old body is gone.
    expect(byName["update_draft"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(connector).not.toHaveProperty("approval");
    // No operator slot and no OAuth: the key is deployment config.
    expect(connector.credential).toBeUndefined();
    expect(connector.startAuth).toBeUndefined();
  });

  it("requests exactly gmail.readonly and gmail.compose", () => {
    expect([...GMAIL_SCOPES]).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ]);
  });
});

describe("reading mail (H9, H10)", () => {
  it("searches with Gmail syntax and summarizes each thread from metadata", async () => {
    route = (request) => {
      if (request.url.pathname.endsWith("/threads")) {
        return {
          body: {
            threads: [
              { id: "t1", snippet: "Latest &amp; greatest" },
              { id: "gone", snippet: "deleted meanwhile" },
            ],
            nextPageToken: "next-1",
            resultSizeEstimate: 42,
          },
        };
      }
      if (request.url.pathname.endsWith("/threads/gone")) {
        return { status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } };
      }
      return {
        body: {
          id: "t1",
          messages: [
            {
              id: "m1",
              labelIds: ["INBOX"],
              internalDate: "1790000000000",
              payload: {
                headers: [
                  { name: "Subject", value: "Elders meeting" },
                  { name: "From", value: "Ann <ann@church.example>" },
                ],
              },
            },
            {
              id: "m2",
              labelIds: ["INBOX", "UNREAD"],
              internalDate: "1790000600000",
              payload: { headers: [{ name: "From", value: "Bo <bo@church.example>" }] },
            },
          ],
        },
      };
    };
    const searchArgs = { query: "from:ann newer_than:7d", limit: 5, includeSpamTrash: true };
    const result = await call(connection(), "search_threads", searchArgs);

    const list = calls[0]!.url;
    expect(`${list.origin}${list.pathname}`).toBe(`${GMAIL_API_BASE_URL}/threads`);
    expect(Object.fromEntries(list.searchParams)).toEqual({
      q: "from:ann newer_than:7d",
      maxResults: "5",
      includeSpamTrash: "true",
    });
    const metadata = calls.find((entry) => entry.url.pathname.endsWith("/threads/t1"))!.url;
    expect(metadata.searchParams.get("format")).toBe("metadata");
    expect(metadata.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From", "Date"]);

    expect(result).toEqual({
      threads: [
        {
          id: "t1",
          subject: "Elders meeting",
          from: "Ann <ann@church.example>",
          lastFrom: "Bo <bo@church.example>",
          messageCount: 2,
          lastMessageAt: new Date(1790000600000).toISOString(),
          unread: true,
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Latest & greatest",
        },
      ],
      resultSizeEstimate: 42,
      page: { hasMore: true, nextCursor: expect.stringMatching(/^[A-Za-z0-9_-]+$/) },
    });

    // The cursor carries Gmail's page token back to Gmail, for this call only.
    calls.length = 0;
    await call(connection(), "search_threads", { ...searchArgs, cursor: result.page.nextCursor });
    expect(calls[0]!.url.searchParams.get("pageToken")).toBe("next-1");
    for (const other of [
      { ...searchArgs, query: "from:bo" },
      { ...searchArgs, limit: 6 },
    ]) {
      await expect(
        call(connection(), "search_threads", { ...other, cursor: result.page.nextCursor }),
      ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringContaining("different call") });
    }
    await expect(call(connection(), "list_drafts", { limit: 5, cursor: result.page.nextCursor })).rejects.toMatchObject(
      { code: "invalid_args" },
    );
  });

  it("ends paging with one branchable signal", async () => {
    route = () => ({ body: {} });
    const result = await call(connection(), "search_threads");
    expect(result).toEqual({ threads: [], page: { hasMore: false, nextCursor: null } });
    expect(calls[0]!.url.searchParams.get("maxResults")).toBe("10");
  });

  it("projects a thread's messages with decoded text bodies, headers that matter, and attachment metadata", async () => {
    route = () => ({ body: { id: "t1", messages: [MESSAGE] } });
    const result = await call(connection(), "get_thread", { threadId: "t1" });
    expect(path(0)).toBe("/threads/t1");
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(result).toEqual({
      id: "t1",
      messageCount: 1,
      messages: [
        {
          id: "m2",
          threadId: "t1",
          labelIds: ["INBOX", "UNREAD"],
          date: new Date(1790000000000).toISOString(),
          from: "Ann Elder <ann@church.example>",
          to: "pastor@church.example",
          subject: "Elders meeting",
          messageIdHeader: "<m2@mail.example>",
          inReplyTo: "<m1@mail.example>",
          snippet: "Can we move Tuesday's meeting?",
          body: "Can we move Tuesday’s meeting to 7pm?",
          bodyTruncated: false,
          bodyFormat: "text",
          attachments: [{ filename: "agenda.pdf", mimeType: "application/pdf", size: 12345, attachmentId: "att-1" }],
        },
      ],
      page: { hasMore: false, nextCursor: null },
    });
    expect(JSON.stringify(result)).not.toContain("X-Noise");
  });

  it("caps a body with an explicit marker", async () => {
    route = () => ({ body: MESSAGE });
    const result = await call(connection(), "get_message", { messageId: "m2", maxBodyChars: 11 });
    expect(result.body).toBe("Can we move\n[… 26 more characters truncated; raise maxBodyChars to read them]");
    expect(result.bodyTruncated).toBe(true);
  });

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

  it("returns Gmail's untouched message on raw: true", async () => {
    route = () => ({ body: MESSAGE });
    const result = await call(connection(), "get_message", { messageId: "m2", raw: true });
    expect(result).toEqual(MESSAGE);
  });

  it("lists labels as id, name, and type, in one page when they fit", async () => {
    route = () => ({
      body: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system", messageListVisibility: "show" },
          { id: "Label_7", name: "Elders", type: "user", color: { textColor: "#000" } },
        ],
      },
    });
    const result = await call(connection(), "list_labels");
    expect(path(0)).toBe("/labels");
    expect(result).toEqual({
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_7", name: "Elders", type: "user" },
      ],
      page: { hasMore: false, nextCursor: null },
    });
  });

  it("lists drafts with their subject and recipients, and gets one with its body", async () => {
    route = (request) => {
      if (request.url.pathname.endsWith("/drafts")) {
        return { body: { drafts: [{ id: "d1", message: { id: "m9", threadId: "t9" } }] } };
      }
      return {
        body: {
          id: "d1",
          message: {
            ...MESSAGE,
            id: "m9",
            threadId: "t9",
            labelIds: ["DRAFT"],
          },
        },
      };
    };
    const listed = await call(connection(), "list_drafts", { query: "subject:elders", limit: 3 });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ q: "subject:elders", maxResults: "3" });
    expect(path(1)).toBe("/drafts/d1");
    expect(calls[1]!.url.searchParams.get("format")).toBe("metadata");
    expect(listed).toEqual({
      drafts: [
        {
          draftId: "d1",
          messageId: "m9",
          threadId: "t9",
          subject: "Elders meeting",
          to: "pastor@church.example",
          updatedAt: new Date(1790000000000).toISOString(),
          snippet: "Can we move Tuesday's meeting?",
        },
      ],
      page: { hasMore: false, nextCursor: null },
    });

    calls.length = 0;
    const draft = await call(connection(), "get_draft", { draftId: "d1" });
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(draft).toMatchObject({
      draftId: "d1",
      messageId: "m9",
      threadId: "t9",
      body: "Can we move Tuesday’s meeting to 7pm?",
    });
    expect(draft.id).toBeUndefined();
  });

  it("maps a 404 to not_found: the mailbox is the token's own", async () => {
    route = () => ({ status: 404, body: { error: { code: 404, message: "Requested entity was not found." } } });
    await expect(call(connection(), "get_thread", { threadId: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
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

  it("adds an HTML alternative beside the plain text", async () => {
    route = () => ({ body: { id: "d1", message: { id: "m1" } } });
    await call(connection(), "create_draft", { to: ["a@b.example"], body: "Plain", htmlBody: "<p>Rich</p>" });
    const mime = parseMime(calls[0]!.body.message.raw);
    expect(mime.headers["Content-Type"]).toMatch(/^multipart\/alternative; boundary="connecta-/);
    expect(mime.parts).toEqual([
      { type: 'text/plain; charset="UTF-8"', text: "Plain" },
      { type: 'text/html; charset="UTF-8"', text: "<p>Rich</p>" },
    ]);
  });

  it("replies in the thread with In-Reply-To, References, Re: subject, and the sender as recipient", async () => {
    route = (request) =>
      request.method === "GET"
        ? {
            body: {
              id: "m2",
              threadId: "t1",
              payload: {
                headers: [
                  { name: "Message-ID", value: "<m2@mail.example>" },
                  { name: "References", value: "<m0@mail.example>\r\n <m1@mail.example>" },
                  { name: "Subject", value: "Elders meeting" },
                  { name: "From", value: "Ann Elder <ann@church.example>" },
                ],
              },
            },
          }
        : { body: { id: "d2", message: { id: "m3", threadId: "t1" } } };
    const result = await call(connection(), "create_draft", { replyToMessageId: "m2", body: "Yes, 7pm works." });

    expect(path(0)).toBe("/messages/m2");
    expect(calls[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(calls[1]!.body.message.threadId).toBe("t1");
    const mime = parseMime(calls[1]!.body.message.raw);
    expect(mime.headers["In-Reply-To"]).toBe("<m2@mail.example>");
    expect(mime.headers["References"]).toBe("<m0@mail.example> <m1@mail.example> <m2@mail.example>");
    expect(mime.headers["Subject"]).toBe("Re: Elders meeting");
    expect(mime.headers["To"]).toBe("Ann Elder <ann@church.example>");
    expect(result).toEqual({ draftId: "d2", messageId: "m3", threadId: "t1", saved: true, sent: false });
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

  it("updates a draft's body, keeping every header it promises to keep", async () => {
    route = (request) =>
      request.method === "GET"
        ? {
            body: existingDraft([
              { name: "From", value: "Pastor Dan <dan@church.example>" },
              { name: "To", value: '"Smith, Ann" <ann@church.example>, bo@church.example' },
              { name: "Cc", value: "elders@church.example" },
              { name: "Bcc", value: "secretary@church.example" },
              { name: "Reply-To", value: "Church Office <office@church.example>" },
              { name: "Subject", value: "Re: Elders meeting" },
              { name: "In-Reply-To", value: "<m2@mail.example>" },
              { name: "References", value: "<m1@mail.example> <m2@mail.example>" },
            ]),
          }
        : { body: { id: "d1", message: { id: "m6", threadId: "t1" } } };
    const result = await call(connection(), "update_draft", { draftId: "d1", body: "Revised text.", cc: [] });

    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname.replace("/gmail/v1/users/me", "")}`)).toEqual([
      "GET /drafts/d1",
      "PUT /drafts/d1",
    ]);
    expect(calls[0]!.url.searchParams.get("format")).toBe("full");
    expect(calls[1]!.body.message.threadId).toBe("t1");
    const mime = parseMime(calls[1]!.body.message.raw);
    expect(mime.headers["From"]).toBe("Pastor Dan <dan@church.example>");
    expect(mime.headers["To"]).toBe('"Smith, Ann" <ann@church.example>, bo@church.example');
    // Restated as empty: cleared.
    expect(mime.headers["Cc"]).toBeUndefined();
    expect(mime.headers["Bcc"]).toBe("secretary@church.example");
    expect(mime.headers["Reply-To"]).toBe("Church Office <office@church.example>");
    expect(mime.headers["Subject"]).toBe("Re: Elders meeting");
    expect(mime.headers["In-Reply-To"]).toBe("<m2@mail.example>");
    expect(mime.headers["References"]).toBe("<m1@mail.example> <m2@mail.example>");
    expect(mime.parts[0]!.text).toBe("Revised text.");
    expect(result).toEqual({ draftId: "d1", messageId: "m6", threadId: "t1", saved: true, sent: false });
  });

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

  it("lists an unnamed inline image, while a stored text body is still read as the body", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/attachments/body-3")
        ? { body: { size: 40, data: b64url("<p>Logo <b>above</b></p>") } }
        : {
            body: {
              id: "m10",
              payload: {
                mimeType: "multipart/related",
                parts: [
                  { mimeType: "text/html", filename: "", body: { size: 40, attachmentId: "body-3" } },
                  {
                    mimeType: "image/png",
                    filename: "",
                    headers: [
                      { name: "Content-Disposition", value: "inline" },
                      { name: "Content-ID", value: "<logo>" },
                    ],
                    body: { size: 2048, attachmentId: "img-1" },
                  },
                ],
              },
            },
          };
    const result = await call(connection(), "get_message", { messageId: "m10" });
    expect(path(1)).toBe("/messages/m10/attachments/body-3");
    expect(result).toMatchObject({ body: "Logo above", bodyFormat: "html" });
    expect(result.attachments).toEqual([{ filename: "", mimeType: "image/png", size: 2048, attachmentId: "img-1" }]);
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
  // Asserted against connecta's own budget, which leaves the bridge room.
  const BRIDGE_LIMIT = 256 * 1024;
  it("budgets results under the bridge", () => {
    expect(RESULT_BUDGET_BYTES).toBeLessThan(BRIDGE_LIMIT);
  });
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

  it("keeps a full drafts page of the worst summaries under the bridge", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/drafts")
        ? { body: { drafts: Array.from({ length: 25 }, (_, index) => ({ id: `d${index}` })) } }
        : { body: { id: "d", message: { id: "m", snippet: nasty(5000), payload: { headers: headers(20_000) } } } };
    const result = await call(connection(), "list_drafts", { limit: 25 });
    expect(result.drafts).toHaveLength(25);
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it.each([
    ["the default body cap", undefined],
    ["the largest explicit body cap", 100_000],
  ])(
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

  it("fits a fetched 1 MB stored body under the bridge", async () => {
    route = (request) =>
      request.url.pathname.includes("/attachments/")
        ? { body: { size: 1_000_000, data: b64url(nasty(400_000)) } }
        : {
            body: {
              id: "m2",
              payload: {
                mimeType: "text/plain",
                headers: headers(10_000),
                body: { size: 1_000_000, attachmentId: "big" },
              },
            },
          };
    const result = await call(connection(), "get_message", { messageId: "m2", maxBodyChars: 100_000 });
    expect(path(1)).toBe("/messages/m2/attachments/big");
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.bodyTruncated).toBe(true);
  });

  it("pages 10,000 worst-case labels under the bridge, each label once", async () => {
    const all = Array.from({ length: 10_000 }, (_, index) => ({
      id: `Label_${index}`,
      name: nasty(225),
      type: "user",
    }));
    route = () => ({ body: { labels: all } });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await call(connection(), "list_labels", cursor === undefined ? {} : { cursor });
      expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
      seen.push(...result.labels.map((label: { id: string }) => label.id));
      cursor = result.page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 1000);
    expect(seen).toEqual(all.map((label) => label.id));
    expect(pages).toBeGreaterThan(1);
  }, 60_000);

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

  it("budgets get_draft's whole result, wrapper included", async () => {
    const nasty = (length: number) => '\u0001界😀\ud800"\\'.repeat(Math.ceil(length / 6)).slice(0, length);
    route = () => ({
      body: {
        id: "d".repeat(200),
        message: {
          id: "m1",
          payload: {
            mimeType: "text/plain",
            headers: ["From", "To", "Cc", "Subject"].map((name) => ({ name, value: nasty(5000) })),
            body: { data: b64url(nasty(200_000)) },
          },
        },
      },
    });
    const result = await call(connection(), "get_draft", { draftId: "d1", maxBodyChars: 100_000 });
    expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(result.bodyTruncated).toBe(true);
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

    it("pages every message once, each page within budget, and ends", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await page(cursor === undefined ? {} : { cursor });
        expect(size(result)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
        seen.push(...result.messages.map((entry: { id: string }) => entry.id));
        cursor = result.page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 20);
      expect(seen).toEqual(messages.map((entry) => entry.id));
      expect(pages).toBeGreaterThan(1);
    });

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
    [
      "get_draft",
      { draftId: "d1" },
      (body: string) => ({
        id: "d1",
        message: { id: "m1", payload: { mimeType: "text/plain", body: { data: b64url(body) } } },
      }),
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

  it("counts label ids it leaves out, and never cuts one", async () => {
    const labelIds = [...Array.from({ length: 21 }, (_, index) => `Label_${index}`), "L".repeat(500)];
    route = () => ({ body: { id: "m1", labelIds, payload: { mimeType: "text/plain", body: { data: b64url("x") } } } });
    const result = await call(connection(), "get_message", { messageId: "m1" });
    expect(result.labelIds).toEqual(labelIds.slice(0, 20));
    expect(result.labelIdsOmitted).toBe(2);
    expect(JSON.stringify(result)).not.toContain("…");
  });

  it("leaves an unusable label out of list_labels and counts it", async () => {
    route = () => ({
      body: {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "L".repeat(500), name: "Too long", type: "user" },
          { id: "Label_1", name: "Elders", type: "user" },
        ],
      },
    });
    const result = await call(connection(), "list_labels");
    expect(result.labels.map((label: { id: string }) => label.id)).toEqual(["INBOX", "Label_1"]);
    expect(result.labelsOmitted).toBe(1);
  });

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
