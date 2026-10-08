import { skill } from "./skill.generated.js";
/**
 * Gmail, draft-only, as the signed-in Workspace user: search and read mail,
 * list labels, and create or update drafts — and nothing that sends, deletes,
 * or relabels. Hand-written against the Gmail API v1 reference
 * (https://developers.google.com/workspace/gmail/api/reference/rest).
 *
 * Whose mailbox. Access is a service account with domain-wide delegation
 * (`src/providers/_shared/google/workspace.ts`): deployment config maps the admitted
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
 * `src/providers/gmail/drift.json` records the nine methods the tools
 * call, and `npm run providers:check -- --provider gmail` reports a touched
 * contract that moved or a method that stopped accepting the scopes below.
 */
import { apiConnector as api, defined, type ApiTool } from "../../connectors/api-connector.js";
import { ConnectorCallError } from "../../errors.js";
import type { Connector, ConnectorContext, JsonSchema } from "../../types.js";
import {
  GOOGLE_WORKSPACE_OPTIONS,
  googleWorkspaceClient,
  workspaceConnection,
  type GoogleWorkspaceClient,
  type GoogleWorkspaceOptions,
} from "../_shared/google/workspace.js";
import { RESULT_BUDGET_BYTES, clampText, jsonBytes } from "../_shared/google/result-size.js";
import { asProviderFactory } from "../../provider.js";

export type {
  GoogleServiceAccount,
  GoogleSubjectContext,
  GoogleWorkspaceOptions,
  GoogleWorkspaceSubject,
} from "../_shared/google/workspace.js";

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

/** Bytes as text, in the part's declared charset where the runtime knows it. */
function decodeIn(part: JsonRecord, data: string): string {
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

function mimeOf(part: JsonRecord): string {
  return String(part["mimeType"] ?? "").toLowerCase();
}

/**
 * Where the message's own content ends and something it carries begins: a
 * named file, a part disposed as an attachment, or a whole forwarded message.
 * Everything beneath such a part belongs to it — an attached email's text is
 * not the message's body.
 */
function isAttachment(part: JsonRecord): boolean {
  const mime = mimeOf(part);
  return (
    Boolean(text(part["filename"])) ||
    /^\s*attachment\b/i.test(header(part, "Content-Disposition") ?? "") ||
    mime === "message/rfc822" ||
    // Any leaf that is not body text — an unnamed inline image, a calendar
    // invitation — is carried content, listed rather than dropped. A text
    // body Gmail stored apart (an attachmentId, no filename) stays a body.
    (mime !== "" && !mime.startsWith("multipart/") && !BODY_TYPES.has(mime))
  );
}

/** The only parts that can be a message's own body. */
const BODY_TYPES = new Set(["text/plain", "text/html"]);

/** How deep a payload is walked; deeper than this is refused, not guessed. */
const MAX_PART_DEPTH = 20;

/**
 * Walk a payload keeping ancestry: the message's own parts, in order, and the
 * attachment roots, whose subtrees are never entered.
 */
function walk(root: JsonRecord): { own: JsonRecord[]; attachments: JsonRecord[] } {
  const own: JsonRecord[] = [];
  const attachments: JsonRecord[] = [];
  const visit = (part: JsonRecord, depth: number) => {
    if (isAttachment(part)) {
      attachments.push(part);
      return;
    }
    own.push(part);
    if (depth >= MAX_PART_DEPTH) return;
    for (const child of asArray(part["parts"])) visit(asRecord(child), depth + 1);
  };
  visit(root, 0);
  return { own, attachments };
}

/** Gmail stores a large body apart from the message, behind an attachment id. */
const MAX_STORED_BODY_BYTES = 1024 * 1024;

type BodyFormat = "text" | "html" | "none" | "unavailable";

interface MessageBody {
  body: string;
  bodyTruncated: boolean;
  bodyFormat: BodyFormat;
}

/**
 * The message's own text: its first plain part, else its first HTML part as
 * text. A body Gmail stored apart from the message is fetched from the
 * attachments endpoint when it is small enough to read; otherwise the result
 * says so in `bodyFormat` and in the text, never as a silent empty body.
 */
async function readBody(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  messageId: string | undefined,
  payload: JsonRecord,
  max: number,
): Promise<MessageBody | { text: string; bodyFormat: "text" | "html" }> {
  const own = walk(payload).own;
  const plain = own.find((part) => mimeOf(part) === "text/plain");
  const chosen = plain ?? own.find((part) => mimeOf(part) === "text/html");
  if (!chosen) return { body: "", bodyTruncated: false, bodyFormat: "none" };
  const format: BodyFormat = plain ? "text" : "html";
  const stored = asRecord(chosen["body"]);
  let data = text(stored["data"]);
  const attachmentId = text(stored["attachmentId"]);
  if (!data && attachmentId) {
    const size = typeof stored["size"] === "number" ? stored["size"] : undefined;
    if (max === 0) {
      return { body: "[… body not read; raise maxBodyChars to read it]", bodyTruncated: true, bodyFormat: format };
    }
    if (!messageId || size === undefined || size > MAX_STORED_BODY_BYTES) {
      return {
        body: `[Body of ${size ?? "unknown"} bytes is stored apart from the message and is larger than this connection reads (${MAX_STORED_BODY_BYTES} bytes); open it in Gmail.]`,
        bodyTruncated: true,
        bodyFormat: "unavailable",
      };
    }
    const fetched = asRecord(
      await client.json(
        {
          method: "GET",
          path: `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        },
        ctx,
      ),
    );
    data = text(fetched["data"]);
  }
  const decoded = data ? decodeIn(chosen, data) : "";
  // Uncut: the caller caps it, by characters and by the result's bytes.
  return { text: format === "html" ? htmlToText(decoded) : decoded, bodyFormat: format };
}


/**
 * Gmail's ids are short opaque tokens — message and thread ids are sixteen
 * hex digits, label ids `INBOX` or `Label_123`, attachment ids a few hundred
 * characters. One far past that is not an id this connection can use. It is
 * dropped, never cut — a cut id names nothing — and the drop is said out loud:
 * an object lists the fields it omitted in `omittedIds`, and a list counts
 * what it left out, so a missing id is never mistaken for an absent one.
 */
const ID_BYTES = 256;
const LABEL_ID_BYTES = 128;
const ATTACHMENT_ID_BYTES = 1024;

function idOf(value: unknown, maxBytes = ID_BYTES): string | undefined {
  const id = text(value);
  return id !== undefined && jsonBytes(id) <= maxBytes ? id : undefined;
}

/**
 * The usable ids among `fields`, plus `omittedIds` naming each field Gmail
 * sent an id for that was too long to return.
 */
function ids(fields: Record<string, [value: unknown, maxBytes?: number]>): JsonRecord {
  const kept: JsonRecord = {};
  const omitted: string[] = [];
  for (const [name, [value, maxBytes]] of Object.entries(fields)) {
    const id = idOf(value, maxBytes);
    if (id !== undefined) kept[name] = id;
    else if (text(value) !== undefined) omitted.push(name);
  }
  return omitted.length > 0 ? { ...kept, omittedIds: omitted } : kept;
}

/** At most this many label ids per message; the rest are counted. */
const MAX_LISTED_LABELS = 20;

/** Usable label ids, at most twenty, and how many were left out either way. */
function labelsOf(labelIds: readonly string[]): { labelIds: string[]; labelIdsOmitted?: number } {
  const usable = labelIds.filter((id) => idOf(id, LABEL_ID_BYTES) !== undefined);
  const listed = usable.slice(0, MAX_LISTED_LABELS);
  const omitted = labelIds.length - listed.length;
  return omitted > 0 ? { labelIds: listed, labelIdsOmitted: omitted } : { labelIds: listed };
}

/** Attachment rows listed per message; the rest are counted, not listed. */
const MAX_LISTED_ATTACHMENTS = 20;

function attachmentsOf(payload: JsonRecord): { listed: JsonRecord[]; omitted: number } {
  const all = walk(payload).attachments;
  return {
    listed: all.slice(0, MAX_LISTED_ATTACHMENTS).map((part) =>
      compact({
        filename: clipped(text(part["filename"]) ?? "", FIELD_BYTES),
        mimeType: clipped(text(part["mimeType"]), FIELD_BYTES),
        size: typeof asRecord(part["body"])["size"] === "number" ? asRecord(part["body"])["size"] : undefined,
        ...ids({ attachmentId: [asRecord(part["body"])["attachmentId"], ATTACHMENT_ID_BYTES] }),
      }),
    ),
    omitted: Math.max(0, all.length - MAX_LISTED_ATTACHMENTS),
  };
}

/**
 * Per-field byte bounds, so every result is bounded by construction: a page
 * of 25 summaries, or one message beside its body, stays under
 * `RESULT_BUDGET_BYTES` however long and however encoded Google's strings are.
 */
const FIELD_BYTES = 512;
const HEADER_BYTES = 4 * 1024;

/** A string cut to `maxBytes` of JSON, ending in "…" when it was cut. */
function clipped<T extends string | undefined>(value: T, maxBytes: number): T {
  return (value === undefined ? value : clampText(value, maxBytes, () => "…")) as T;
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

/**
 * One message, projected and finished into the result it belongs to, with
 * its body cut so that the finished result — measured as it will be sent, not
 * estimated — fits `budget`. `finish` shapes the message into what the tool
 * returns (a draft's wrapper, say); the identity for a bare message.
 */
async function projectMessage(
  client: GoogleWorkspaceClient,
  ctx: ConnectorContext,
  value: unknown,
  maxBodyChars: number,
  budget: number = RESULT_BUDGET_BYTES,
  finish: (message: JsonRecord) => JsonRecord = (message) => message,
): Promise<JsonRecord> {
  const message = asRecord(value);
  const payload = asRecord(message["payload"]);
  const read = await readBody(client, ctx, idOf(message["id"]), payload, maxBodyChars);
  const attachments = attachmentsOf(payload);
  const headerOf = (name: string) => clipped(header(payload, name), HEADER_BYTES);
  const { omittedIds, ...messageIds } = ids({ id: [message["id"]], threadId: [message["threadId"]] });
  const projected = compact({
    ...messageIds,
    ...labelsOf(labelIdsOf(message)),
    date: isoFromMillis(message["internalDate"]),
    from: headerOf("From"),
    to: headerOf("To"),
    cc: headerOf("Cc"),
    bcc: headerOf("Bcc"),
    replyTo: headerOf("Reply-To"),
    subject: headerOf("Subject"),
    messageIdHeader: headerOf("Message-ID"),
    inReplyTo: headerOf("In-Reply-To"),
    snippet: text(message["snippet"]) ? clipped(decodeEntities(message["snippet"]), HEADER_BYTES) : undefined,
    body: "",
    bodyTruncated: false,
    bodyFormat: read.bodyFormat,
    attachments: attachments.listed.length > 0 ? attachments.listed : undefined,
    attachmentsOmitted: attachments.omitted > 0 ? attachments.omitted : undefined,
    omittedIds,
  });
  if (!("text" in read)) return finish({ ...projected, body: read.body, bodyTruncated: read.bodyTruncated });
  // Cap by the caller's characters, then by bytes: cut, measure the finished
  // result, and cut again by exactly what it is over, until it fits. Every
  // field is counted as sent — `false` is a byte longer than `true` — so a
  // body at the exact boundary is not a byte over.
  const byCharacters = capped(read.text, maxBodyChars);
  const build = (body: string) =>
    finish({ ...projected, body, bodyTruncated: byCharacters.bodyTruncated || body !== byCharacters.body });
  let body = byCharacters.body;
  let result = build(body);
  for (let round = 0; round < 8; round += 1) {
    const over = jsonBytes(result) - budget;
    if (over <= 0) return result;
    const target = Math.max(2, jsonBytes(body) - over);
    const shorter = clampText(byCharacters.body, target, resultLimitMarker);
    if (shorter === body) break;
    body = shorter;
    result = build(body);
  }
  // Nothing left to cut: the metadata alone is past the budget, and the
  // tool's final size check refuses it rather than sending it.
  return result;
}


// --- Cursors -------------------------------------------------------------------------

/**
 * A page cursor is bound to the call that issued it: its tool and the
 * arguments that shape the result, as a digest. Handed to another tool,
 * thread, query, or page size it is refused, never reinterpreted.
 *
 * Gmail pages its own lists (threads, drafts) with page tokens, which ride
 * inside. Connecta pages a thread's messages and the label list itself, and
 * resumes those by identity rather than position: the cursor carries how many
 * items came before and a fingerprint of their ids, in order. A message or
 * label added or removed before that point changes the fingerprint, and the
 * call answers `conflict` rather than repeating or skipping one; items added
 * after it page on normally. Every page returns at least one item, so paging
 * always ends.
 */
interface CursorClaims {
  v: 1;
  /** The tool that issued it. */
  t: string;
  /** Digest of the arguments that shaped the result. */
  c: string;
  /** Items already returned, and the fingerprint of their ids in order. */
  n?: number;
  f?: string;
  /** Gmail's own page token. */
  p?: string;
}

/** Longest cursor this connection issues; the schemas accept no longer. */
const MAX_CURSOR_LENGTH = 2048;

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The digest naming one call: its tool and the arguments that shape its pages. */
function callKey(tool: string, shape: Record<string, unknown>): Promise<string> {
  return digest(JSON.stringify([tool, shape]));
}

function encodeCursor(claims: CursorClaims): string {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The claims of a cursor this call may resume, or a refusal saying why not. */
function openCursor(cursor: unknown, tool: string, call: string): CursorClaims | undefined {
  if (cursor === undefined) return undefined;
  let claims: CursorClaims | undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlBytes(String(cursor)))) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as CursorClaims).v === 1) claims = parsed as CursorClaims;
  } catch {
    claims = undefined;
  }
  if (!claims || typeof claims.t !== "string" || typeof claims.c !== "string") {
    throw new ConnectorCallError(
      "invalid_args",
      "That is not a cursor this connection issued. Start again without one.",
    );
  }
  if (claims.t !== tool || claims.c !== call) {
    throw new ConnectorCallError(
      "invalid_args",
      "That cursor came from a different call — another tool, thread, query, or page size. Pass the cursor this same call returned, or start again without one.",
    );
  }
  return claims;
}

/** Where to resume in `ids`, checked against what the earlier pages saw. */
async function resumeAt(ids: readonly string[], claims: CursorClaims | undefined, what: string): Promise<number> {
  if (!claims) return 0;
  const seen = claims.n;
  if (
    typeof seen !== "number" ||
    !Number.isInteger(seen) ||
    seen < 1 ||
    seen > ids.length ||
    claims.f !== (await digest(JSON.stringify(ids.slice(0, seen))))
  ) {
    throw new ConnectorCallError(
      "conflict",
      `The ${what} changed since the previous page: an item was added or removed before where that page ended. Read it again from the start, without a cursor.`,
    );
  }
  return seen;
}

async function cursorAfter(
  ids: readonly string[],
  seen: number,
  tool: string,
  call: string,
): Promise<string> {
  return encodeCursor({ v: 1, t: tool, c: call, n: seen, f: await digest(JSON.stringify(ids.slice(0, seen))) });
}

/** A page object whose cursor is as long as any this connection issues. */
const RESERVED_PAGE = { hasMore: true, nextCursor: "x".repeat(MAX_CURSOR_LENGTH) };

function resultLimitMarker(dropped: number): string {
  return `\n[… ${dropped} more characters truncated at connecta's ${RESULT_BUDGET_BYTES / 1024} KiB per-result limit; read the rest in Gmail]`;
}

/**
 * Every Gmail result's last check: its whole serialized size, wrapper and
 * all, against the budget. The bounds above make a refusal here a
 * should-not-happen; it exists so nothing oversized is ever handed on.
 */
function deliverable(tool: string, result: unknown): unknown {
  const size = jsonBytes(result);
  if (size > RESULT_BUDGET_BYTES) {
    throw new ConnectorCallError(
      "connector_call_failed",
      `Gmail's answer to ${tool} is ${size} bytes even after cutting, past connecta's ${RESULT_BUDGET_BYTES / 1024} KiB result limit. Open it in Gmail.`,
      { retryable: false },
    );
  }
  return result;
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
    ...ids({ id: [thread["id"]] }),
    subject: clipped(header(first, "Subject"), FIELD_BYTES),
    from: clipped(header(first, "From"), FIELD_BYTES),
    lastFrom: messages.length > 1 ? clipped(header(last, "From"), FIELD_BYTES) : undefined,
    messageCount: messages.length,
    lastMessageAt: isoFromMillis(latest),
    unread: labels.has("UNREAD"),
    ...labelsOf([...labels]),
    snippet: snippet ? clipped(decodeEntities(snippet), FIELD_BYTES) : undefined,
  });
}

function projectDraftSummary(value: unknown): JsonRecord {
  const draft = asRecord(value);
  const message = asRecord(draft["message"]);
  const payload = asRecord(message["payload"]);
  return compact({
    ...ids({ draftId: [draft["id"]], messageId: [message["id"]], threadId: [message["threadId"]] }),
    subject: clipped(header(payload, "Subject"), FIELD_BYTES),
    to: clipped(header(payload, "To"), FIELD_BYTES),
    updatedAt: isoFromMillis(message["internalDate"]),
    snippet: text(message["snippet"]) ? clipped(decodeEntities(message["snippet"]), FIELD_BYTES) : undefined,
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
  const display = named?.[1]?.trim() ?? "";
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(display);
  const name = (quoted ? quoted[1]!.replace(/\\(.)/g, "$1") : display).trim();
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

/**
 * Split an address header into its mailboxes, as RFC 5322 reads it: commas
 * inside a quoted display name, an angle address, or a comment do not
 * separate, comments are dropped, and a group (`Team: a@x, b@y;`) contributes
 * its members. Each mailbox is then checked; a header that does not parse is
 * refused rather than guessed at, because a wrong split sends mail to the
 * wrong people.
 */
function addressEntries(field: string, value: string | undefined): string[] {
  if (!value) return [];
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let angle = 0;
  let comment = 0;
  let group = false;
  const flush = () => {
    const entry = current.replace(/\s+/g, " ").trim();
    if (entry) entries.push(entry);
    current = "";
  };
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (quoted) {
      if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      current += character;
    } else if (comment > 0) {
      if (character === "(") comment += 1;
      else if (character === ")") comment -= 1;
    } else if (character === '"') {
      quoted = true;
      current += character;
    } else if (character === "(") {
      comment = 1;
    } else if (character === "<") {
      angle += 1;
      current += character;
    } else if (character === ">") {
      angle -= 1;
      current += character;
    } else if (angle === 0 && character === ":" && !group) {
      // A group's display name names nobody; its members follow.
      group = true;
      current = "";
    } else if (angle === 0 && character === ";" && group) {
      group = false;
      flush();
    } else if (angle === 0 && character === ",") {
      flush();
    } else {
      current += character;
    }
    if (angle < 0 || angle > 1) break;
  }
  if (quoted || escaped || angle !== 0 || comment !== 0 || group) {
    throw new ConnectorCallError("invalid_args", `${field} is not a well-formed address list.`);
  }
  flush();
  // Validate each one now, with this field's name, before anything is built.
  for (const entry of entries) formatAddress(field, entry);
  return entries;
}

interface Composition {
  /** Only ever the draft's own existing sender, kept on update. */
  from: readonly string[];
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  replyTo: readonly string[];
  subject: string | undefined;
  body: string;
  htmlBody: string | undefined;
  inReplyTo: string | undefined;
  references: string | undefined;
}

/**
 * One RFC 5322 message, base64url-encoded as Gmail's `raw` field wants it.
 * `Date` and `Message-ID` are Gmail's to set, and so is `From` on a new draft:
 * Gmail fills it with the mailbox's own address. An update keeps the `From`
 * the draft already had — a send-as alias the user chose in Gmail — and no
 * argument can set one, so an agent cannot forge a sender.
 */
function buildRawMessage(message: Composition): string {
  const lines: string[] = [];
  for (const [name, list] of [
    ["From", message.from],
    ["To", message.to],
    ["Cc", message.cc],
    ["Bcc", message.bcc],
    ["Reply-To", message.replyTo],
  ] as const) {
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
  recipients?: () => string[];
}

/** What update_draft keeps from the draft it replaces, unless restated. */
interface Kept extends Threading {
  from?: string[];
  to?: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string[];
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
  const replyTo = header(payload, "Reply-To");
  return {
    threadId: text(message["threadId"]),
    inReplyTo: id,
    references: chain.length > 0 ? chain.join("\r\n ") : undefined,
    subject: subject === undefined ? undefined : /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    // Parsed only when the caller did not name recipients, so a sender header
    // this connection cannot read never blocks a reply addressed explicitly.
    recipients: () =>
      addressEntries(
        `The replied-to message's ${replyTo ? "Reply-To" : "From"} (pass to explicitly)`,
        oneLine(replyTo ?? header(payload, "From")),
      ),
  };
}

/** A header value read back from Gmail, unfolded before it is written again. */
function oneLine(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n]+\s*/g, " ").trim();
}

/**
 * A draft's id, its message id, and the thread Gmail placed it in. Gmail
 * answered 2xx, so the draft was saved whatever its answer looks like: an id
 * it sent that cannot be returned, or none at all, still reads as saved —
 * with `draftId` absent, `omittedIds` or `note` saying why, and where to find
 * it — never as a failure that invites saving it again.
 */
function projectSavedDraft(value: unknown): JsonRecord {
  const draft = asRecord(value);
  const message = asRecord(draft["message"]);
  const saved = ids({ draftId: [draft["id"]], messageId: [message["id"]], threadId: [message["threadId"]] });
  return compact({
    ...saved,
    saved: true,
    sent: false,
    note:
      saved["draftId"] === undefined
        ? "Gmail saved the draft but returned no id this connection can carry. Find it with list_drafts before changing it; do not create it again."
        : undefined,
  });
}

function addressList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/** The MIME types update_draft can rebuild: text, in any multipart shape. */
const REBUILDABLE = new Set(["text/plain", "text/html", "multipart/alternative", "multipart/mixed"]);

/**
 * What in an existing draft update_draft could not carry over, by name.
 * Gmail's update replaces the whole message, so anything the rebuilt message
 * would not contain — an attachment, an inline image, a forwarded message, a
 * calendar invitation — would be deleted for good. Such a draft is refused
 * instead.
 */
function unrebuildable(payload: JsonRecord): string[] {
  const found: string[] = [];
  const visit = (part: JsonRecord, depth: number) => {
    const mime = mimeOf(part);
    if (isAttachment(part) || header(part, "Content-ID") || (mime && !REBUILDABLE.has(mime))) {
      found.push(text(part["filename"]) ?? (mime || "an unnamed part"));
      return;
    }
    const children = asArray(part["parts"]);
    // Past the depth this inspects, what lies below is unknown, and unknown
    // content is content the update could delete: refuse rather than assume.
    if (depth >= MAX_PART_DEPTH && children.length > 0) {
      found.push(`parts nested more than ${MAX_PART_DEPTH} levels deep`);
      return;
    }
    for (const child of children) visit(asRecord(child), depth + 1);
  };
  visit(payload, 0);
  return found;
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
  maxLength: MAX_CURSOR_LENGTH,
  pattern: "^[A-Za-z0-9_-]+$",
  description: "Opaque page.nextCursor from the previous page of this same call; another call's cursor is refused. Pass it back unchanged.",
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
    description: `Characters of body text kept per message, 0 to ${MAX_BODY_CHARS}; defaults to ${fallback}. Longer bodies end with a truncation marker, as does any body past connecta's ${RESULT_BUDGET_BYTES / 1024} KiB result limit.`,
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

/** Fields Gmail sent an id for that was too long to return; see `ids()`. */
const OMITTED_IDS_SCHEMA: JsonSchema = { type: "array", items: { type: "string" } };

const ATTACHMENT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    filename: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer" },
    attachmentId: { type: "string" },
    omittedIds: OMITTED_IDS_SCHEMA,
  },
};

const MESSAGE_PROPERTIES: Record<string, JsonSchema> = {
  id: { type: "string" },
  threadId: { type: "string" },
  labelIds: { type: "array", items: { type: "string" } },
  labelIdsOmitted: { type: "integer" },
  omittedIds: OMITTED_IDS_SCHEMA,
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
  bodyFormat: { type: "string", enum: ["text", "html", "none", "unavailable"] },
  attachments: { type: "array", items: ATTACHMENT_SCHEMA },
  attachmentsOmitted: { type: "integer" },
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
    saved: { type: "boolean", const: true },
    sent: { type: "boolean", const: false },
    omittedIds: OMITTED_IDS_SCHEMA,
    note: { type: "string" },
  },
  required: ["saved", "sent"],
};

// --- Tools ------------------------------------------------------------------------

function tools(client: GoogleWorkspaceClient): ApiTool[] {
  const readOnly = { readOnlyHint: true } as const;
  const bodyChars = (args: JsonRecord, fallback: number): number =>
    typeof args["maxBodyChars"] === "number" ? args["maxBodyChars"] : fallback;
  // Gmail's own page token, carried inside a cursor bound to this call.
  const gmailPage = (listing: JsonRecord, tool: string, call: string) => {
    const token = text(listing["nextPageToken"]);
    if (token === undefined) return { hasMore: false, nextCursor: null };
    const cursor = encodeCursor({ v: 1, t: tool, c: call, p: token });
    if (cursor.length > MAX_CURSOR_LENGTH) {
      throw new ConnectorCallError(
        "connector_call_failed",
        "Gmail answered with a page token too long to carry in a cursor; narrow the query to fit one page.",
        { retryable: false },
      );
    }
    return { hasMore: true, nextCursor: cursor };
  };

  const compose = async (
    args: JsonRecord,
    ctx: ConnectorContext,
    kept: Kept,
  ) => {
    const reply = args["replyToMessageId"]
      ? await replyThreading(client, String(args["replyToMessageId"]), ctx)
      : kept;
    // What the caller states wins; then what the draft already had; then
    // what a reply defaults to. A new draft has nothing kept.
    const raw = buildRawMessage({
      from: kept.from ?? [],
      to: addressList(args["to"]) ?? (kept.to?.length ? kept.to : reply.recipients?.()) ?? [],
      cc: addressList(args["cc"]) ?? kept.cc ?? [],
      bcc: addressList(args["bcc"]) ?? kept.bcc ?? [],
      replyTo: kept.replyTo ?? [],
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
                labelIdsOmitted: { type: "integer" },
                omittedIds: OMITTED_IDS_SCHEMA,
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
        const limit = args["limit"] ?? DEFAULT_PAGE_SIZE;
        const call = await callKey("search_threads", {
          query: args["query"] ?? null,
          includeSpamTrash: args["includeSpamTrash"] === true,
          limit,
        });
        const claims = openCursor(args["cursor"], "search_threads", call);
        const listing = asRecord(
          await client.json(
            {
              method: "GET",
              path: "/threads",
              query: {
                q: args["query"],
                includeSpamTrash: args["includeSpamTrash"],
                maxResults: limit,
                pageToken: claims?.p,
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
          page: gmailPage(listing, "search_threads", call),
        });
      },
    },
    {
      name: "get_thread",
      description:
        "Get a Gmail thread's messages, oldest first, with headers, plain-text bodies capped by maxBodyChars, and attachment names. A long thread pages by cursor.",
      annotations: readOnly,
      inputSchema: input(
        {
          threadId: idProperty("Thread id from search_threads or a message's threadId."),
          maxBodyChars: bodyCharsProperty(DEFAULT_THREAD_BODY_CHARS),
          cursor: {
            ...CURSOR_PROPERTY,
            description: `Opaque page.nextCursor from this thread's previous page, same maxBodyChars. A page ends before ${RESULT_BUDGET_BYTES / 1024} KiB; a thread changed before that point answers conflict.`,
          },
        },
        ["threadId"],
      ),
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          messageCount: { type: "integer" },
          messages: { type: "array", items: MESSAGE_SCHEMA },
          page: PAGE_SCHEMA,
        },
        required: ["id", "messages", "page"],
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
        const call = await callKey("get_thread", { threadId: args["threadId"], maxBodyChars: max });
        const claims = openCursor(args["cursor"], "get_thread", call);
        const all = asArray(thread["messages"]);
        const ids = all.map((message) => String(asRecord(message)["id"] ?? ""));
        const start = await resumeAt(ids, claims, "thread");
        // The whole result is budgeted: the wrapper (with the longest cursor
        // this connection issues) first, then messages and their separators
        // until the next would not fit. A message alone is projected to fit
        // beside the wrapper, so a page holds at least one and paging ends.
        const threadId = idOf(thread["id"]) ?? args["threadId"];
        let bytes = jsonBytes({ id: threadId, messageCount: all.length, messages: [], page: RESERVED_PAGE });
        const room = RESULT_BUDGET_BYTES - bytes;
        const messages: JsonRecord[] = [];
        let next = start;
        while (next < all.length) {
          const projected = await projectMessage(client, ctx, all[next], max, room);
          const size = jsonBytes(projected) + (messages.length > 0 ? 1 : 0);
          if (messages.length > 0 && bytes + size > RESULT_BUDGET_BYTES) break;
          messages.push(projected);
          bytes += size;
          next += 1;
        }
        const hasMore = next < all.length;
        return {
          id: threadId,
          messageCount: all.length,
          messages,
          page: { hasMore, nextCursor: hasMore ? await cursorAfter(ids, next, "get_thread", call) : null },
        };
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
            description: "Return Gmail's untouched message resource (every header, base64url part bodies) instead of the projection. Refused past connecta's 192 KiB result limit.",
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
        if (args["raw"] !== true) {
          return await projectMessage(client, ctx, message, bodyChars(args, DEFAULT_MESSAGE_BODY_CHARS));
        }
        // Untouched means uncuttable: a raw resource past the result budget
        // could not reach a program, so it is refused rather than half-sent.
        const size = jsonBytes(message);
        if (size > RESULT_BUDGET_BYTES) {
          throw new ConnectorCallError(
            "invalid_args",
            `This message's untouched resource is ${size} bytes, past connecta's ${RESULT_BUDGET_BYTES / 1024} KiB result limit. Read it without raw; the projection caps its body and lists its attachments.`,
          );
        }
        return message;
      },
    },
    {
      name: "list_labels",
      description:
        "List the user's Gmail labels, system and user-created, with the ids messages carry; no message counts. Search by name with label: in search_threads.",
      annotations: readOnly,
      inputSchema: input(
        {
          cursor: {
            ...CURSOR_PROPERTY,
            description: "Opaque page.nextCursor from the previous page. Gmail returns every label at once; connecta pages them so thousands still fit, and answers conflict if the list changed.",
          },
        },
        [],
      ),
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
          labelsOmitted: { type: "integer" },
          page: PAGE_SCHEMA,
        },
        required: ["labels", "page"],
      },
      handler: async (args, ctx) => {
        const listing = asRecord(await client.json({ method: "GET", path: "/labels" }, ctx));
        const call = await callKey("list_labels", {});
        const claims = openCursor(args["cursor"], "list_labels", call);
        const all = asArray(listing["labels"]);
        const ids = all.map((label) => String(asRecord(label)["id"] ?? ""));
        const start = await resumeAt(ids, claims, "label list");
        // A mailbox may hold 10,000 labels; Gmail sends them in one answer
        // with no paging of its own, so connecta pages them, budgeting the
        // whole result: wrapper and longest cursor first, then rows.
        const labels: JsonRecord[] = [];
        // A label whose id is too long to use is left out and counted, never
        // returned with a cut id that would name nothing.
        let omitted = 0;
        let bytes = jsonBytes({ labels: [], labelsOmitted: all.length, page: RESERVED_PAGE });
        let next = start;
        while (next < all.length) {
          const label = asRecord(all[next]);
          const id = idOf(label["id"], LABEL_ID_BYTES);
          if (id === undefined) {
            omitted += 1;
            next += 1;
            continue;
          }
          const row = compact({
            id,
            name: clipped(text(label["name"]), FIELD_BYTES),
            type: label["type"] === "system" ? "system" : label["type"] === "user" ? "user" : undefined,
          });
          const size = jsonBytes(row) + (labels.length > 0 ? 1 : 0);
          if (labels.length > 0 && bytes + size > RESULT_BUDGET_BYTES) break;
          labels.push(row);
          bytes += size;
          next += 1;
        }
        const hasMore = next < all.length;
        return compact({
          labels,
          labelsOmitted: omitted > 0 ? omitted : undefined,
          page: { hasMore, nextCursor: hasMore ? await cursorAfter(ids, next, "list_labels", call) : null },
        });
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
                omittedIds: OMITTED_IDS_SCHEMA,
              },
            },
          },
          page: PAGE_SCHEMA,
        },
        required: ["drafts", "page"],
      },
      handler: async (args, ctx) => {
        const limit = args["limit"] ?? DEFAULT_PAGE_SIZE;
        const call = await callKey("list_drafts", { query: args["query"] ?? null, limit });
        const claims = openCursor(args["cursor"], "list_drafts", call);
        const listing = asRecord(
          await client.json(
            {
              method: "GET",
              path: "/drafts",
              query: {
                q: args["query"],
                maxResults: limit,
                pageToken: claims?.p,
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
        return { drafts: drafts.filter((draft) => draft !== undefined), page: gmailPage(listing, "list_drafts", call) };
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
        // The draft was read by the id the caller passed, so that is its id
        // whatever Gmail echoed back.
        const draftId = idOf(draft["id"]) ?? args["draftId"];
        // A draft's message id changes on every update; the draft id does not.
        // The body is fitted against this finished shape, wrapper and all.
        return await projectMessage(
          client,
          ctx,
          draft["message"],
          bodyChars(args, DEFAULT_MESSAGE_BODY_CHARS),
          RESULT_BUDGET_BYTES,
          // Omissions name the public field: here the message's `id` is
          // returned as `messageId`.
          ({ id, omittedIds, ...message }) =>
            compact({
              draftId,
              messageId: id,
              ...message,
              omittedIds: Array.isArray(omittedIds)
                ? omittedIds.map((name: string) => (name === "id" ? "messageId" : name))
                : undefined,
            }),
        );
      },
    },
    {
      name: "create_draft",
      description:
        "Create a Gmail draft, optionally as a reply in an existing thread. It is saved, never sent: the user reviews and sends it in Gmail.",
      // Additive: a new draft changes nothing that existed. Not read-only, so
      // program calls require a trusted pool; other writes use
      // call_destructive_tool. The host controls approval.
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
        "Replace a Gmail draft's body, keeping its sender, recipients, subject, Reply-To, and thread unless restated. Refuses a draft with attachments. Never sends it.",
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
        // Read the whole draft before replacing it: Gmail's update takes a
        // whole message, so whatever the rebuilt one leaves out is deleted.
        // Kept unless restated: From, To, Cc, Bcc, Reply-To, Subject, the
        // thread, In-Reply-To, and References. Any other header is not.
        const existing = asRecord(
          await client.json({ method: "GET", path: draftPath, query: { format: "full" } }, ctx),
        );
        const message = asRecord(existing["message"]);
        const payload = asRecord(message["payload"]);
        const lost = unrebuildable(payload);
        if (lost.length > 0) {
          throw new ConnectorCallError(
            "invalid_args",
            `This draft carries content update_draft cannot rebuild (${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}), and Gmail's update replaces the whole message, so it would be deleted. Nothing was changed. Edit this draft in Gmail, or write a new one with create_draft.`,
          );
        }
        const keep = (name: string, argument: string) =>
          args[argument] === undefined
            ? addressEntries(`The draft's ${name} (pass ${argument} explicitly)`, oneLine(header(payload, name)))
            : undefined;
        const references = messageIds(header(payload, "References"));
        const kept: Kept = {
          threadId: text(message["threadId"]),
          inReplyTo: messageIds(header(payload, "In-Reply-To"))[0],
          references: references.length > 0 ? references.join("\r\n ") : undefined,
          subject: oneLine(header(payload, "Subject")),
          from: addressEntries("The draft's From", oneLine(header(payload, "From"))),
          replyTo: addressEntries("The draft's Reply-To", oneLine(header(payload, "Reply-To"))),
          ...defined({ to: keep("To", "to"), cc: keep("Cc", "cc"), bcc: keep("Bcc", "bcc") }),
        };
        const draft = await client.json(
          { method: "PUT", path: draftPath, body: await compose(args, ctx, kept) },
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
  return `${skill.fragments.guide_0}${purpose}${skill.fragments.guide_1}${extra ? `\n## ${skill.instructionsHeading}\n\n${extra}\n` : ""}`;
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
 * 6. Configure inbound auth: a `subject` function is never asked about an
 *    open deployment's anonymous requests, which fail `auth_required`.
 *    Then give the deployment the key as a secret and map callers to mailboxes:
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
 * approves through call_destructive_tool or a trusted program.
 */
export const gmail = asProviderFactory<GmailOptions>({
  name: "gmail",
  title: "Gmail",
  kind: "api",
  readme: "Gmail",
  bundle: {"baselineGzip":27085,"maxGzip":87085,"note":"./providers/gmail starts at 27,085 B gzip (#678): a hand-written api() surface over the guarded transport plus the shared Google Workspace delegation layer — Web Crypto RS256 signing, an in-memory token cache, result-size budgeting, bound cursors, and request-outcome tracking, with no OAuth client and no MCP SDK. The other Workspace products share that layer and should land in the same class. The cap uses the existing baseline + 60,000 B policy."},
  skill,
  options: GOOGLE_WORKSPACE_OPTIONS,
  create: gmailConnector,
});

function gmailConnector(id: string, options: GmailOptions): Connector {
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
    // Every tool's result passes the whole-size postcondition on its way out.
    tools: tools(client).map((tool) => ({
      ...tool,
      handler: async (args: unknown, ctx: ConnectorContext) => deliverable(tool.name, await tool.handler(args, ctx)),
    })),
  });
}
