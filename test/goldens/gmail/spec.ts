import { gmail } from "../../../src/providers/gmail/index.js";
import { defineGoldenSpec, type SeenRequest, type StubResponse } from "../harness.js";

import { PRIVATE_KEY } from "../rsa-fixture.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ACCESS_TOKEN = "golden-google-access-token/gmail+=";

function b64url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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
      { name: "From", value: "Bob Elder <bob@example.com>" },
      { name: "To", value: "alice@example.com" },
      { name: "Subject", value: "Elders meeting" },
      { name: "Message-ID", value: "<m2@mail.example.com>" },
      { name: "In-Reply-To", value: "<m1@mail.example.com>" },
      { name: "References", value: "<m0@mail.example.com> <m1@mail.example.com>" },
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
      { mimeType: "application/pdf", filename: "agenda.pdf", body: { size: 12345, attachmentId: "att-1" } },
    ],
  },
};

const CSV = "name,email\nAlice,alice@example.com\n";

const DRAFT = { id: "d1", message: { ...MESSAGE, id: "m9", threadId: "t9", labelIds: ["DRAFT"] } };

const byPath =
  (routes: Record<string, StubResponse>) =>
  (request: SeenRequest): StubResponse | undefined => {
    const path = request.url.pathname.replace("/gmail/v1/users/me", "");
    return routes[`${request.method} ${path}`];
  };

const REASONS: Record<number, [status: string, reason: string]> = {
  400: ["INVALID_ARGUMENT", "badRequest"],
  401: ["UNAUTHENTICATED", "authError"],
  403: ["PERMISSION_DENIED", "forbidden"],
  404: ["NOT_FOUND", "notFound"],
  409: ["ALREADY_EXISTS", "conflict"],
  422: ["INVALID_ARGUMENT", "invalid"],
  429: ["RESOURCE_EXHAUSTED", "rateLimitExceeded"],
  500: ["INTERNAL", "backendError"],
};

export default defineGoldenSpec({
  provider: "gmail",
  // Delegated tokens are cached per service account for the process, so each
  // scenario names its own account and mints its own token.
  create: (scenario) => {
    return gmail("mail", {
      purpose: "Staff email for alice",
      serviceAccount: {
        clientEmail: `gmail-${scenario}@project.iam.gserviceaccount.com`,
        privateKey: PRIVATE_KEY,
      },
      subject: "alice@example.com",
    } as Parameters<typeof gmail>[1]);
  },
  secrets: { privateKey: PRIVATE_KEY, accessToken: ACCESS_TOKEN },
  auxiliary: [
    {
      name: "token",
      match: (request) => request.url.href === TOKEN_URL,
      reply: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: "Bearer" } },
    },
  ],
  failureReply: (status, message) => {
    const [canonical, reason] = REASONS[status] ?? ["UNKNOWN", "unknown"];
    return {
      status,
      body: { error: { code: status, message, errors: [{ message, domain: "global", reason }], status: canonical } },
    };
  },
  calls: [
    {
      tool: "search_threads",
      args: { query: "from:bob newer_than:7d", limit: 5, includeSpamTrash: true },
      replies: byPath({
        "GET /threads": {
          body: {
            threads: [{ id: "t1", snippet: "Latest &amp; greatest" }],
            nextPageToken: "next-1",
            resultSizeEstimate: 42,
          },
        },
        "GET /threads/t1": {
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
                    { name: "From", value: "Bob <bob@example.com>" },
                  ],
                },
              },
              {
                id: "m2",
                labelIds: ["INBOX", "UNREAD"],
                internalDate: "1790000600000",
                payload: { headers: [{ name: "From", value: "Alice <alice@example.com>" }] },
              },
            ],
          },
        },
      }),
    },
    { tool: "get_thread", args: { threadId: "t1" }, replies: [{ body: { id: "t1", messages: [MESSAGE] } }] },
    { tool: "get_message", args: { messageId: "m2", maxBodyChars: 11 }, replies: [{ body: MESSAGE }] },
    {
      label: "get_message raw",
      tool: "get_message",
      args: { messageId: "m2", raw: true },
      replies: [{ body: MESSAGE }],
    },
    {
      tool: "get_attachment",
      args: { messageId: "m1", partId: "1" },
      replies: byPath({
        "GET /messages/m1": {
          body: {
            id: "m1",
            payload: {
              mimeType: "multipart/mixed",
              parts: [
                {
                  partId: "1",
                  mimeType: "text/csv",
                  filename: "people.csv",
                  headers: [{ name: "Content-Type", value: "text/csv; charset=utf-8" }],
                  body: { attachmentId: "csv-current", size: new TextEncoder().encode(CSV).length },
                },
              ],
            },
          },
        },
        "GET /messages/m1/attachments/csv-current": { body: { data: b64url(CSV) } },
      }),
    },
    {
      tool: "list_labels",
      replies: [
        {
          body: {
            labels: [
              { id: "INBOX", name: "INBOX", type: "system", messageListVisibility: "show" },
              { id: "Label_7", name: "Elders", type: "user", color: { textColor: "#000000" } },
            ],
          },
        },
      ],
    },
    {
      tool: "list_drafts",
      args: { query: "subject:elders", limit: 3 },
      replies: byPath({
        "GET /drafts": { body: { drafts: [{ id: "d1", message: { id: "m9", threadId: "t9" } }] } },
        "GET /drafts/d1": { body: DRAFT },
      }),
    },
    { tool: "get_draft", args: { draftId: "d1" }, replies: [{ body: DRAFT }] },
    {
      tool: "create_draft",
      args: {
        to: ["Bob Elder <bob@example.com>", "carol@example.com"],
        cc: ["Smith, Dana <dana@example.com>"],
        subject: "Réunion des anciens",
        body: "Bonjour à tous,\nÀ mardi.",
        htmlBody: "<p>Bonjour à tous</p>",
      },
      replies: [{ body: { id: "d1", message: { id: "m1", threadId: "t1", labelIds: ["DRAFT"] } } }],
    },
    {
      label: "create_draft reply",
      tool: "create_draft",
      args: { replyToMessageId: "m2", body: "Yes, 7pm works." },
      replies: byPath({
        "GET /messages/m2": {
          body: {
            id: "m2",
            threadId: "t1",
            payload: {
              headers: [
                { name: "Message-ID", value: "<m2@mail.example.com>" },
                { name: "References", value: "<m0@mail.example.com>\r\n <m1@mail.example.com>" },
                { name: "Subject", value: "Elders meeting" },
                { name: "From", value: "Bob Elder <bob@example.com>" },
              ],
            },
          },
        },
        "POST /drafts": { body: { id: "d2", message: { id: "m3", threadId: "t1" } } },
      }),
    },
    {
      tool: "update_draft",
      args: { draftId: "d1", body: "Revised text.", cc: [] },
      replies: byPath({
        "GET /drafts/d1": {
          body: {
            id: "d1",
            message: {
              id: "m5",
              threadId: "t1",
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "Alice <alice@example.com>" },
                  { name: "To", value: '"Elder, Bob" <bob@example.com>, carol@example.com' },
                  { name: "Cc", value: "elders@example.com" },
                  { name: "Bcc", value: "secretary@example.com" },
                  { name: "Reply-To", value: "Church Office <office@example.com>" },
                  { name: "Subject", value: "Re: Elders meeting" },
                  { name: "In-Reply-To", value: "<m2@mail.example.com>" },
                  { name: "References", value: "<m1@mail.example.com> <m2@mail.example.com>" },
                ],
                body: { data: b64url("Old text") },
              },
            },
          },
        },
        "PUT /drafts/d1": { body: { id: "d1", message: { id: "m6", threadId: "t1" } } },
      }),
    },
  ],
  unsent: ["privateKey"],
  // Google redacts a vendor message whole before cutting it to 500 characters.
  errorEcho: "all",
  echo: {
    tool: "get_message",
    args: { messageId: "m2" },
    replies: (text) => [{ body: { ...MESSAGE, snippet: text } }],
  },
  failures: {
    read: { tool: "get_thread", args: { threadId: "t1" } },
    write: {
      tool: "create_draft",
      args: { to: ["bob@example.com"], subject: "Elders meeting", body: "See you Tuesday." },
    },
  },
});
