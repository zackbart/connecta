// The draft-only Gmail connection. Request and result shapes are pinned by
// test/goldens/gmail; this suite keeps what the goldens do not reach: MIME
// encoding and refusals, body selection, charsets, attachments, and bounds.
// Delegation, subjects, and tokens are test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { requestSentSecrets } from "../../sent-secrets.js";
import { gmail } from "./index.js";
import type { ConnectorCaller } from "../../connector-caller.js";
import { index, verdicts, refusalReasons } from "./lib/index.js";
import { skill } from "./skill.generated.js";
import { safety } from "./api.js";
import { attachmentFixtures } from "./fixtures.js";
import { RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { makeRegistry, silentLogger } from "../../../test/helpers.js";
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
let storage = memoryStorage();
const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  storage = memoryStorage();
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
  return { storage, logger: silentLogger, baseUrl: "https://connecta.example" };
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
    await expect(call(connection(), "get_message", { messageId: "m3", fields: ["bodyFormat"] })).resolves.toEqual({
      bodyFormat: "html",
    });
    const before = calls.length;
    await expect(call(connection(), "get_message", { messageId: "m3", fields: ["unknown"] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toHaveLength(before);
  });
});

describe("writing drafts", () => {
  beforeEach(() => {
    installOwnedTransport();
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
    for (const bad of [
      "<bad\u0000@a>",
      "<café@a>",
      "<bad\u0001@a>",
      "<bad@a>\r\nBcc: spy@a",
      "<[redacted]@a>",
      "<damaged>",
      "<a@b><broken>",
      "<a@b> (unclosed",
      "<a@b>\n <c@d>",
    ]) {
      for (const name of ["Message-ID", "References", "In-Reply-To"]) {
        route = () => ({
          body:
            name === "In-Reply-To"
              ? {
                  id: "d1",
                  message: {
                    id: "m1",
                    threadId: "t1",
                    payload: { mimeType: "text/plain", headers: [{ name, value: bad }] },
                  },
                }
              : {
                  id: "m1",
                  threadId: "t1",
                  payload: {
                    headers: [
                      { name, value: bad },
                      { name: "From", value: "alice@example.com" },
                    ],
                  },
                },
        });
        await expect(
          call(connection(), name === "In-Reply-To" ? "update_draft" : "create_draft", {
            body: "x",
            ...(name === "In-Reply-To" ? { draftId: "d1" } : { replyToMessageId: "m1" }),
          }),
        ).rejects.toMatchObject({ code: "invalid_args" });
      }
    }
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    calls.length = 0;
    route = () => ({
      body: {
        id: "m1",
        threadId: "t1",
        payload: {
          headers: [
            { name: "Message-ID", value: "<Valid.Token+1@example.com>" },
            { name: "References", value: "<ancestor@example.com>" },
            { name: "From", value: "alice@example.com" },
          ],
        },
      },
    });
    await call(connection(), "create_draft", { body: "x", replyToMessageId: "m1" });
    const mime = parseMime(calls.at(-1)!.body.message.raw);
    expect(mime.headers["In-Reply-To"]).toBe("<Valid.Token+1@example.com>");
    expect(mime.headers["References"]).toContain("<ancestor@example.com>");
    // Valid modern and obsolete forms retain their ids, without salvaging a damaged token.
    for (const [id, references] of [
      ["<root@example.com> (comment)", "<a@example.com><b@example.com>"],
      ["(before (nested\\) comment)) <root@example.com>", "<a@example.com>, <b@example.com>"],
      ['<"quoted local"@example.com>', "<a@example.com>\r\n \t<b@example.com>"],
      ["<root@[127.0.0.1]>", "(ignore <not-an-id>) <a@example.com> (after)"],
      ['<"quoted@local" (left) @ (right) example . com>', 'Earlier "message" <a@example.com>'],
    ] as const) {
      calls.length = 0;
      route = (request) => ({
        body:
          request.method === "GET"
            ? {
                id: "m1",
                threadId: "t1",
                payload: {
                  headers: [
                    { name: "Message-ID", value: id },
                    { name: "References", value: references },
                    { name: "From", value: "alice@example.com" },
                  ],
                },
              }
            : { id: "d1", message: { id: "m2" } },
      });
      await call(connection(), "create_draft", { body: "x", replyToMessageId: "m1" });
      const copied = parseMime(calls.at(-1)!.body.message.raw);
      expect(copied.headers["In-Reply-To"]).toContain(id.match(/<.*>/)![0]);
      expect(copied.headers["References"]).toContain("<a@example.com>");
      expect(calls.filter((entry) => entry.method === "POST")).toHaveLength(1);
    }
    const longIds = Array.from({ length: 40 }, (_, i) => `<${i}${"a".repeat(700)}@example.com>`);
    for (const [legacy, emitted] of [
      ['Your message of "Mon" <x@example.com>', "<x@example.com>"],
      ['Your message of "Mon"', undefined],
      ["<a@x><b@x>", "<a@x>\r\n <b@x>"],
      ["<a@x>\r\n <b@x>\r\n \r\n ", "<a@x>\r\n <b@x>"],
      [`(${"comment".repeat(1000)}) <x@example.com>`, "<x@example.com>"],
      [longIds.join(" "), longIds.join("\r\n ")],
    ] as const) {
      calls.length = 0;
      route = (request) => ({
        body:
          request.method === "GET"
            ? {
                id: "d1",
                message: {
                  id: "m1",
                  payload: { mimeType: "text/plain", headers: [{ name: "In-Reply-To", value: legacy }] },
                },
              }
            : { id: "d1", message: { id: "m2" } },
      });
      await call(connection(), "update_draft", { draftId: "d1", body: "x" });
      const kept = parseMime(calls.at(-1)!.body.message.raw);
      expect(kept.headers["In-Reply-To"]).toBe(emitted?.replace(/\r\n /g, " "));
      if (emitted) expect(kept.source).toContain(`In-Reply-To: ${emitted}\r\n`);
      else expect(kept.source).not.toContain("In-Reply-To:");
      const headers = kept.source.split("\r\n\r\n")[0]!.split("\r\n");
      expect(headers.every((line) => line.length <= 998)).toBe(true);
      expect(headers).not.toContain(" ");
      expect(calls.filter((entry) => entry.method === "PUT")).toHaveLength(1);
    }
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

    // Redaction must not hide an attachment or a kept header and allow its deletion.
    const keptHeaders = [
      { name: "Subject", value: "Kept subject" },
      { name: "References", value: "<m1@mail.example>" },
      { name: "In-Reply-To", value: "<m1@mail.example>" },
    ];
    const keptNames = ["Subject", "References", "In-Reply-To", "Reply"];
    for (const privateValue of [
      "attachment",
      "attach",
      "tachm",
      "ment",
      "Content-Disposition",
      "Disposition",
      "Dispo",
      "sition",
      "Content",
      ...keptNames,
    ]) {
      calls.length = 0;
      storage = memoryStorage();
      route = () => ({
        body: existingDraft(
          keptNames.includes(privateValue) ? keptHeaders : [],
          keptNames.includes(privateValue)
            ? undefined
            : [
                { mimeType: "text/plain", body: { data: b64url("Body") } },
                {
                  mimeType: "text/plain",
                  headers: [{ name: "Content-Disposition", value: "attachment" }],
                  body: { data: b64url("Attached notes") },
                },
              ],
        ),
      });
      const ctx = context();
      requestSentSecrets(ctx).arguments(
        { private: privateValue },
        { type: "object", properties: { private: { type: "string", writeOnly: true } } },
      );
      await expect(
        connection().callTool("update_draft", { draftId: "d1", body: "Revised." }, ctx),
      ).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("Nothing was changed"),
      });
      expect(calls.map((entry) => entry.method)).toEqual(["GET"]);
    }
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
    storage = memoryStorage();
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
    expect(result.truncated).toContain("body");
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

  it("INV-5/INV-11: pins eleven read verdicts, three hatches, full MIME safety and zero-send refusals", async () => {
    expect(index.pathMatching).toBe("uri-template");
    expect(index.ops).toHaveLength(79);
    expect(Object.values(verdicts).filter((v) => v === "read")).toHaveLength(11);
    expect(Object.keys(verdicts).sort()).toEqual(index.ops.map((op) => `${op.method} ${op.path}`).sort());
    // Exercise the resolver used at runtime, including named-only writer exceptions.
    for (const op of index.ops) {
      const key = `${op.method} ${op.path}` as keyof typeof verdicts;
      const path = op.path.replace(/\{[^}]+\}/g, "item1");
      if (verdicts[key] === "read" || key === "POST /drafts" || key === "PUT /drafts/{id}")
        expect(safety.reviewed!.resolve!(op.method, path)).toBeTruthy();
      else expect(() => safety.reviewed!.resolve!(op.method, path)).toThrow(refusalReasons[key]);
    }
    for (const [key, verdict] of Object.entries(verdicts))
      if (verdict === "refuse") {
        expect(refusalReasons[key]).toBeTruthy();
        const summary = index.ops.find((op) => `${op.method} ${op.path}` === key)!.summary;
        expect(summary).toMatch(/^Refused: /);
        expect(summary).toContain("create_draft");
        expect(summary).toContain("update_draft");
        expect(summary.length).toBeLessThanOrEqual(120);
      }
    const c = connection();
    const tools = await c.listTools(context());
    expect(tools).toHaveLength(12);
    expect(
      tools
        .filter((t) => t.name.startsWith("gmail_api_"))
        .map((t) => t.name)
        .sort(),
    ).toEqual(["gmail_api_details", "gmail_api_read", "gmail_api_search"]);
    expect(JSON.stringify(skill)).not.toContain("gmail_api_write");
    await expect(call(c, "get_message", { messageId: "m1", raw: true })).rejects.toMatchObject({
      code: "invalid_args",
    });
    for (const path of [
      "/settings/sendAs",
      "/messages/%2e%2e/profile",
      "https://gmail.googleapis.com/gmail/v1/users/bob/messages",
      "/users/bob/messages",
    ]) {
      await expect(call(c, "gmail_api_read", { path })).rejects.toMatchObject({ code: "invalid_args" });
    }
    for (const query of [
      { userId: "bob" },
      { access_token: "foreign" },
      { pageToken: "raw" },
      { alt: "media" },
      { maxResults: 501 },
    ])
      await expect(call(c, "gmail_api_read", { path: "/messages", query })).rejects.toMatchObject({
        code: "invalid_args",
      });
    await expect(call(c, "gmail_api_read", { path: "/messages/m1", fields: ["notAField"] })).rejects.toMatchObject({
      code: "invalid_args",
    });
    for (const path of ["/messages/send", "/drafts/send"]) {
      expect(() => safety.reviewed!.resolve!("POST", path)).toThrow("Sending is never available");
      // A schema-valid read must also refuse these literal routes before auth/I/O.
      await expect(call(c, "gmail_api_read", { path })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    route = () => ({ body: MESSAGE });
    await expect(call(c, "gmail_api_read", { path: "/messages/m2", query: { format: "full" } })).resolves.toMatchObject(
      { status: 200, data: MESSAGE },
    );
    expect(calls.at(-1)!.url.pathname).toBe("/gmail/v1/users/me/messages/m2");
    // Indexed draft discovery names the safe alternative; no generic writer exists.
    const search = await call(c, "gmail_api_search", { query: "draft reply" });
    expect(JSON.stringify(search)).toContain("create_draft");
    for (const [query, operation] of [
      ["find unread messages", "GET /messages"],
      ["search unread threads by sender subject date", "GET /threads"],
      ["read thread messages and labels", "GET /threads/{id}"],
      ["list mailbox labels and names", "GET /labels"],
      ["read label message counts", "GET /labels/{id}"],
      ["find saved drafts", "GET /drafts"],
      ["read saved draft headers", "GET /drafts/{id}"],
      ["read full message MIME metadata", "GET /messages/{id}"],
      ["send mail", "POST /messages/send"],
      ["send draft", "POST /drafts/send"],
      ["message headers", "GET /messages/{id}"],
      ["read message attachments", "GET /messages/{messageId}/attachments/{id}"],
      ["draft reply", "POST /drafts"],
      ["edit draft", "PUT /drafts/{id}"],
      ["mailbox profile", "GET /profile"],
      ["mail history", "GET /history"],
      ["read RFC header", "GET /messages/{id}"],
      ["custom RFC headers", "GET /messages/{id}"],
      ["search mail", "GET /messages"],
      ["reply to email", "POST /drafts"],
    ])
      for (const method of [undefined, operation!.split(" ")[0] as "GET" | "POST" | "PUT"])
        expect(
          index
            .search(query!, { limit: 2, partial: true, ...(method ? { method } : {}) })
            .map((op) => `${op.method} ${op.path}`),
        ).toContain(operation);
    for (const [query, operation] of [
      ["read RFC header", "GET /messages/{id}"],
      ["search mail", "GET /messages"],
      ["reply to email", "POST /drafts"],
    ]) {
      const first = index.search(query!, { limit: 1, partial: true })[0]!;
      expect(`${first.method} ${first.path}`).toBe(operation);
    }
    // Exercise the hatch's intent/ranking layer, not only the underlying index.
    const history = await call(c, "gmail_api_search", { query: "mail history" });
    expect(
      history.operations.slice(0, 2).map((op: { method: string; path: string }) => `${op.method} ${op.path}`),
    ).toContain("GET /history");
    route = (request) => ({
      body: request.url.searchParams.has("pageToken")
        ? { messages: [{ id: "m2" }], nextPageToken: "" }
        : { messages: [], nextPageToken: "next-mail" },
    });
    const first = await call(c, "gmail_api_read", {
      path: "/messages",
      query: { maxResults: 1, fields: "messages/id" },
      fields: ["messages.id"],
    });
    expect(first).toMatchObject({ data: { messages: [] }, page: { hasMore: true } });
    expect(calls.at(-1)!.url.searchParams.get("fields")).toContain("nextPageToken");
    const last = await call(c, "gmail_api_read", {
      path: "/messages",
      query: { maxResults: 1, fields: "messages/id" },
      fields: ["messages.id"],
      cursor: first.page.nextCursor,
    });
    expect(last).toMatchObject({ data: { messages: [{ id: "m2" }] }, page: { hasMore: false } });
    expect(last.page).not.toHaveProperty("nextCursor");
    await expect(
      call(c, "gmail_api_read", { path: "/messages", query: { maxResults: 1 }, cursor: first.page.nextCursor }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    route = () => ({
      body: {
        labels: [
          { id: "L1", name: "First", type: "user" },
          { id: "L2", name: "Second", type: "user" },
        ],
      },
    });
    const labels = await call(c, "list_labels", { fields: ["id"] });
    expect(labels.items).toEqual([{ id: "L1" }, { id: "L2" }]);
    expect(labels.page).toEqual({ hasMore: false });
    route = () => ({ body: { labels: Array.from({ length: 40 }, (_, i) => ({ id: `L${i}`, name: `Label ${i}` })) } });
    const beforeLabels = calls.length;
    expect((await call(c, "list_labels")).items).toHaveLength(40);
    expect(calls).toHaveLength(beforeLabels + 1);
    route = () => ({
      body: {
        labels: [
          { id: "L".repeat(5000), name: "Cannot address" },
          { id: "valid", name: "x".repeat(1000), type: "user" },
        ],
      },
    });
    const clippedLabels = await call(c, "list_labels", { fields: ["id"] });
    expect(clippedLabels.truncated).toEqual(expect.arrayContaining(["items[]", "items[].name"]));
    expect(clippedLabels.items[0].id).toBe("valid");

    // Every named read retains size provenance when fields omit the cut value.
    const longMessage = {
      id: "m1",
      threadId: "t1",
      payload: {
        mimeType: "text/plain",
        headers: [{ name: "Subject", value: "x".repeat(10000) }],
        body: { size: 100, data: b64url("x".repeat(100)) },
      },
    };
    route = (request) => ({
      body: request.url.pathname.endsWith("/threads")
        ? { threads: [{ id: "t1" }] }
        : request.url.pathname.endsWith("/threads/t1")
          ? { id: "t1", messages: [longMessage] }
          : request.url.pathname.endsWith("/drafts")
            ? { drafts: [{ id: "d1" }] }
            : request.url.pathname.endsWith("/drafts/d1")
              ? { id: "d1", message: longMessage }
              : longMessage,
    });
    for (const [tool, args, selected, cut] of [
      ["get_thread", { threadId: "t1", maxBodyChars: 1 }, "id", "messages[].body"],
      ["get_message", { messageId: "m1", maxBodyChars: 1 }, "id", "body"],
      ["get_draft", { draftId: "d1", maxBodyChars: 1 }, "draftId", "body"],
      ["search_threads", {}, "id", "items[].subject"],
      ["list_drafts", {}, "draftId", "items[].subject"],
    ] as const) {
      const narrowed = await call(c, tool, { ...args, fields: [selected] });
      expect(narrowed.truncated).toContain(cut);
      if (narrowed.items) expect(Object.keys(narrowed.items[0])).toEqual([selected]);
      else
        expect(Object.keys(narrowed).sort()).toEqual(
          [selected, "truncated", ...(tool === "get_thread" ? ["page"] : [])].sort(),
        );
      const before = calls.length;
      await expect(call(c, tool, { ...args, fields: ["unknown"] })).rejects.toMatchObject({ code: "invalid_args" });
      expect(calls).toHaveLength(before);
    }
    route = () => ({
      body: {
        id: "m1",
        payload: {
          mimeType: "multipart/mixed",
          parts: [
            {
              ...attachmentFixtures.csv,
              body: { size: 100, data: b64url("x".repeat(100)) },
            },
          ],
        },
      },
    });
    const attachment = await call(c, "get_attachment", {
      messageId: "m1",
      partId: "1",
      maxChars: 1,
      fields: ["partId"],
    });
    expect(attachment).toEqual({ partId: "1", truncated: expect.arrayContaining(["content"]) });
    const beforeAttachment = calls.length;
    await expect(
      call(c, "get_attachment", { messageId: "m1", partId: "1", fields: ["unknown"] }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(beforeAttachment);

    let nested: Record<string, unknown> = { mimeType: "text/plain", body: { data: b64url("token"), size: 5 } };
    for (let depth = 0; depth < 42; depth++) nested = { mimeType: "multipart/mixed", parts: [nested] };
    route = () => ({ body: { id: "m1", payload: nested } });
    await expect(call(c, "gmail_api_read", { path: "/messages/m1" })).rejects.toMatchObject({
      code: "connector_call_failed",
    });

    // A valid inline body may be much larger than its projected result. The
    // encoded-field validator must stay linear instead of exhausting V8's stack.
    const bytes = 4 * 1024 * 1024;
    route = () => ({
      body: { id: "m4", payload: { mimeType: "text/plain", body: { size: bytes, data: b64url("x".repeat(bytes)) } } },
    });
    const projected = await call(connection(), "get_message", { messageId: "m4", maxBodyChars: 100 });
    expect(projected.body).toContain("x".repeat(100));
    expect(projected.truncated).toContain("body");
    expect(size(projected)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });
});

describe("round-5 bounds: identifiers, wrappers, and cursors", () => {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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
      const first = await page({ fields: ["messages.id"] });
      const cursor = first.page.nextCursor;
      await expect(page({ threadId: "t2", cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(page({ maxBodyChars: 99_999, cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(call(connection(), "list_labels", { cursor })).rejects.toMatchObject({ code: "invalid_args" });
      await expect(page({ cursor: "bm90LWEtY3Vyc29y" })).rejects.toMatchObject({
        code: "invalid_args",
        message: expect.stringContaining("cursor belongs to a different call"),
      });
      const mapped = connection({
        subject: (identity: { principal?: { id: string } }) => `${identity.principal?.id}@example.com`,
      });
      const registry = makeRegistry([mapped], { storage });
      const delegatedContext = (caller: ConnectorCaller) =>
        registry.scoped({ connectorIds: "all", caller }).contextFor("mail", "https://connecta.example");
      const actorCall = (actor: string, tool: string, args: Record<string, unknown>) =>
        mapped.callTool(
          tool,
          args,
          delegatedContext({
            authenticated: true,
            identity: {
              actor: { kind: "user", id: actor },
              principal: { namespace: "fixture", id: actor },
              interactive: true,
            },
          }),
        ) as Promise<any>;
      const named = await actorCall("alice", "get_thread", { threadId: "t1", maxBodyChars: 100000 });
      const beforeNamed = calls.length;
      await expect(
        actorCall("bob", "get_thread", { threadId: "t1", maxBodyChars: 100000, cursor: named.page.nextCursor }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      expect(calls).toHaveLength(beforeNamed);
      await expect(
        actorCall("alice", "get_thread", { threadId: "t1", maxBodyChars: 100000, cursor: named.page.nextCursor }),
      ).resolves.toHaveProperty("messages");
      const poolCall = (owner: string, tool: string, args: Record<string, unknown>) =>
        mapped.callTool(
          tool,
          args,
          delegatedContext({
            authenticated: true,
            pool: "notes",
            poolOwner: `${owner}@example.com`,
            identity: { actor: { kind: "agent", id: "assistant" }, agent: "assistant", interactive: false },
          }),
        ) as Promise<any>;
      const poolNamed = await poolCall("alice", "get_thread", { threadId: "t1", maxBodyChars: 100000 });
      const beforePool = calls.length;
      await expect(
        poolCall("bob", "get_thread", { threadId: "t1", maxBodyChars: 100000, cursor: poolNamed.page.nextCursor }),
      ).rejects.toMatchObject({ code: "invalid_args" });
      expect(calls).toHaveLength(beforePool);
      // Shared binding rejects hatch continuations across both delegated callers and pool owners.
      route = () => ({ body: { messages: [], nextPageToken: "mail-next" } });
      for (const delegatedCall of [actorCall, poolCall]) {
        const indexed = await delegatedCall("alice", "gmail_api_read", { path: "/messages", query: { maxResults: 1 } });
        const beforeHatch = calls.length;
        await expect(
          delegatedCall("bob", "gmail_api_read", {
            path: "/messages",
            query: { maxResults: 1 },
            cursor: indexed.page.nextCursor,
          }),
        ).rejects.toMatchObject({ code: "invalid_args" });
        expect(calls).toHaveLength(beforeHatch);
      }
    });

    it("answers conflict when an earlier message is changed, added or removed", async () => {
      const first = await page({});
      const cursor = first.page.nextCursor;
      const returned = first.messages.map((entry: { id: string }) => entry.id);
      expect(returned[0]).toBe("m1");

      messages[0] = { ...messages[0]!, payload: { ...messages[0]!.payload, body: { data: b64url("changed") } } };
      await expect(page({ cursor })).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("thread changed"),
      });

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
  });

  it("bounds an unpaged label list and reports omissions without a continuation", async () => {
    const labels = Array.from({ length: 3000 }, (_, index) => ({
      id: `Label_${index}`,
      name: "x".repeat(200),
      type: "user",
    }));
    route = () => ({ body: { labels } });
    const first = await call(connection(), "list_labels");
    expect(first.page).toEqual({ hasMore: false });
    expect(first.truncated).toContain("items[]");
    expect(first.items.length).toBeLessThan(labels.length);
    expect(size(first)).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
    expect(calls).toHaveLength(1);
    const complete = await call(connection(), "gmail_api_read", { path: "/labels" });
    expect(complete.data.labels).toEqual(labels);
    expect(calls).toHaveLength(2);
  });
});

describe("round-6: measured budgets, said omissions, declared keys", () => {
  it("reports a saved draft as saved even when Gmail's id cannot be returned", async () => {
    const restoreTransport = installOwnedTransport();
    try {
      route = () => ({ body: { id: "D".repeat(5000), message: { id: "m1", threadId: "t1" } } });
      const tooLong = await call(connection(), "create_draft", { body: "x" });
      expect(tooLong).toMatchObject({ saved: true, sent: false, messageId: "m1", truncated: ["draftId"] });
      expect(tooLong.draftId).toBeUndefined();
      expect(tooLong.note).toContain("list_drafts");
      expect(tooLong.note).toContain("do not create it again");

      route = () => ({ body: { message: { id: "m2" } } });
      const missing = await call(connection(), "create_draft", { body: "x" });
      expect(missing).toMatchObject({ saved: true, sent: false, messageId: "m2" });
      expect(missing.truncated).toBeUndefined();
      expect(missing.note).toContain("list_drafts");
      expect(restoreTransport.send).toHaveBeenCalledTimes(2);
      expect(calls.map(({ method }) => method)).toEqual(["POST", "POST"]);
    } finally {
      restoreTransport.restore();
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

  it("checks actual bytes too when declared size understates the binary", async () => {
    serve(attachmentFixtures.pdf, b64url("x".repeat(150_000)));
    await expect(read({ partId: "5" })).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
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
    expect(result.truncated).toContain("content");
    expect(result.content).toContain("truncated");
    expect(result.content.match(/more characters truncated/g)).toHaveLength(1);
    expect(size(result)).toBeLessThanOrEqual(64 * 1024);
  });

  it("refuses malformed encoding and unknown forwarded sizes, and explains unreadable forwarded text", async () => {
    serve(attachmentFixtures.csv, "!");
    await expect(read({ partId: "1" })).rejects.toMatchObject({ code: "connector_call_failed", retryable: false });
    calls.length = 0;

    serve({
      ...attachmentFixtures.parsedForwarded,
      parts: [{ mimeType: "image/png", body: { size: 2, data: "__4" } }],
    });
    expect(await read({ partId: "7" })).toMatchObject({
      format: "unavailable",
      note: expect.stringContaining("no readable"),
    });
    calls.length = 0;

    serve({
      ...attachmentFixtures.parsedForwarded,
      parts: [
        { mimeType: "text/plain", body: { size: 2, attachmentId: "body" } },
        { mimeType: "image/png", body: { attachmentId: "image" } },
      ],
    });
    expect(await read({ partId: "7" })).toMatchObject({
      format: "unavailable",
      note: expect.stringContaining("valid attachment size"),
    });
    expect(calls).toHaveLength(1);
  });
});
