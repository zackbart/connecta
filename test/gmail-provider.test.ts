// The draft-only Gmail connection. Tests stub the network and pin the requests
// each tool sends, the projections it returns, the MIME it writes, and the
// surface it refuses to have — H1, H9, H10, H11, and H14 for this provider.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_API_BASE_URL, GMAIL_SCOPES, gmail } from "../src/providers/gmail.js";
import { memoryStorage } from "../src/storage/memory.js";
import { isExplicitlyReadOnly } from "../src/tool-safety.js";
import { silentLogger } from "./helpers.js";
import type { Connector, ConnectorContext, ConnectorUsageGuide } from "../src/types.js";

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
  const bytes = charset === "utf-8"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(value, (character) => character.charCodeAt(0));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeRaw(raw: string): string {
  const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** Headers (unfolded) and the decoded text of every base64 part of a raw message. */
function parseMime(raw: string): { headers: Record<string, string>; parts: { type: string; text: string }[]; source: string } {
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
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_word, data: string) =>
    new TextDecoder().decode(Uint8Array.from(atob(data), (character) => character.charCodeAt(0))),
  ).trim();
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

  it("classifies reads as read-only and drafts as writes it never exempts itself", async () => {
    const connector = connection();
    const tools = await connector.listTools(context());
    const writes = tools.filter((tool) => !isExplicitlyReadOnly(tool)).map((tool) => tool.name);
    expect(writes.sort()).toEqual(["create_draft", "update_draft"]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName["create_draft"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    // Gmail's update replaces the whole message; the old body is gone.
    expect(byName["update_draft"]!.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(connector.approval).toBeUndefined();
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
            { id: "m1", labelIds: ["INBOX"], internalDate: "1790000000000", payload: { headers: [{ name: "Subject", value: "Elders meeting" }, { name: "From", value: "Ann <ann@church.example>" }] } },
            { id: "m2", labelIds: ["INBOX", "UNREAD"], internalDate: "1790000600000", payload: { headers: [{ name: "From", value: "Bo <bo@church.example>" }] } },
          ],
        },
      };
    };
    const result = await call(connection(), "search_threads", {
      query: "from:ann newer_than:7d",
      limit: 5,
      cursor: "prev",
      includeSpamTrash: true,
    });

    const list = calls[0]!.url;
    expect(`${list.origin}${list.pathname}`).toBe(`${GMAIL_API_BASE_URL}/threads`);
    expect(Object.fromEntries(list.searchParams)).toEqual({
      q: "from:ann newer_than:7d",
      maxResults: "5",
      pageToken: "prev",
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
      page: { hasMore: true, nextCursor: "next-1" },
    });
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
          attachments: [
            { filename: "agenda.pdf", mimeType: "application/pdf", size: 12345, attachmentId: "att-1" },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("X-Noise");
  });

  it("caps a body with an explicit marker", async () => {
    route = () => ({ body: MESSAGE });
    const result = await call(connection(), "get_message", { messageId: "m2", maxBodyChars: 11 });
    expect(result.body).toBe(
      "Can we move\n[… 26 more characters truncated; raise maxBodyChars to read them]",
    );
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

  it("lists labels unpaged as id, name, and type", async () => {
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
    expect(draft).toMatchObject({ draftId: "d1", messageId: "m9", threadId: "t9", body: "Can we move Tuesday’s meeting to 7pm?" });
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
    expect(mime.parts).toEqual([
      { type: 'text/plain; charset="UTF-8"', text: "Bonjour à tous,\nÀ mardi." },
    ]);
    expect(result).toEqual({ draftId: "d1", messageId: "m1", threadId: "t1", sent: false });
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
    expect(result).toEqual({ draftId: "d2", messageId: "m3", threadId: "t1", sent: false });
  });

  it("refuses header injection and malformed addresses before anything is sent", async () => {
    await expect(
      call(connection(), "create_draft", { subject: "Hi\r\nBcc: spy@evil.example", body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "create_draft", { to: ["ann@church.example\nBcc: spy@evil.example"], body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "create_draft", { to: ["not an address"], body: "x" }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(call(connection(), "create_draft", { to: ["a@b.example"] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
  });

  it("updates a draft's body, keeping its thread, reply headers, and unrestated headers", async () => {
    route = (request) =>
      request.method === "GET"
        ? {
            body: {
              id: "d1",
              message: {
                id: "m5",
                threadId: "t1",
                payload: {
                  headers: [
                    { name: "To", value: '"Smith, Ann" <ann@church.example>, bo@church.example' },
                    { name: "Cc", value: "elders@church.example" },
                    { name: "Subject", value: "Re: Elders meeting" },
                    { name: "In-Reply-To", value: "<m2@mail.example>" },
                    { name: "References", value: "<m1@mail.example> <m2@mail.example>" },
                  ],
                },
              },
            },
          }
        : { body: { id: "d1", message: { id: "m6", threadId: "t1" } } };
    const result = await call(connection(), "update_draft", { draftId: "d1", body: "Revised text.", cc: [] });

    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname.replace("/gmail/v1/users/me", "")}`)).toEqual([
      "GET /drafts/d1",
      "PUT /drafts/d1",
    ]);
    expect(calls[1]!.body.message.threadId).toBe("t1");
    const mime = parseMime(calls[1]!.body.message.raw);
    expect(mime.headers["To"]).toBe('"Smith, Ann" <ann@church.example>, bo@church.example');
    expect(mime.headers["Cc"]).toBeUndefined();
    expect(mime.headers["Subject"]).toBe("Re: Elders meeting");
    expect(mime.headers["In-Reply-To"]).toBe("<m2@mail.example>");
    expect(mime.headers["References"]).toBe("<m1@mail.example> <m2@mail.example>");
    expect(mime.parts[0]!.text).toBe("Revised text.");
    expect(result).toEqual({ draftId: "d1", messageId: "m6", threadId: "t1", sent: false });
  });
});
