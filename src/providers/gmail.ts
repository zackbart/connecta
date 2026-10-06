/**
 * Gmail, draft-only, as the signed-in Workspace user: search and read mail,
 * list labels, and create or update drafts — and nothing that sends, deletes,
 * or relabels. Hand-written against the Gmail API v1 reference
 * (https://developers.google.com/workspace/gmail/api/reference/rest).
 *
 * Whose mailbox. Access is a service account with domain-wide delegation
 * (`src/providers/google/workspace.ts`): deployment config maps the admitted
 * identity to a Workspace address, and each call mints, or reuses, a token as
 * that user. There is no per-user consent step, no operator credential slot,
 * and no argument that names a mailbox — the transport is confined beneath
 * `users/me`, so the token's subject is the only mailbox any request reaches.
 *
 * Why draft-only. `gmail.compose` is the narrowest scope that can write a
 * draft, and Google lets it send too; the tool surface is what keeps this
 * connection from sending. There is no send tool and no raw hatch (H14), so
 * nothing reaches `drafts.send` or `messages.send`. A deployment that wants an
 * agent to send mail is choosing something this provider deliberately does
 * not offer.
 *
 * Drift. Google publishes a credential-free Discovery document per API.
 * `scripts/drift/gmail-endpoints.json` records the eight methods the tools
 * call, and `npm run providers:check -- --provider gmail` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { apiConnector as api, defined, type ApiTool } from "../connectors/api-connector.js";
import { ConnectorCallError } from "../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../types.js";
import {
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "./google/workspace.js";

export type {
  GoogleServiceAccount,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "./google/workspace.js";

/**
 * Gmail's API root, confined to the delegated user's own mailbox: `me` is the
 * token's subject, and no path can climb out of it.
 */
export const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * Exactly the scopes this connection requests, and exactly what the Admin
 * console's domain-wide delegation entry must list (comma-separated there).
 * `gmail.compose` technically permits sending; the tool surface does not.
 */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

/** Options for {@link gmail}: the shared Workspace delegation options. */
export type GmailOptions = GoogleWorkspaceOptions;

/**
 * Each summary row costs one metadata read, so a page stays small. Gmail's
 * own list maximum is 500.
 */
const MAX_PAGE_SIZE = 25;
const DEFAULT_PAGE_SIZE = 10;
/** Bodies are capped per message; a thread multiplies this. */
const DEFAULT_THREAD_BODY_CHARS = 3_000;
const DEFAULT_MESSAGE_BODY_CHARS = 12_000;
const MAX_BODY_CHARS = 100_000;
/** Summary reads in flight at once for one page. */
const SUMMARY_CONCURRENCY = 5;
/** A full thread without attachment bodies; Gmail's message cap is 25 MB. */
const GMAIL_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RECIPIENTS = 100;

type JsonRecord = Record<string, any>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// --- Reading messages -------------------------------------------------------------

interface Header {
  name?: string;
  value?: string;
}

function header(payload: JsonRecord, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const entry of asArray(payload["headers"]) as Header[]) {
    if (entry?.name?.toLowerCase() === wanted) return text(entry.value);
  }
  return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X"
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** Readable text from an HTML part that has no plain-text sibling. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function base64UrlBytes(data: string): Uint8Array {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function charsetOf(part: JsonRecord): string {
  const type = header(part, "Content-Type") ?? "";
  return /charset="?([^";\s]+)"?/i.exec(type)?.[1] ?? "utf-8";
}

/** A part's body as text, in its declared charset where the runtime knows it. */
function decodedBody(part: JsonRecord): string {
  const data = text(asRecord(part["body"])["data"]);
  if (!data) return "";
  let bytes: Uint8Array;
  try {
    bytes = base64UrlBytes(data);
  } catch {
    return "";
  }
  try {
    return new TextDecoder(charsetOf(part)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function isAttachment(part: JsonRecord): boolean {
  return Boolean(text(part["filename"])) || Boolean(asRecord(part["body"])["attachmentId"]);
}

function parts(root: JsonRecord): JsonRecord[] {
  const all: JsonRecord[] = [];
  const visit = (part: JsonRecord, depth: number) => {
    all.push(part);
    if (depth > 20) return;
    for (const child of asArray(part["parts"])) visit(asRecord(child), depth + 1);
  };
  visit(root, 0);
  return all;
}

/** The message's own text: the first plain part, else the first HTML part. */
function bodyOf(payload: JsonRecord): { text: string; format: "text" | "html" | "none" } {
  const inline = parts(payload).filter((part) => !isAttachment(part));
  const plain = inline.find((part) => String(part["mimeType"] ?? "").toLowerCase() === "text/plain");
  if (plain) return { text: decodedBody(plain), format: "text" };
  const html = inline.find((part) => String(part["mimeType"] ?? "").toLowerCase() === "text/html");
  if (html) return { text: htmlToText(decodedBody(html)), format: "html" };
  return { text: "", format: "none" };
}

function attachmentsOf(payload: JsonRecord): JsonRecord[] {
  return parts(payload)
    .filter(isAttachment)
    .map((part) =>
      compact({
        filename: text(part["filename"]) ?? "",
        mimeType: text(part["mimeType"]),
        size: typeof asRecord(part["body"])["size"] === "number" ? asRecord(part["body"])["size"] : undefined,
        attachmentId: text(asRecord(part["body"])["attachmentId"]),
      }),
    );
}

/** Cut a body at `max` characters and say so in the text itself. */
function capped(body: string, max: number): { body: string; bodyTruncated: boolean } {
  if (body.length <= max) return { body, bodyTruncated: false };
  const rest = body.length - max;
  return {
    body: `${body.slice(0, max)}\n[… ${rest} more characters truncated; raise maxBodyChars to read them]`,
    bodyTruncated: true,
  };
}

function isoFromMillis(value: unknown): string | undefined {
  const millis = typeof value === "string" ? Number(value) : value;
  if (typeof millis !== "number" || !Number.isFinite(millis)) return undefined;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function labelIdsOf(message: JsonRecord): string[] {
  return asArray(message["labelIds"]).filter((id): id is string => typeof id === "string");
}

function projectMessage(value: unknown, maxBodyChars: number): JsonRecord {
  const message = asRecord(value);
  const payload = asRecord(message["payload"]);
  const { text: body, format } = bodyOf(payload);
  const attachments = attachmentsOf(payload);
  return compact({
    id: text(message["id"]),
    threadId: text(message["threadId"]),
    labelIds: labelIdsOf(message),
    date: isoFromMillis(message["internalDate"]),
    from: header(payload, "From"),
    to: header(payload, "To"),
    cc: header(payload, "Cc"),
    bcc: header(payload, "Bcc"),
    replyTo: header(payload, "Reply-To"),
    subject: header(payload, "Subject"),
    messageIdHeader: header(payload, "Message-ID"),
    inReplyTo: header(payload, "In-Reply-To"),
    snippet: text(message["snippet"]) ? decodeEntities(message["snippet"]) : undefined,
    ...capped(body, maxBodyChars),
    bodyFormat: format,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

function projectThreadSummary(value: unknown, listedSnippet: unknown): JsonRecord {
  const thread = asRecord(value);
  const messages = asArray(thread["messages"]).map(asRecord);
  const first = asRecord(messages[0]?.["payload"]);
  const last = asRecord(messages[messages.length - 1]?.["payload"]);
  const labels = new Set<string>();
  let latest: number | undefined;
  for (const message of messages) {
    for (const id of labelIdsOf(message)) labels.add(id);
    const at = Number(message["internalDate"]);
    if (Number.isFinite(at) && (latest === undefined || at > latest)) latest = at;
  }
  const snippet = text(listedSnippet) ?? text(messages[messages.length - 1]?.["snippet"]);
  return compact({
    id: text(thread["id"]),
    subject: header(first, "Subject"),
    from: header(first, "From"),
    lastFrom: messages.length > 1 ? header(last, "From") : undefined,
    messageCount: messages.length,
    lastMessageAt: isoFromMillis(latest),
    unread: labels.has("UNREAD"),
    labelIds: [...labels],
    snippet: snippet ? decodeEntities(snippet) : undefined,
  });
}

function projectDraftSummary(value: unknown): JsonRecord {
  const draft = asRecord(value);
  const message = asRecord(draft["message"]);
  const payload = asRecord(message["payload"]);
  return compact({
    draftId: text(draft["id"]),
    messageId: text(message["id"]),
    threadId: text(message["threadId"]),
    subject: header(payload, "Subject"),
    to: header(payload, "To"),
    updatedAt: isoFromMillis(message["internalDate"]),
    snippet: text(message["snippet"]) ? decodeEntities(message["snippet"]) : undefined,
  });
}

/** Run `work` over `items`, at most `limit` at a time, keeping order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * One row's summary read, or nothing when the item was deleted between the
 * list and the read — a page that fails on a race nobody can repeat helps no
 * one, and the row's absence is the truth by then.
 */
async function unlessGone<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ConnectorCallError && error.code === "not_found") return undefined;
    throw error;
  }
}

// --- Writing drafts ---------------------------------------------------------------

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const MAILBOX = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+$/;

function refuseLineBreaks(name: string, value: string): void {
  if (/[\r\n]/.test(value) || value.includes("\u0000")) {
    throw new ConnectorCallError("invalid_args", `${name} may not contain a line break.`);
  }
}

/**
 * RFC 2047 encoded words for header text that is not plain ASCII. Each word
 * carries at most 45 UTF-8 bytes (60 base64 characters, 72 with its armor),
 * split only between code points, and words fold onto continuation lines.
 */
function encodedWords(value: string): string {
  if (PRINTABLE_ASCII.test(value)) return value;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  let size = 0;
  for (const character of value) {
    const bytes = encoder.encode(character).length;
    if (size + bytes > 45 && chunk) {
      words.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`)
    .join("\r\n ");
}

/** `Name <addr>` or `addr`, display name encoded or quoted as needed. */
function formatAddress(field: string, raw: string): string {
  refuseLineBreaks(field, raw);
  const trimmed = raw.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const address = (named ? named[2]! : trimmed).trim();
  if (!MAILBOX.test(address) || !PRINTABLE_ASCII.test(address)) {
    throw new ConnectorCallError(
      "invalid_args",
      `${field} has an entry that is not an email address; use "name@example.com" or "Name <name@example.com>".`,
    );
  }
  const name = named?.[1]?.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!name) return address;
  if (!PRINTABLE_ASCII.test(name)) return `${encodedWords(name)} <${address}>`;
  return /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name)
    ? `${name} <${address}>`
    : `"${name.replace(/(["\\])/g, "\\$1")}" <${address}>`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Base64 body lines of 76 characters, as RFC 2045 requires. */
function base64Lines(value: string): string {
  return (base64(new TextEncoder().encode(value)).match(/.{1,76}/g) ?? []).join("\r\n");
}

interface Composition {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  subject: string | undefined;
  body: string;
  htmlBody: string | undefined;
  inReplyTo: string | undefined;
  references: string | undefined;
}

/**
 * One RFC 5322 message, base64url-encoded as Gmail's `raw` field wants it.
 * `From`, `Date`, and `Message-ID` are Gmail's to set: it fills `From` with
 * the mailbox's own address, so an agent cannot forge a sender either.
 */
function buildRawMessage(message: Composition): string {
  const lines: string[] = [];
  for (const [name, list] of [["To", message.to], ["Cc", message.cc], ["Bcc", message.bcc]] as const) {
    if (list.length === 0) continue;
    if (list.length > MAX_RECIPIENTS) {
      throw new ConnectorCallError("invalid_args", `${name} lists more than ${MAX_RECIPIENTS} recipients.`);
    }
    lines.push(`${name}: ${list.map((entry) => formatAddress(name.toLowerCase(), entry)).join(",\r\n ")}`);
  }
  if (message.subject !== undefined) {
    refuseLineBreaks("subject", message.subject);
    lines.push(`Subject: ${encodedWords(message.subject)}`);
  }
  if (message.inReplyTo) lines.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references) lines.push(`References: ${message.references}`);
  lines.push("MIME-Version: 1.0");
  const plain = [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.body),
  ];
  if (message.htmlBody === undefined) {
    lines.push(...plain);
  } else {
    const boundary = `connecta-${crypto.randomUUID()}`;
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      ...plain,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.htmlBody),
      `--${boundary}--`,
    );
  }
  return base64(new TextEncoder().encode(`${lines.join("\r\n")}\r\n`))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Message-ID tokens (`<…@…>`) in a header, in order, line breaks gone. */
function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/** At most this many ancestors ride in References; the newest are kept. */
const MAX_REFERENCES = 20;

interface Threading {
  threadId: string | undefined;
  inReplyTo: string | undefined;
  references: string | undefined;
  /** Defaults a reply takes from the message it answers. */
  subject?: string | undefined;
  to?: string[];
}

/** Threading for a reply: the answered message's thread, ids, and sender. */
async function replyThreading(
  client: GoogleWorkspaceClient,
  messageId: string,
  ctx: ConnectorContext,
): Promise<Threading> {
  const message = asRecord(
    await client.json(
      {
        method: "GET",
        path: `/messages/${encodeURIComponent(messageId)}`,
        query: {
          format: "metadata",
          metadataHeaders: ["Message-ID", "References", "Subject", "From", "Reply-To"],
        },
      },
      ctx,
    ),
  );
  const payload = asRecord(message["payload"]);
  const id = messageIds(header(payload, "Message-ID"))[0];
  const chain = [...messageIds(header(payload, "References")), ...(id ? [id] : [])].slice(-MAX_REFERENCES);
  const subject = oneLine(header(payload, "Subject"));
  const sender = header(payload, "Reply-To") ?? header(payload, "From");
  return {
    threadId: text(message["threadId"]),
    inReplyTo: id,
    references: chain.length > 0 ? chain.join("\r\n ") : undefined,
    subject: subject === undefined ? undefined : /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    ...(sender ? { to: [oneLine(sender)!] } : {}),
  };
}

/** A header value read back from Gmail, unfolded before it is written again. */
function oneLine(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n]+\s*/g, " ").trim();
}

/** A draft's id, its message id, and the thread Gmail placed it in. */
function projectSavedDraft(value: unknown): JsonRecord {
  const draft = asRecord(value);
  const message = asRecord(draft["message"]);
  return compact({
    draftId: text(draft["id"]),
    messageId: text(message["id"]),
    threadId: text(message["threadId"]),
    sent: false,
  });
}

function addressList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/** Split a stored address header back into entries, commas inside quotes kept. */
function splitAddresses(value: string | undefined): string[] {
  if (!value) return [];
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? [])
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// --- Schemas ----------------------------------------------------------------------

function input(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const ID_PATTERN = "^[A-Za-z0-9_-]+$";

function idProperty(description: string): JsonSchema {
  return { type: "string", minLength: 1, maxLength: 256, pattern: ID_PATTERN, description };
}

const CURSOR_PROPERTY: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  description: "Opaque page.nextCursor from the previous page. Pass it back unchanged with the same query.",
};

const LIMIT_PROPERTY: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_SIZE,
  description: `Rows per page, 1 to ${MAX_PAGE_SIZE}; defaults to ${DEFAULT_PAGE_SIZE}. Connecta's cap, below Gmail's 500, because each row costs a metadata read.`,
};

const QUERY_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 2048,
  description: "Gmail search syntax, as in the Gmail search box: from:, to:, subject:, label:, is:unread, has:attachment, newer_than:7d, in:inbox. Omit for everything.",
};

function bodyCharsProperty(fallback: number): JsonSchema {
  return {
    type: "integer",
    minimum: 0,
    maximum: MAX_BODY_CHARS,
    description: `Characters of body text kept per message, 0 to ${MAX_BODY_CHARS}; defaults to ${fallback}. Longer bodies end with a truncation marker.`,
  };
}

const ADDRESSES = (who: string): JsonSchema => ({
  type: "array",
  maxItems: MAX_RECIPIENTS,
  items: {
    type: "string",
    minLength: 3,
    maxLength: 320,
    pattern: "^[^\\r\\n]*$",
    description: '"name@example.com" or "Name <name@example.com>".',
  },
  description: `${who} recipients.`,
});

const SUBJECT_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 900,
  pattern: "^[^\\r\\n]*$",
  description: "Subject line; any language. A reply defaults to Re: and the original subject, which Gmail needs to keep it in the thread.",
};

const BODY_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 200_000,
  description: "Plain-text body. Always required; it is what clients without HTML show.",
};

const HTML_BODY_PROPERTY: JsonSchema = {
  type: "string",
  maxLength: 500_000,
  description: "Optional HTML alternative to body, sent beside it. Omit for a plain-text draft.",
};

const REPLY_PROPERTY: JsonSchema = idProperty(
  "Message id (from get_thread or get_message) this draft replies to: sets its thread, In-Reply-To, and References, and defaults subject and to from it.",
);

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    hasMore: { type: "boolean" },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["hasMore", "nextCursor"],
};

const ATTACHMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    filename: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer" },
    attachmentId: { type: "string" },
  },
};

const MESSAGE_PROPERTIES: Record<string, JsonSchema> = {
  id: { type: "string" },
  threadId: { type: "string" },
  labelIds: { type: "array", items: { type: "string" } },
  date: { type: "string" },
  from: { type: "string" },
  to: { type: "string" },
  cc: { type: "string" },
  bcc: { type: "string" },
  replyTo: { type: "string" },
  subject: { type: "string" },
  messageIdHeader: { type: "string" },
  inReplyTo: { type: "string" },
  snippet: { type: "string" },
  body: { type: "string" },
  bodyTruncated: { type: "boolean" },
  bodyFormat: { type: "string", enum: ["text", "html", "none"] },
  attachments: { type: "array", items: ATTACHMENT_SCHEMA },
};

const MESSAGE_SCHEMA: JsonSchema = { type: "object", properties: MESSAGE_PROPERTIES };

/** A draft names its message `messageId`, beside its own `draftId`. */
const { id: _messageId, ...DRAFT_MESSAGE_PROPERTIES } = MESSAGE_PROPERTIES;

const SAVED_DRAFT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    draftId: { type: "string" },
    messageId: { type: "string" },
    threadId: { type: "string" },
    sent: { type: "boolean", const: false },
  },
  required: ["draftId", "sent"],
};

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const bodyChars = (args: JsonRecord, fallback: number): number =>
    typeof args["maxBodyChars"] === "number" ? args["maxBodyChars"] : fallback;
  const page = (listing: JsonRecord) => {
    const next = text(listing["nextPageToken"]) ?? null;
    return { hasMore: next !== null, nextCursor: next };
  };

  const compose = async (
    args: JsonRecord,
    ctx: ConnectorContext,
    kept: Threading & { cc?: string[]; bcc?: string[] },
  ) => {
    const reply = args["replyToMessageId"]
      ? await replyThreading(client, String(args["replyToMessageId"]), ctx)
      : kept;
    // What the caller states wins; then what the draft already had; then
    // what a reply defaults to. A new draft has nothing kept.
    const raw = buildRawMessage({
      to: addressList(args["to"]) ?? (kept.to?.length ? kept.to : reply.to) ?? [],
      cc: addressList(args["cc"]) ?? kept.cc ?? [],
      bcc: addressList(args["bcc"]) ?? kept.bcc ?? [],
      subject: args["subject"] ?? kept.subject ?? reply.subject,
      body: String(args["body"] ?? ""),
      htmlBody: typeof args["htmlBody"] === "string" ? args["htmlBody"] : undefined,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
    });
    return { message: compact({ raw, threadId: reply.threadId }) };
  };

  return [
    {
      name: "search_threads",
      description:
        "Search the user's Gmail threads with Gmail query syntax, newest first, returning subject, senders, date, and snippet per thread. Bodies need get_thread.",
      annotations: readOnly,
      inputSchema: input(
        {
          query: QUERY_PROPERTY,
          includeSpamTrash: {
            type: "boolean",
            description: "Include Spam and Trash, which Gmail leaves out by default.",
          },
          limit: LIMIT_PROPERTY,
          cursor: CURSOR_PROPERTY,
        },
        [],
      ),
      outputSchema: {
        type: "object",
        properties: {
          threads: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                subject: { type: "string" },
                from: { type: "string" },
                lastFrom: { type: "string" },
                messageCount: { type: "integer" },
                lastMessageAt: { type: "string" },
                unread: { type: "boolean" },
                labelIds: { type: "array", items: { type: "string" } },
                snippet: { type: "string" },
              },
            },
          },
          resultSizeEstimate: { type: "integer" },
          page: PAGE_SCHEMA,
        },
        required: ["threads", "page"],
      },
      handler: async (args, ctx) => {
        const listing = asRecord(
          await client.json(
            {
              method: "GET",
              path: "/threads",
              query: {
                q: args["query"],
                includeSpamTrash: args["includeSpamTrash"],
                maxResults: args["limit"] ?? DEFAULT_PAGE_SIZE,
                pageToken: args["cursor"],
              },
            },
            ctx,
          ),
        );
        const rows = asArray(listing["threads"]).map(asRecord);
        const threads = await mapLimited(rows, SUMMARY_CONCURRENCY, (row) =>
          unlessGone(async () =>
            projectThreadSummary(
              await client.json(
                {
                  method: "GET",
                  path: `/threads/${encodeURIComponent(String(row["id"]))}`,
                  query: { format: "metadata", metadataHeaders: ["Subject", "From", "Date"] },
                },
                ctx,
              ),
              row["snippet"],
            ),
          ),
        );
        return compact({
          threads: threads.filter((thread) => thread !== undefined),
          resultSizeEstimate:
            typeof listing["resultSizeEstimate"] === "number" ? listing["resultSizeEstimate"] : undefined,
          page: page(listing),
        });
      },
    },
    {
      name: "get_thread",
      description:
        "Get every message in one Gmail thread, oldest first, with headers, plain-text bodies capped by maxBodyChars, and attachment names. Never downloads attachments.",
      annotations: readOnly,
      inputSchema: input(
        {
          threadId: idProperty("Thread id from search_threads or a message's threadId."),
          maxBodyChars: bodyCharsProperty(DEFAULT_THREAD_BODY_CHARS),
        },
        ["threadId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          messageCount: { type: "integer" },
          messages: { type: "array", items: MESSAGE_SCHEMA },
        },
        required: ["id", "messages"],
      },
      handler: async (args, ctx) => {
        const thread = asRecord(
          await client.json(
            {
              method: "GET",
              path: `/threads/${encodeURIComponent(args["threadId"])}`,
              query: { format: "full" },
            },
            ctx,
          ),
        );
        const max = bodyChars(args, DEFAULT_THREAD_BODY_CHARS);
        const messages = asArray(thread["messages"]).map((message) => projectMessage(message, max));
        return { id: text(thread["id"]) ?? args["threadId"], messageCount: messages.length, messages };
      },
    },
    {
      name: "get_message",
      description:
        "Get one Gmail message with headers, its plain-text body (HTML converted only when no text part exists), and attachment metadata. Never downloads attachments.",
      annotations: readOnly,
      inputSchema: input(
        {
          messageId: idProperty("Message id from get_thread, or a draft's messageId."),
          maxBodyChars: bodyCharsProperty(DEFAULT_MESSAGE_BODY_CHARS),
          raw: {
            type: "boolean",
            description: "Return Gmail's untouched message resource (every header, base64url part bodies) instead of the projection.",
          },
        },
        ["messageId"],
      ),
      outputSchema: MESSAGE_SCHEMA,
      handler: async (args, ctx) => {
        const message = await client.json(
          {
            method: "GET",
            path: `/messages/${encodeURIComponent(args["messageId"])}`,
            query: { format: "full" },
          },
          ctx,
        );
        return args["raw"] === true
          ? message
          : projectMessage(message, bodyChars(args, DEFAULT_MESSAGE_BODY_CHARS));
      },
    },
    {
      name: "list_labels",
      description:
        "List the user's Gmail labels, system and user-created, with the ids messages carry. Not paged; no message counts. Search by name with label: in search_threads.",
      annotations: readOnly,
      inputSchema: input({}, []),
      outputSchema: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                type: { type: "string", enum: ["system", "user"] },
              },
            },
          },
        },
        required: ["labels"],
      },
      handler: async (_args, ctx) => {
        const listing = asRecord(await client.json({ method: "GET", path: "/labels" }, ctx));
        return {
          labels: asArray(listing["labels"]).map((value) => {
            const label = asRecord(value);
            return compact({
              id: text(label["id"]),
              name: text(label["name"]),
              type: label["type"] === "system" ? "system" : label["type"] === "user" ? "user" : undefined,
            });
          }),
        };
      },
    },
    {
      name: "list_drafts",
      description:
        "List the user's Gmail drafts, newest first, with subject, recipients, and snippet. Use get_draft for a body.",
      annotations: readOnly,
      inputSchema: input(
        { query: QUERY_PROPERTY, limit: LIMIT_PROPERTY, cursor: CURSOR_PROPERTY },
        [],
      ),
      outputSchema: {
        type: "object",
        properties: {
          drafts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                draftId: { type: "string" },
                messageId: { type: "string" },
                threadId: { type: "string" },
                subject: { type: "string" },
                to: { type: "string" },
                updatedAt: { type: "string" },
                snippet: { type: "string" },
              },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["drafts", "page"],
      },
      handler: async (args, ctx) => {
        const listing = asRecord(
          await client.json(
            {
              method: "GET",
              path: "/drafts",
              query: {
                q: args["query"],
                maxResults: args["limit"] ?? DEFAULT_PAGE_SIZE,
                pageToken: args["cursor"],
              },
            },
            ctx,
          ),
        );
        const drafts = await mapLimited(asArray(listing["drafts"]).map(asRecord), SUMMARY_CONCURRENCY, (row) =>
          unlessGone(async () =>
            projectDraftSummary(
              await client.json(
                {
                  method: "GET",
                  path: `/drafts/${encodeURIComponent(String(row["id"]))}`,
                  query: { format: "metadata" },
                },
                ctx,
              ),
            ),
          ),
        );
        return { drafts: drafts.filter((draft) => draft !== undefined), page: page(listing) };
      },
    },
    {
      name: "get_draft",
      description: "Get one Gmail draft's headers and plain-text body by draft id. Reading it never sends it.",
      annotations: readOnly,
      inputSchema: input(
        {
          draftId: idProperty("Draft id from list_drafts or create_draft."),
          maxBodyChars: bodyCharsProperty(DEFAULT_MESSAGE_BODY_CHARS),
        },
        ["draftId"],
      ),
      outputSchema: {
        type: "object",
        properties: { draftId: { type: "string" }, messageId: { type: "string" }, ...DRAFT_MESSAGE_PROPERTIES },
        required: ["draftId"],
      },
      handler: async (args, ctx) => {
        const draft = asRecord(
          await client.json(
            {
              method: "GET",
              path: `/drafts/${encodeURIComponent(args["draftId"])}`,
              query: { format: "full" },
            },
            ctx,
          ),
        );
        const { id, ...message } = projectMessage(draft["message"], bodyChars(args, DEFAULT_MESSAGE_BODY_CHARS));
        // A draft's message id changes on every update; the draft id does not.
        return compact({ draftId: text(draft["id"]) ?? args["draftId"], messageId: id, ...message });
      },
    },
    {
      name: "create_draft",
      description:
        "Create a Gmail draft, optionally as a reply in an existing thread. It is saved, never sent: the user reviews and sends it in Gmail.",
      // Additive: a new draft changes nothing that existed. Not read-only, so
      // it crosses call_destructive_tool unless the deployment exempts it in
      // `execute.approval`; the provider never exempts itself.
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: input(
        {
          to: ADDRESSES("To"),
          cc: ADDRESSES("Cc"),
          bcc: ADDRESSES("Bcc"),
          subject: SUBJECT_PROPERTY,
          body: BODY_PROPERTY,
          htmlBody: HTML_BODY_PROPERTY,
          replyToMessageId: REPLY_PROPERTY,
        },
        ["body"],
      ),
      outputSchema: SAVED_DRAFT_SCHEMA,
      handler: async (args, ctx) => {
        const draft = await client.json(
          {
            method: "POST",
            path: "/drafts",
            body: await compose(args, ctx, { threadId: undefined, inReplyTo: undefined, references: undefined }),
          },
          ctx,
        );
        return projectSavedDraft(draft);
      },
    },
    {
      name: "update_draft",
      description:
        "Replace a Gmail draft's body; recipients and subject change only where given, and its thread and reply headers are kept. Overwrites the old body. Never sends it.",
      // Destructive: Gmail replaces the draft's whole message, so the body it
      // held — possibly typed by the user — is gone. Still a draft, never sent.
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: input(
        {
          draftId: idProperty("Draft id from list_drafts or create_draft."),
          to: ADDRESSES("To; omit to keep the current"),
          cc: ADDRESSES("Cc; omit to keep the current"),
          bcc: ADDRESSES("Bcc; omit to keep the current"),
          subject: { ...SUBJECT_PROPERTY, description: "Subject line; omit to keep the current one." },
          body: { ...BODY_PROPERTY, description: "The new plain-text body, replacing the old one entirely." },
          htmlBody: { ...HTML_BODY_PROPERTY, description: "Optional HTML alternative; omitting it drops any HTML the draft had." },
          replyToMessageId: REPLY_PROPERTY,
        },
        ["draftId", "body"],
      ),
      outputSchema: SAVED_DRAFT_SCHEMA,
      handler: async (args, ctx) => {
        const draftPath = `/drafts/${encodeURIComponent(args["draftId"])}`;
        // Read before replacing: Gmail's update takes a whole message, so the
        // thread, reply headers, and any header the caller did not restate
        // would otherwise be dropped on the floor.
        const existing = asRecord(
          await client.json({ method: "GET", path: draftPath, query: { format: "metadata" } }, ctx),
        );
        const message = asRecord(existing["message"]);
        const payload = asRecord(message["payload"]);
        const references = messageIds(header(payload, "References"));
        const draft = await client.json(
          {
            method: "PUT",
            path: draftPath,
            body: await compose(args, ctx, {
              threadId: text(message["threadId"]),
              inReplyTo: messageIds(header(payload, "In-Reply-To"))[0],
              references: references.length > 0 ? references.join("\r\n ") : undefined,
              subject: oneLine(header(payload, "Subject")),
              to: splitAddresses(header(payload, "To")),
              cc: splitAddresses(header(payload, "Cc")),
              bcc: splitAddresses(header(payload, "Bcc")),
            }),
          },
          ctx,
        );
        return projectSavedDraft(draft);
      },
    },
  ];
}

// --- Guide ------------------------------------------------------------------------

function usageGuide(purpose: string, instructions: string | undefined): string {
  const extra = instructions?.trim();
  return `# Gmail usage (draft-only)

Acts as the signed-in person's own Gmail through Workspace delegation: read mail and write drafts, never send.

Connection purpose: ${purpose}

## Whose mailbox

Every call reads and writes the mailbox deployment config maps the caller
to. No argument names a mailbox. A call with none mapped fails
\`auth_required\`; only an operator can change the mapping.

## Reading

- \`search_threads\` takes Gmail search syntax; reuse the person's own
  phrasing (\`from:\`, \`subject:\`, \`newer_than:7d\`, \`is:unread\`,
  \`label:\`). Page with \`page.nextCursor\` and the same query.
- \`get_thread\` returns every message with bodies capped by
  \`maxBodyChars\`; a cut body ends with a truncation marker. Reduce inside
  \`execute_code\` before returning a long thread.
- Attachments are listed by name, type, and size only; none is downloaded.

## Drafting

- \`create_draft\` saves a draft and never sends it; tell the person it is
  waiting in Drafts. There is no send, delete, or label tool.
- To reply, pass \`replyToMessageId\`: the draft joins that thread with
  In-Reply-To and References set, and subject (Re: …) and \`to\` default
  from that message. Keep the Re: subject or Gmail may start a new thread.
- \`update_draft\` replaces the body entirely; send the full new text.
  Recipients and subject change only when given, and the thread is kept.
- Gmail sets From to the mailbox itself; there is no From argument.
${extra ? `\n## Connection instructions\n\n${extra}\n` : ""}`;
}

// --- Construction -----------------------------------------------------------------

/**
 * A maintained, draft-only Gmail connection acting as each signed-in
 * Workspace user through a delegated service account.
 *
 * Setup, once per Workspace (shared with every Workspace provider):
 *
 * 1. In a Google Cloud project, enable the **Gmail API**.
 * 2. Create a service account. Grant it no IAM roles: delegation, not project
 *    permission, is what reaches mailboxes.
 * 3. Create a JSON key for it. If key creation is refused, the organization
 *    policy `iam.disableServiceAccountKeyCreation` is enforced; an org policy
 *    administrator can override it for this project alone.
 * 4. Copy the service account's numeric **client ID** (the key's `client_id`).
 * 5. As a Workspace super admin: Admin console → Security → Access and data
 *    control → API controls → Manage Domain Wide Delegation → Add new. Paste
 *    the client ID and exactly these scopes, comma-separated
 *    ({@link GMAIL_SCOPES}):
 *    `https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.compose`.
 *    A new grant can take up to 24 hours to apply.
 * 6. Give the deployment the key as a secret and map callers to mailboxes:
 *
 * ```ts
 * gmail("mail", {
 *   purpose: "Staff email triage and reply drafting",
 *   serviceAccount: env.GOOGLE_SERVICE_ACCOUNT_JSON,
 *   subject: (identity) => mailboxes[identity.principal?.id ?? ""],
 * });
 * ```
 *
 * `gmail.compose` technically allows sending; this connection never does,
 * because no tool reaches a send method. Drafts are additive writes the host
 * approves unless the deployment exempts `create_draft` in `execute.approval`.
 */
export function gmail(id: string, options: GmailOptions): Connector {
  const connection = workspaceConnection("gmail", options);
  const client = googleWorkspaceClient({
    provider: "Gmail",
    api: "Gmail API",
    baseUrl: options.baseUrl?.trim() || GMAIL_API_BASE_URL,
    scopes: GMAIL_SCOPES,
    maxResponseBytes: GMAIL_MAX_RESPONSE_BYTES,
    // Every request is confined to the token's own mailbox, so a 404 cannot
    // be another account's message hiding behind a permission gap.
    notFound: "absent",
    connection,
  });
  return api(id, {
    ...defined({
      callAdmission: options.callAdmission,
      maxResultBytes: options.maxResultBytes,
    }),
    title: options.title ?? "Gmail (drafts only)",
    description: `Gmail as the signed-in Workspace user: read mail and write drafts, never send — ${connection.purpose}`,
    usageGuide: {
      content: usageGuide(connection.purpose, options.instructions),
      summary: "Each caller's own mailbox: Gmail search syntax, capped bodies, reply threading, drafts that never send.",
      // Required: whose mailbox it is, and that update_draft replaces the
      // body, are conventions no schema can carry.
      required: true,
    },
    tools: tools(client),
  });
}
