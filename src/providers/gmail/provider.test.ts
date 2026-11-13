import { PRIVATE_KEY } from "../../../test/fixtures/rsa.js";
// Gmail fixture regressions cover MIME composition (drafts, sends, replies and
// forwards), mailbox writes, refusals, body selection, charsets, attachments
// and bounds. Delegation, subjects and tokens are covered
// by test/google-workspace-delegation.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installOwnedTransport } from "../../../test/fixtures/owned-transport.js";
import { requestSentSecrets } from "../../sent-secrets.js";
import { gmail } from "./index.js";
import { verdicts } from "./lib/index.js";
import { refuseWithheldRaw } from "./lib/raw.js";
import type { ConnectorCaller } from "../../connector-caller.js";
import { safety } from "./api.js";
import { attachmentFixtures } from "./fixtures.js";
import { RESULT_BUDGET_BYTES } from "../_shared/google/result-size.js";
import { memoryStorage } from "../../storage/memory.js";
import { makeRegistry, silentLogger } from "../../../test/helpers.js";
import { createMetaTools } from "../../meta-tools.js";
import { routeNames } from "../../agent-routes.js";
import type { AgentRouteNames } from "../../types.js";
import type { Connector, ConnectorContext } from "../../types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

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

describe("sending and organizing mail", () => {
  beforeEach(() => {
    installOwnedTransport();
  });
  const sent = (request: ApiCall) =>
    request.method === "POST" && request.url.pathname.endsWith("/messages/send")
      ? { body: { id: "s1", threadId: request.body?.threadId ?? "s1", labelIds: ["SENT"] } }
      : undefined;
  const writes = () => calls.filter((entry) => entry.method !== "GET");

  it("classifies every write, and sends and permanent deletes as destructive", async () => {
    const tools = await connection().listTools(context());
    const annotation = (name: string) => tools.find((tool) => tool.name === name)?.annotations;
    for (const name of [
      "send_message",
      "forward_message",
      "send_draft",
      "delete_draft",
      "delete_message",
      "delete_thread",
      "batch_delete_messages",
      "trash_message",
      "update_message_labels",
      "delete_label",
      "create_filter",
      "update_vacation",
      "gmail_api_write",
    ])
      expect(annotation(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of ["create_label", "restore_message", "restore_thread", "create_draft"])
      expect(annotation(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const name of ["list_filters", "get_vacation"])
      expect(annotation(name), name).toMatchObject({ readOnlyHint: true });
    for (const name of ["send_message", "forward_message", "send_draft"])
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(/Irreversible/);
    for (const name of ["delete_message", "delete_thread", "batch_delete_messages", "delete_draft"])
      expect(tools.find((tool) => tool.name === name)!.description).toMatch(/permanently|Permanently/);
  });

  it("holds the complete reviewed verdict table: only additive creates and restores are plain writes", () => {
    const by = (verdict: string) =>
      Object.entries(verdicts)
        .filter(([, value]) => value === verdict)
        .map(([key]) => key);
    expect(Object.keys(verdicts)).toHaveLength(79);
    expect(by("read")).toEqual(Object.keys(verdicts).filter((key) => key.startsWith("GET ")));
    expect(by("read")).toHaveLength(30);
    expect(by("write")).toEqual([
      "POST /drafts",
      "POST /labels",
      "POST /messages",
      "POST /messages/{id}/untrash",
      "POST /threads/{id}/untrash",
    ]);
    expect(by("destructive")).toEqual([
      "POST /drafts/send",
      "DELETE /drafts/{id}",
      "PUT /drafts/{id}",
      "DELETE /labels/{id}",
      "PATCH /labels/{id}",
      "PUT /labels/{id}",
      "POST /messages/batchDelete",
      "POST /messages/batchModify",
      "POST /messages/import",
      "POST /messages/send",
      "DELETE /messages/{id}",
      "POST /messages/{id}/modify",
      "POST /messages/{id}/trash",
      "PUT /settings/autoForwarding",
      "POST /settings/cse/identities",
      "DELETE /settings/cse/identities/{cseEmailAddress}",
      "PATCH /settings/cse/identities/{emailAddress}",
      "POST /settings/cse/keypairs",
      "POST /settings/cse/keypairs/{keyPairId}:disable",
      "POST /settings/cse/keypairs/{keyPairId}:enable",
      "POST /settings/cse/keypairs/{keyPairId}:obliterate",
      "POST /settings/delegates",
      "DELETE /settings/delegates/{delegateEmail}",
      "POST /settings/filters",
      "DELETE /settings/filters/{id}",
      "POST /settings/forwardingAddresses",
      "DELETE /settings/forwardingAddresses/{forwardingEmail}",
      "PUT /settings/imap",
      "PUT /settings/language",
      "PUT /settings/pop",
      "POST /settings/sendAs",
      "DELETE /settings/sendAs/{sendAsEmail}",
      "PATCH /settings/sendAs/{sendAsEmail}",
      "PUT /settings/sendAs/{sendAsEmail}",
      "POST /settings/sendAs/{sendAsEmail}/smimeInfo",
      "DELETE /settings/sendAs/{sendAsEmail}/smimeInfo/{id}",
      "POST /settings/sendAs/{sendAsEmail}/smimeInfo/{id}/setDefault",
      "POST /settings/sendAs/{sendAsEmail}/verify",
      "PUT /settings/vacation",
      "POST /stop",
      "DELETE /threads/{id}",
      "POST /threads/{id}/modify",
      "POST /threads/{id}/trash",
      "POST /watch",
    ]);
  });

  it("sends a new message as RFC 2822 base64url raw, once, and refuses one without recipients before IO", async () => {
    await expect(call(connection(), "send_message", { subject: "Hi", body: "x" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    expect(calls).toEqual([]);
    route = sent;
    const result = await call(connection(), "send_message", {
      to: ["Ann Elder <ann@church.example>"],
      cc: ["bob@church.example"],
      subject: "Café plans",
      body: "See you at 7.",
      htmlBody: "<p>See you at <b>7</b>.</p>",
    });
    expect(result).toEqual({ messageId: "s1", threadId: "s1", labelIds: ["SENT"], sent: true });
    expect(writes()).toHaveLength(1);
    expect(path(0)).toBe("/messages/send");
    expect(calls[0]!.body).not.toHaveProperty("threadId");
    const mime = parseMime(calls[0]!.body.raw);
    expect(calls[0]!.body.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mime.headers).toMatchObject({
      To: "Ann Elder <ann@church.example>",
      Cc: "bob@church.example",
      Subject: "=?UTF-8?B?Q2Fmw6kgcGxhbnM=?=",
      "MIME-Version": "1.0",
    });
    expect(mime.headers).not.toHaveProperty("From");
    expect(mime.parts).toEqual([
      { type: 'text/plain; charset="UTF-8"', text: "See you at 7." },
      { type: 'text/html; charset="UTF-8"', text: "<p>See you at <b>7</b>.</p>" },
    ]);
  });

  it("replies in thread with In-Reply-To, References, Re: subject and the Reply-To recipient", async () => {
    route = (request) =>
      sent(request) ?? {
        body: {
          id: "m2",
          threadId: "t1",
          payload: {
            headers: [
              { name: "Subject", value: "Elders meeting" },
              { name: "From", value: "Ann Elder <ann@church.example>" },
              { name: "Reply-To", value: "elders@church.example" },
              { name: "Message-ID", value: "<m2@mail.example>" },
              { name: "References", value: "<m0@mail.example> <m1@mail.example>" },
            ],
          },
        },
      };
    await call(connection(), "send_message", { replyToMessageId: "m2", body: "Yes, 7pm works." });
    expect(calls.map((entry) => `${entry.method} ${entry.url.pathname.replace("/gmail/v1/users/me", "")}`)).toEqual([
      "GET /messages/m2",
      "POST /messages/send",
    ]);
    expect(calls[0]!.url.searchParams.get("format")).toBe("metadata");
    expect(calls[1]!.body.threadId).toBe("t1");
    const mime = parseMime(calls[1]!.body.raw);
    expect(mime.headers).toMatchObject({
      To: "elders@church.example",
      Subject: "Re: Elders meeting",
      "In-Reply-To": "<m2@mail.example>",
      References: "<m0@mail.example> <m1@mail.example> <m2@mail.example>",
    });
    expect(mime.parts[0]!.text).toBe("Yes, 7pm works.");
  });

  it("forwards the original's exact bytes as an attached message in its thread", async () => {
    const original =
      "From: Ann Elder <ann@church.example>\r\nTo: pastor@church.example\r\nSubject: Agenda\r\nMessage-ID: <m2@mail.example>\r\n" +
      'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nCafé agenda\r\n--b--\r\n';
    const bytes = new TextEncoder().encode(original);
    route = (request) => {
      const reply = sent(request);
      if (reply) return reply;
      if (request.url.searchParams.get("format") === "raw") return { body: { id: "m2", raw: b64url(original) } };
      return {
        body: {
          id: "m2",
          threadId: "t1",
          sizeEstimate: bytes.length,
          payload: {
            headers: [
              { name: "Subject", value: "Agenda" },
              { name: "Message-ID", value: "<m2@mail.example>" },
            ],
          },
        },
      };
    };
    const result = await call(connection(), "forward_message", {
      messageId: "m2",
      to: ["treasurer@church.example"],
      body: "FYI",
    });
    expect(result).toMatchObject({ messageId: "s1", sent: true });
    expect(calls.map((entry) => `${entry.method} ${entry.url.searchParams.get("format") ?? ""}`)).toEqual([
      "GET metadata",
      "GET raw",
      "POST ",
    ]);
    expect(writes()).toHaveLength(1);
    expect(calls[2]!.body.threadId).toBe("t1");
    const source = decodeRaw(calls[2]!.body.raw);
    const [head] = source.split("\r\n\r\n");
    expect(head).toContain("To: treasurer@church.example");
    expect(head).toContain("Subject: Fwd: Agenda");
    expect(head).toContain("In-Reply-To: <m2@mail.example>");
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="connecta-/);
    expect(source).toContain('Content-Type: message/rfc822; name="Agenda.eml"');
    expect(source).toContain('Content-Disposition: attachment; filename="Agenda.eml"');
    expect(source).toContain("Content-Transfer-Encoding: 8bit");
    // The original travels byte for byte, never re-encoded.
    expect(source).toContain(`8bit\r\n\r\n${original}--connecta-`);

    calls.length = 0;
    route = () => ({ body: { id: "m3", threadId: "t3", sizeEstimate: 3 * 1024 * 1024 + 1, payload: { headers: [] } } });
    await expect(
      call(connection(), "forward_message", { messageId: "m3", to: ["a@church.example"] }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it("removes Bcc and Resent-Bcc from the forwarded original's headers, keeping every other byte", async () => {
    const kept = [
      "From: Ann Elder <ann@church.example>\r\n",
      "To: pastor@church.example\r\n",
      "X-Bcc-Note: kept\r\n",
      "Subject: Agenda\r\n",
      "Message-ID: <m2@mail.example>\r\n",
    ];
    const blind = [
      "Bcc: hidden@church.example\r\n",
      "BCC: first@church.example,\r\n\tsecond@church.example,\r\n third@church.example\r\n",
      "resent-bcc: resent@church.example\r\n",
      "Bcc : obsolete@church.example\r\n",
      `Bcc${" ".repeat(13)}: spaced@church.example\r\n`,
      `Resent-Bcc${" ".repeat(7)}:\r\n\tfolded@church.example\r\n`,
      "bCc\t \t\t: tabbed@church.example\r\n",
      `RESENT-BCC${" \t".repeat(500)}:long@church.example,\r\n continued@church.example\r\n`,
    ];
    const body = "\r\nBcc: written in the body stays\r\nCafé\r\n";
    const original = kept.map((line, index) => line + blind.slice(index * 2, index * 2 + 2).join("")).join("") + body;
    route = (request) => {
      const reply = sent(request);
      if (reply) return reply;
      if (request.url.searchParams.get("format") === "raw") return { body: { id: "m2", raw: b64url(original) } };
      return { body: { id: "m2", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Agenda" }] } } };
    };
    await call(connection(), "forward_message", { messageId: "m2", to: ["treasurer@church.example"] });
    const source = decodeRaw(calls.at(-1)!.body.raw);
    const attached = source.slice(
      source.indexOf("8bit\r\n\r\n") + "8bit\r\n\r\n".length,
      source.lastIndexOf("--connecta-"),
    );
    expect(attached).toBe(kept.join("") + body);
    expect(source).not.toMatch(
      /hidden|first@|second@|third@|resent@|obsolete@|spaced@|folded@|tabbed@|long@|continued@/,
    );

    calls.length = 0;
    const bare = "From: ann@church.example\r\nX-Note: a\rBcc: hidden@church.example\r\nSubject: Agenda\r\n\r\nHi\r\n";
    route = (request) => {
      if (request.url.searchParams.get("format") === "raw") return { body: { id: "m2", raw: b64url(bare) } };
      return { body: { id: "m2", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Agenda" }] } } };
    };
    await expect(
      call(connection(), "forward_message", { messageId: "m2", to: ["treasurer@church.example"] }),
    ).rejects.toMatchObject({ code: "invalid_args", message: expect.stringMatching(/bare carriage return/) });
    expect(writes()).toEqual([]);
  });

  it("sends and deletes drafts by stable id", async () => {
    route = (request) =>
      request.url.pathname.endsWith("/drafts/send") ? { body: { id: "s9", threadId: "t9", labelIds: ["SENT"] } } : {};
    await expect(call(connection(), "send_draft", { draftId: "d1" })).resolves.toEqual({
      messageId: "s9",
      threadId: "t9",
      labelIds: ["SENT"],
      sent: true,
    });
    expect(calls[0]).toMatchObject({ method: "POST", body: { id: "d1" } });
    await expect(call(connection(), "delete_draft", { draftId: "d1" })).resolves.toEqual({
      draftId: "d1",
      deleted: true,
    });
    expect(calls[1]!.method).toBe("DELETE");
    expect(path(1)).toBe("/drafts/d1");
  });

  it("relabels, trashes, restores and permanently deletes with exactly one request each", async () => {
    await expect(call(connection(), "update_message_labels", { messageId: "m1" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await expect(
      call(connection(), "batch_update_message_labels", { messageIds: ["m1"], addLabelIds: [] }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
    route = (request) =>
      request.url.pathname.includes("/threads/")
        ? {
            body: {
              id: "t1",
              messages: [
                { id: "m1", labelIds: ["INBOX", "STARRED"] },
                { id: "m2", labelIds: ["Label_1"] },
              ],
            },
          }
        : { body: { id: "m1", threadId: "t1", labelIds: ["STARRED"] } };
    const cases: [string, Record<string, unknown>, string, string, unknown][] = [
      [
        "update_message_labels",
        { messageId: "m1", removeLabelIds: ["INBOX", "UNREAD"] },
        "POST",
        "/messages/m1/modify",
        { removeLabelIds: ["INBOX", "UNREAD"] },
      ],
      [
        "update_thread_labels",
        { threadId: "t1", addLabelIds: ["STARRED"] },
        "POST",
        "/threads/t1/modify",
        { addLabelIds: ["STARRED"] },
      ],
      [
        "batch_update_message_labels",
        { messageIds: ["m1", "m2", "m1"], addLabelIds: ["Label_1"] },
        "POST",
        "/messages/batchModify",
        { ids: ["m1", "m2"], addLabelIds: ["Label_1"] },
      ],
      ["trash_message", { messageId: "m1" }, "POST", "/messages/m1/trash", undefined],
      ["restore_message", { messageId: "m1" }, "POST", "/messages/m1/untrash", undefined],
      ["trash_thread", { threadId: "t1" }, "POST", "/threads/t1/trash", undefined],
      ["restore_thread", { threadId: "t1" }, "POST", "/threads/t1/untrash", undefined],
      ["delete_message", { messageId: "m1" }, "DELETE", "/messages/m1", undefined],
      ["delete_thread", { threadId: "t1" }, "DELETE", "/threads/t1", undefined],
      ["batch_delete_messages", { messageIds: ["m1", "m2"] }, "POST", "/messages/batchDelete", { ids: ["m1", "m2"] }],
    ];
    const results: Record<string, unknown> = {};
    for (const [tool, args, method, expected, body] of cases) {
      const before = calls.length;
      results[tool] = await call(connection(), tool, args);
      expect(calls.length - before, tool).toBe(1);
      expect(calls.at(-1)!.method, tool).toBe(method);
      expect(calls.at(-1)!.url.pathname.replace("/gmail/v1/users/me", ""), tool).toBe(expected);
      expect(calls.at(-1)!.body, tool).toEqual(body);
    }
    expect(results).toEqual({
      update_message_labels: { messageId: "m1", threadId: "t1", labelIds: ["STARRED"] },
      update_thread_labels: { threadId: "t1", messageCount: 2, labelIds: ["INBOX", "STARRED", "Label_1"] },
      batch_update_message_labels: { updated: 2 },
      trash_message: { messageId: "m1", threadId: "t1", labelIds: ["STARRED"] },
      restore_message: { messageId: "m1", threadId: "t1", labelIds: ["STARRED"] },
      trash_thread: { threadId: "t1", messageCount: 2, labelIds: ["INBOX", "STARRED", "Label_1"] },
      restore_thread: { threadId: "t1", messageCount: 2, labelIds: ["INBOX", "STARRED", "Label_1"] },
      delete_message: { messageId: "m1", deleted: true },
      delete_thread: { threadId: "t1", deleted: true },
      batch_delete_messages: { deleted: 2 },
    });
  });

  it("manages labels, filters and the vacation responder, keeping unstated vacation settings", async () => {
    route = (request) => {
      const at = request.url.pathname.replace("/gmail/v1/users/me", "");
      if (at === "/labels" || at === "/labels/Label_1")
        return {
          body: { id: "Label_1", name: request.body?.name ?? "Old", type: "user", labelListVisibility: "labelShow" },
        };
      if (at === "/settings/filters" && request.method === "GET")
        return {
          body: {
            filter: [{ id: "f1", criteria: { from: "ann@church.example" }, action: { addLabelIds: ["Label_1"] } }],
          },
        };
      if (at === "/settings/filters") return { body: { id: "f2", ...request.body } };
      if (at === "/settings/vacation" && request.method === "GET")
        return {
          body: {
            enableAutoReply: false,
            responseSubject: "Away",
            responseBodyPlainText: "Back Monday.",
            restrictToContacts: true,
            startTime: "1790000000000",
          },
        };
      if (at === "/settings/vacation") return { body: request.body };
      return {};
    };
    await expect(call(connection(), "create_label", { name: "Work/Clients" })).resolves.toMatchObject({
      id: "Label_1",
      name: "Work/Clients",
      type: "user",
    });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { name: "Work/Clients" } });
    await expect(call(connection(), "update_label", { labelId: "Label_1" })).rejects.toMatchObject({
      code: "invalid_args",
    });
    await call(connection(), "update_label", { labelId: "Label_1", name: "Renamed" });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { name: "Renamed" } });
    await expect(call(connection(), "delete_label", { labelId: "Label_1" })).resolves.toEqual({
      labelId: "Label_1",
      deleted: true,
    });
    expect(calls.at(-1)!.method).toBe("DELETE");

    await expect(call(connection(), "list_filters", { fields: ["id"] })).resolves.toEqual({
      items: [{ id: "f1" }],
      page: { hasMore: false },
    });
    const before = calls.length;
    await expect(
      call(connection(), "create_filter", { criteria: {}, action: { forward: "a@church.example" } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "create_filter", { criteria: { from: "ann@church.example" }, action: {} }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toHaveLength(before);
    await expect(
      call(connection(), "create_filter", {
        criteria: { from: "ann@church.example" },
        action: { removeLabelIds: ["INBOX"] },
      }),
    ).resolves.toEqual({ id: "f2", criteria: { from: "ann@church.example" }, action: { removeLabelIds: ["INBOX"] } });
    await call(connection(), "delete_filter", { filterId: "f2" });
    expect(calls.at(-1)!.method).toBe("DELETE");
    expect(calls.at(-1)!.url.pathname).toBe("/gmail/v1/users/me/settings/filters/f2");

    await expect(call(connection(), "get_vacation")).resolves.toEqual({
      enableAutoReply: false,
      responseSubject: "Away",
      responseBodyPlainText: "Back Monday.",
      restrictToContacts: true,
      startTime: new Date(1790000000000).toISOString(),
    });
    await expect(call(connection(), "update_vacation", {})).rejects.toMatchObject({ code: "invalid_args" });
    const updated = await call(connection(), "update_vacation", {
      enableAutoReply: true,
      endTime: "2026-12-01T00:00:00Z",
    });
    expect(calls.at(-1)).toMatchObject({
      method: "PUT",
      body: {
        enableAutoReply: true,
        responseSubject: "Away",
        responseBodyPlainText: "Back Monday.",
        restrictToContacts: true,
        startTime: "1790000000000",
        endTime: String(Date.parse("2026-12-01T00:00:00Z")),
      },
    });
    expect(updated).toMatchObject({ enableAutoReply: true, endTime: "2026-12-01T00:00:00.000Z" });
  });

  it("admits hatch writes once, refusing composed raw MIME that carries a withheld link before IO", async () => {
    const withheld = b64url("To: a@church.example\r\n\r\nSee https://example.com/doc?token=[redacted]\r\n");
    await expect(
      call(connection(), "gmail_api_write", { method: "POST", path: "/messages/send", body: { raw: withheld } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    await expect(
      call(connection(), "gmail_api_write", { method: "POST", path: "/drafts", body: { message: { raw: withheld } } }),
    ).rejects.toMatchObject({ code: "invalid_args" });
    expect(calls).toEqual([]);
    route = sent;
    const raw = b64url("To: a@church.example\r\nSubject: Hi\r\n\r\nHello\r\n");
    await expect(
      call(connection(), "gmail_api_write", { method: "POST", path: "/messages/send", body: { raw } }),
    ).resolves.toMatchObject({ status: 200, data: { id: "s1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ raw });
    route = () => ({ body: { id: "Label_9", name: "Hatch" } });
    await call(connection(), "gmail_api_write", { method: "PUT", path: "/settings/imap", body: { enabled: false } });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { enabled: false } });
  });

  it(
    "inspects every decoded MIME part for withheld links before IO, refusing what it cannot read",
    { timeout: 30_000 },
    async () => {
      const hatch = connection();
      const link = "See https://example.com/doc?token=[redacted]";
      const base64Part = b64url(link).replace(/-/g, "+").replace(/_/g, "/");
      const entity = (headers: string, content: string) => `${headers}\r\n\r\n${content}\r\n`;
      const multipart = (boundary: string, ...parts: string[]) =>
        `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\npreamble\r\n` +
        parts.map((part) => `--${boundary}\r\n${part}`).join("") +
        `--${boundary}--\r\n`;
      const message = (rest: string) => b64url(`To: a@church.example\r\nSubject: Hi\r\nMIME-Version: 1.0\r\n${rest}`);
      const plain = entity("Content-Type: text/plain", "Hello");
      const withheld = {
        base64: message(entity("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64", base64Part)),
        quotedPrintable: message(
          entity(
            "Content-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable",
            '<a href=3D"https://example.com/doc?tok=\r\nen=3D=5Bredacted=5D">doc</a>',
          ),
        ),
        nestedBase64: message(
          multipart(
            "outer",
            plain,
            multipart(
              "inner",
              plain,
              entity("Content-Type: text/plain\r\nContent-Transfer-Encoding: BASE64", base64Part),
            ),
          ),
        ),
        attachedMessage: message(
          multipart(
            "outer",
            plain,
            entity(
              "Content-Type: message/rfc822\r\nContent-Transfer-Encoding: base64",
              b64url(
                `Subject: Fwd\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${link.replace("=", "=3D")}\r\n`,
              )
                .replace(/-/g, "+")
                .replace(/_/g, "/"),
            ),
          ),
        ),
        encodedWord: b64url(`To: a@church.example\r\nSubject: =?UTF-8?B?${btoa(link)}?=\r\n\r\nHello\r\n`),
        splitEncodedWords: message(
          `Subject: See https://example.com/doc?token==?UTF-8?Q?=5Bre?= =?UTF-8?Q?dacted=5D?=\r\n${plain}`,
        ),
        foldedEncodedWords: message(
          `Subject: =?UTF-8?B?${btoa("See https://example.com/doc?token=[re")}?=\r\n\t =?ISO-8859-1?Q?dacted]?=\r\n${plain}`,
        ),
        quotedPairDisplayName: message(
          `Cc: "https://example.com/doc?token=[re\\dacted]" <b@church.example>\r\n${plain}`,
        ),
        quotedPairFilename: message(
          entity(
            'Content-Type: text/plain\r\nContent-Disposition: attachment; filename="https://example.com/doc?token=[re\\dacted]"',
            "Hello",
          ),
        ),
        quotedPairEncodedWord: message(
          `Subject: "=?UTF-8?Q?https://example.com/doc=3Ftoken=3D[re\\dacted]?\\="\r\n${plain}`,
        ),
        zeroPaddedReferences: message(
          entity(
            "Content-Type: text/html",
            '<a href="https://example.com/doc?token=&#0000000000091;redacted&#x000005D;">doc</a>',
          ),
        ),
        quotedPairTab: message(`Cc: "https://example.com/a?t=[re\\\tdacted]" <b@church.example>\r\n${plain}`),
        foldedDisplayName: message(`Cc: "https://example.com/a?t=[re\\dac\r\n\tted]" <b@church.example>\r\n${plain}`),
        textBeforeAttribute: message(
          entity("Content-Type: text/html", 'Text ="lead <a href="https://example.com/a?t=[re\tdacted]">doc</a>'),
        ),
        cssUrl: message(
          entity(
            "Content-Type: text/html",
            '<style>body { background: url("https://example.com/a?t=[re\tdacted]") }</style>',
          ),
        ),
        referencedTabBeforeParameter: message(
          entity("Content-Type: text/html", '<a href="https://example.com/a?x=1&Tab;&t=[redacted]">doc</a>'),
        ),
        mixedRun: message(
          entity(
            "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64",
            btoa('<a href="https://example.com/a?[\t&Tab;\tredacted]">doc</a>'),
          ),
        ),
        recipientWhitespace: message(
          entity(
            "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable",
            '<a href=3D"https://example.com/doc?token=3D[re\tdac&Tab;te\r\nd]">doc</a>',
          ),
        ),
      };
      const unreadable = {
        utf16: message(
          entity('Content-Type: text/plain; charset="UTF-16"\r\nContent-Transfer-Encoding: base64', "AFsAcgBlAGQ="),
        ),
        utf7: message(entity("Content-Type: text/plain; charset=utf-7", "+AFs-redacted+AF0-")),
        unknownEncoding: message(
          entity("Content-Type: text/plain\r\nContent-Transfer-Encoding: x-uuencode", "begin 644 x"),
        ),
        invalidBase64: message(
          entity("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64", "U2VlIGh0d*HBzOi8v"),
        ),
        encodedMultipart: message(
          "Content-Type: multipart/mixed; boundary=b\r\nContent-Transfer-Encoding: base64\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n",
        ),
        commentedType: message(
          `Content-Type: multipart/mixed (note); boundary=b\r\n\r\n--b\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Part}\r\n--b--\r\n`,
        ),
        bareCarriageReturn: message(`Content-Transfer-Encoding: base64\r${base64Part}\r\n`),
        continuedBoundary: message("Content-Type: multipart/mixed; boundary*0=b\r\n\r\n--b\r\n\r\nx\r\n--b--\r\n"),
        repeatedEncoding: message(
          entity("Content-Transfer-Encoding: 7bit\r\nContent-Transfer-Encoding: base64", base64Part),
        ),
        commentedBoundary: message(
          `Content-Type: multipart/mixed; boundary=b (note)\r\n\r\n--b\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Part}\r\n--b--\r\n`,
        ),
        commentedEncoding: message(entity("Content-Transfer-Encoding: base64 (note)", base64Part)),
        commentedDisposition: message(entity('Content-Disposition: attachment (x); filename="a.txt"', "Hello")),
        extendedFilename: message(entity("Content-Disposition: attachment; filename*=utf-8''a%5B.txt", "Hello")),
        repeatedParameter: message(
          `Content-Type: multipart/mixed; boundary=b; boundary=c\r\n\r\n--c\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Part}\r\n--c--\r\n--b--\r\n`,
        ),
        ambiguousDelimiter: message(
          `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b note\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Part}\r\n--b--\r\n`,
        ),
        iso2022Body: b64url(
          `To: a@church.example\r\nContent-Type: text/plain; charset=ISO-2022-JP\r\n\r\nSee https://example.com/doc?token=[re\x1b(Bdacted]\r\n`,
        ),
        iso2022Word: message(`Subject: =?ISO-2022-JP?Q?[re=1B(Bdacted]?=\r\n${plain}`),
        ...Object.fromEntries(
          ["Shift_JIS", "EUC-JP", "GB2312", "Big5", "UTF-32", "koi8-r"].map((charset) => [
            charset,
            message(entity(`Content-Type: text/plain; charset=${charset}`, "Hello")),
          ]),
        ),
        invalidUtf8: b64url(
          `To: a@church.example\r\n\r\nSee https://example.com/doc?token=[re\xffdacted]\r\n`,
          "latin1",
        ),
        strayQuotedPrintable: message(entity("Content-Transfer-Encoding: quoted-printable", "[re=zzdacted]")),
        noColon: message(`Hello there\r\n${plain}`),
        tooDeep: message(
          Array.from(
            { length: 10 },
            (_, level) => `Content-Type: multipart/mixed; boundary=b${level}\r\n\r\n--b${level}\r\n`,
          ).join("") + "\r\nx\r\n",
        ),
      };
      for (const [name, raw] of [...Object.entries(withheld), ...Object.entries(unreadable)]) {
        for (const [path, body] of [
          ["/messages/send", { raw }],
          ["/drafts/send", { message: { raw } }],
          ["/drafts", { message: { raw } }],
          ["/messages/import", { raw }],
        ] as const) {
          const refusal = await call(hatch, "gmail_api_write", { method: "POST", path, body }).then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refusal, `${name} ${path}`).toMatchObject({
            code: "invalid_args",
            message:
              name in withheld ? expect.stringMatching(/withheld/) : expect.stringMatching(/^Not sent: (?!.*withheld)/),
          });
        }
      }
      for (const name of ["send_message", "create_draft"])
        for (const args of [
          { body: link },
          { body: "Hi", htmlBody: `<a href="https://example.com/doc?token=&#91;redacted&#93;">doc</a>` },
          { subject: "See https://example.com/doc?token==?UTF-8?Q?=5Bre?= =?UTF-8?Q?dacted=5D?=" },
          { subject: "=?ISO-2022-JP?Q?[re=1B(Bdacted]?=" },
          { to: ['"https://example.com/doc?token=[re\\dacted]" <a@church.example>'] },
          { body: "Hi", htmlBody: '<a href="https://example.com/doc?token=&#0000000000091;redacted&#93;">doc</a>' },
          { body: "Hi", htmlBody: '<a href="https://example.com/doc?token=&lbrack;re\tdac&NewLine;ted&rsqb;">doc</a>' },
          { to: ['"https://example.com/a?t=[re\\\tdacted]" <a@church.example>'] },
          { body: "Hi", htmlBody: 'Text ="lead <a href="https://example.com/a?t=[re\tdacted]">doc</a>' },
          { body: "Hi", htmlBody: '<style>body { background: url("https://example.com/a?t=[re\tdacted]") }</style>' },
          { body: "Hi", htmlBody: '<a href="https://example.com/a?x=1&Tab;&t=[redacted]">doc</a>' },
          { body: "Hi", htmlBody: '<a href="https://example.com/a?[\t&Tab;\tredacted]">doc</a>' },
        ])
          await expect(
            call(connection(), name, { to: ["a@church.example"], subject: "Hi", ...args }),
            `${name} ${JSON.stringify(args)}`,
          ).rejects.toMatchObject({ code: "invalid_args" });
      expect(calls).toEqual([]);

      route = sent;
      const readable = message(
        `Subject: =?UTF-8?Q?Caf=C3=A9?= =?ISO-8859-1?Q?_cr=E8me?= notes\r\n` +
          `Cc: "O\\"Brien \\\\ [redacted] team" <b@church.example>\r\n` +
          `Content-Type: multipart/mixed;\r\n\tboundary="(outer) b";\r\n charset=us-ascii;\r\n\r\n` +
          `--(outer) b \t\r\n` +
          entity(
            'Content-Type: text/plain; charset="windows-1252"\r\nContent-Disposition: inline; filename="a (1).txt"',
            "Caf\u00e9",
          ) +
          `--(outer) b--\r\n`,
      );
      await expect(
        call(connection(), "gmail_api_write", { method: "POST", path: "/messages/send", body: { raw: readable } }),
      ).resolves.toMatchObject({ status: 200, data: { id: "s1" } });
      calls.length = 0;
      const mixed = message(
        multipart(
          "outer",
          entity(
            "Content-Type: text/plain; charset=ISO-8859-1\r\nContent-Transfer-Encoding: quoted-printable",
            "Caf=E9 =3D fine",
          ),
          entity(
            "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64",
            btoa("https://example.com/doc?token=abc"),
          ),
          entity("Content-Type: message/rfc822", "Subject: inner\r\n\r\nText [redacted] away from a link\r\n"),
          entity(
            "Content-Type: text/html",
            '<p title="Fish &amp; chips&#0000033;">See <a href="https://example.com/doc?token=abc&#0000038;x=1">\r\nthe\tredacted doc</a>\r\n[redacted]</p>',
          ),
        ),
      );
      await expect(
        call(connection(), "gmail_api_write", { method: "POST", path: "/messages/send", body: { raw: mixed } }),
      ).resolves.toMatchObject({ status: 200, data: { id: "s1" } });
      expect(calls).toHaveLength(1);
      for (const name of ["send_message", "create_draft"])
        await call(connection(), name, {
          to: ["a@church.example"],
          subject: "Hi",
          body: "https://example.com/a?t=1\n[redacted]",
        });
      expect(calls).toHaveLength(3);
    },
  );

  it("refuses a forward note whose subject splits a withheld link across encoded words, sending nothing", async () => {
    route = (request) => {
      if (request.url.searchParams.get("format") === "raw")
        return { body: { id: "m2", raw: b64url("Subject: Agenda\r\n\r\nHi\r\n") } };
      return { body: { id: "m2", threadId: "t1", payload: { headers: [{ name: "Subject", value: "Agenda" }] } } };
    };
    for (const subject of [
      "See https://example.com/doc?token==?UTF-8?Q?=5Bre?= =?UTF-8?Q?dacted=5D?=",
      "=?ISO-2022-JP?Q?[re=1B(Bdacted]?=",
    ])
      await expect(
        call(connection(), "forward_message", { messageId: "m2", to: ["treasurer@church.example"], subject }),
        subject,
      ).rejects.toMatchObject({ code: "invalid_args" });
    expect(writes()).toEqual([]);
  });

  it("inspects worst-case raw messages in linear time and bounds what it decodes", { timeout: 30_000 }, () => {
    const megabyte = 1024 * 1024;
    const hostile = {
      paddedDelimiter: `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nx\r\n--b${" ".repeat(megabyte)}X\r\n`,
      spacedLine: `Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\n${" ".repeat(megabyte)}X\r\n--b--\r\n`,
      softBreakPadding: `Content-Transfer-Encoding: quoted-printable\r\n\r\n${"=".padEnd(megabyte, " ")}X\r\n`,
      encodedWordStarts: `Subject: ${"=?".repeat(megabyte / 2)}\r\n\r\nx\r\n`,
      unclosedEncodedWords: `Subject: ${"=?a?B?x ".repeat(megabyte / 8)}?=\r\n\r\nx\r\n`,
      parameterPadding: `Content-Type: text/plain${" ".repeat(megabyte)};charset=utf-8\r\n\r\nx\r\n`,
      manyFields: `${"X-A: b\r\n".repeat(megabyte / 8)}\r\nx\r\n`,
      encodedWordFlood: `Subject: ${"=?utf-8?B?w6k=?= =?windows-1252?Q?=E9?= ".repeat(megabyte / 40)}\r\n\r\nx\r\n`,
      manyDelimiters: `Content-Type: multipart/mixed; boundary=b\r\n\r\n${"--b\r\n\r\n".repeat(megabyte / 8)}`,
    };
    for (const [name, source] of Object.entries(hostile)) {
      const raw = b64url(`To: a@church.example\r\n${source}`);
      const started = performance.now();
      refuseWithheldRaw({ raw });
      expect(performance.now() - started, name).toBeLessThan(1000);
    }
    expect(refuseWithheldRaw({ raw: b64url(`To: a@church.example\r\n${hostile.encodedWordFlood}`) })).toMatch(
      /more than 4096 encoded words/,
    );
    const oversized = new Uint8Array(17 * megabyte).fill(0x61);
    expect(refuseWithheldRaw({ raw: b64url(new TextDecoder().decode(oversized)) })).toMatch(/decodes to more than/);
  });

  it("withholds send-as SMTP passwords, S/MIME private material and CSE wrapped keys from settings reads", async () => {
    route = (request) => {
      const at = request.url.pathname.replace("/gmail/v1/users/me", "");
      if (at === "/settings/sendAs")
        return {
          body: {
            sendAs: [
              {
                sendAsEmail: "alias@church.example",
                signature: "<b>Pastor</b>",
                smtpMsa: { host: "smtp.example", username: "alias", password: "smtp-secret" },
              },
            ],
          },
        };
      if (at.endsWith("/smimeInfo"))
        return {
          body: {
            smimeInfo: [
              { id: "s1", pem: "-----BEGIN CERTIFICATE-----", pkcs12: "cHJpdmF0ZQ", encryptedKeyPassword: "pw" },
            ],
          },
        };
      return {
        body: {
          cseKeyPairs: [
            {
              keyPairId: "k1",
              pem: "-----BEGIN CERTIFICATE-----",
              privateKeyMetadata: [
                {
                  privateKeyMetadataId: "p1",
                  kaclsKeyMetadata: { kaclsUri: "https://kacls.example", kaclsData: "wrapped-key" },
                },
              ],
            },
          ],
        },
      };
    };
    const sendAs = await call(connection(), "gmail_api_read", { path: "/settings/sendAs" });
    expect(sendAs.data.sendAs[0]).toEqual({
      sendAsEmail: "alias@church.example",
      signature: "<b>Pastor</b>",
      smtpMsa: { host: "smtp.example", username: "alias", password: "[redacted]" },
    });
    const smime = await call(connection(), "gmail_api_read", {
      path: "/settings/sendAs/alias@church.example/smimeInfo",
    });
    expect(smime.data.smimeInfo[0]).toEqual({
      id: "s1",
      pem: "-----BEGIN CERTIFICATE-----",
      pkcs12: "[redacted]",
      encryptedKeyPassword: "[redacted]",
    });
    const cse = await call(connection(), "gmail_api_read", { path: "/settings/cse/keypairs" });
    expect(cse.data.cseKeyPairs[0].privateKeyMetadata[0]).toEqual({
      privateKeyMetadataId: "p1",
      kaclsKeyMetadata: { kaclsUri: "https://kacls.example", kaclsData: "[redacted]" },
    });
    expect(JSON.stringify([sendAs, smime, cse])).not.toMatch(/smtp-secret|wrapped-key|cHJpdmF0ZQ|"pw"/);
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

  it("INV-5 INV-11: preserves MIME data and refuses writes through the read hatch and foreign mailbox access before IO", async () => {
    const c = connection();
    await expect(call(c, "get_message", { messageId: "m1", raw: true })).rejects.toMatchObject({
      code: "invalid_args",
    });
    for (const path of [
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
      expect(safety.reviewed!.resolve!("POST", path)).toEqual({ method: "POST", template: path });
      // A send is a write: the read hatch refuses its literal route before auth/I/O.
      await expect(call(c, "gmail_api_read", { path })).rejects.toMatchObject({ code: "invalid_args" });
    }
    expect(calls).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    route = () => ({ body: MESSAGE });
    await expect(call(c, "gmail_api_read", { path: "/messages/m2", query: { format: "full" } })).resolves.toMatchObject(
      { status: 200, data: MESSAGE },
    );
    expect(calls.at(-1)!.url.pathname).toBe("/gmail/v1/users/me/messages/m2");
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

  it("words its truncation note as each surface reaches the tool, in whole phrases", async () => {
    serve({ ...attachmentFixtures.csv, body: { size: 100, attachmentId: "text" } }, b64url("x".repeat(100)));
    const note = (routes: AgentRouteNames) =>
      connection()
        .callTool("get_attachment", { messageId: "m1", partId: "1", maxChars: 10 }, { ...context(), routes })
        .then((result) => (result as { content: string }).content.slice(10));
    expect(await note(routeNames("meta"))).toBe(
      "\n[… 90 more characters truncated; raise maxChars or maxBytes for a direct call_tool, or open it in Gmail]",
    );
    for (const surface of ["native", "native-code"] as const)
      expect(await note(routeNames(surface)), surface).toBe(
        "\n[… 90 more characters truncated; raise maxChars or maxBytes when calling this tool directly, or open it in Gmail]",
      );
  });

  it("pages a stashed read whose truncation note names the route, reassembling every byte", async () => {
    const content = "abcdefghij".repeat(400);
    serve({ ...attachmentFixtures.csv, body: { size: content.length, attachmentId: "text" } }, b64url(content));
    const connector = connection();
    // A cap under the result stashes it; native paging reads it back in byte pages.
    const tools = createMetaTools(makeRegistry([connector], { maxResultBytes: 1_000 }), "https://connecta.test", {
      pagingTool: "read_result",
    });
    const called = await tools.callTool({
      address: "mail.get_attachment",
      args: { messageId: "m1", partId: "1", maxChars: 1_500 },
    });
    const notice = JSON.parse((called.content[0] as { text: string }).text.split("\n")[0]!);
    expect(notice).toMatchObject({ truncated: true, nextAction: { tool: "read_result" } });
    const pages: string[] = [];
    let offset = 0;
    for (;;) {
      const page = (await tools.readResult({ id: notice.resultId, offset, maxBytes: 3 })).structuredContent as {
        text: string;
        hasMore: boolean;
        nextOffset?: number;
      };
      pages.push(page.text);
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    const whole = pages.join("");
    expect(new TextEncoder().encode(whole).length).toBe(notice.totalBytes);
    const result = JSON.parse(whole);
    expect(result.content).toContain("raise maxChars or maxBytes for a direct call_tool, or open it in Gmail]");
    expect(result.content.startsWith(content.slice(0, 1_500))).toBe(true);
    // About 1,600 three-byte page reads; the default timeout trips under a loaded parallel run.
  }, 20_000);

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
